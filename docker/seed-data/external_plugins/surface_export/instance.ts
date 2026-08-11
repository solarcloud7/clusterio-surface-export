import fs from "fs";
import { BaseInstancePlugin } from "@clusterio/host";
import type { Instance } from "@clusterio/host";
import { wait } from "@clusterio/lib";
import type { ExportData, ExportResult, ImportResult, PendingTransfer } from "./messages";
import * as messages from "./messages";
import { getErrorMessage, coercePlatformIndex, isBenignUnlockError, EXPORT_POLL_TIMEOUT_MS, EXPORT_POLL_INTERVAL_MS, makeCanonicalTransferId } from "./helpers";
import { LuaInterface } from "./lib/lua-interface";
import { parseSourceTransferLockStateJson } from "./lib/source-lock-state";

type PermissiveLink = {
	handle(messageClass: unknown, handler: (...args: never[]) => unknown): void;
	sendTo(dst: "controller", message: unknown): Promise<messages.SimpleResponse & { transferId?: string; safeToUnlockSource?: boolean }>;
};

export class InstancePlugin extends BaseInstancePlugin {
	private get i(): Instance { return this.instance; }
	private get link(): PermissiveLink { return this.instance as unknown as PermissiveLink; }
	private cfg<T = unknown>(key: string): T {
		return (this.instance.config as { get(k: string): unknown }).get(key) as T;
	}
	private controllerManagedTransferExports: Set<string> = new Set();
	private pendingTransfer: PendingTransfer | null = null;
	private lua!: LuaInterface;

	normalizeRconScalarResult(value: unknown) {
		const text = String(value ?? "");
		const lines = text
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
		return lines.length ? lines[lines.length - 1] : "";
	}

	isInvalidExportId(exportId: string | null | undefined) {
		if (!exportId) {
			return true;
		}
		const lowered = String(exportId).trim().toLowerCase();
		return lowered.startsWith("export_failed")
			|| lowered === "nil"
			|| lowered.startsWith("error");
	}

	override async init() {
		this.logger.info("Surface Export plugin initializing...");
		this.logger.info(`Instance ID: ${this.i.id}, Name: ${this.i.config.get("instance.name")}`);
		this.validateInstanceConfiguration();
		this.lua = new LuaInterface(this, this.logger);

		this.i.server.handle("surface_export_complete", this.handleExportComplete.bind(this));

		this.i.server.handle("surface_import_file_request", this.handleImportFileRequest.bind(this));

		this.i.server.handle("surface_export_import_complete", this.handleImportCompleteValidation.bind(this));

		this.i.server.handle("surface_platform_state_changed", this.handlePlatformStateChanged.bind(this));

		this.i.server.handle("surface_transfer_request", this.handleTransferRequest.bind(this));

		this.i.server.handle("surface_teleport_roster_request", this.handleTeleportRosterRequest.bind(this));

		this.i.handle(messages.ExportPlatformRequest, this.handleExportPlatformRequest.bind(this));
		this.i.handle(messages.ImportPlatformRequest, this.handleImportPlatformRequest.bind(this));
		this.i.handle(messages.ImportPlatformFromFileRequest, this.handleImportPlatformFromFileRequest.bind(this));
		this.i.handle(messages.DeleteSourcePlatformRequest, this.handleDeleteSourcePlatform.bind(this));
		this.i.handle(messages.UnlockSourcePlatformRequest as never, this.handleUnlockSourcePlatform.bind(this) as never);
		this.i.handle(messages.GetSourceTransferLockStateRequest, this.handleGetSourceTransferLockState.bind(this));
		this.link.handle(messages.TransferStatusUpdate, this.handleTransferStatusUpdate.bind(this));
		this.link.handle(messages.InstanceListPlatformsRequest, this.handleInstanceListPlatformsRequest.bind(this));
		this.link.handle(messages.PushGatewayConfigRequest, this.handlePushGatewayConfig.bind(this));

		this.logger.info("Surface Export plugin initialized");
	}

	override async onStart() {
		this.logger.info("Instance started - Surface Export plugin ready");
		await this.ensureLuaConsoleUnlocked();
		await this.sendConfigurationToLua();
		await this.sendGatewayConfigToLua();
	}

	async sendConfigurationToLua() {
		try {
			const batchSize = this.cfg<number>("surface_export.batch_size");
			const maxConcurrentJobs = this.cfg<number>("surface_export.max_concurrent_jobs");
			const showProgress = this.cfg<boolean>("surface_export.show_progress");
			const debugMode = this.cfg<boolean>("surface_export.debug_mode");
			const maxExportCacheSize = this.cfg<number>("surface_export.max_export_cache_size");

			await this.lua.configure({ batchSize, maxConcurrentJobs, showProgress, debugMode, maxExportCacheSize });
			this.logger.info(`Configuration sent to Lua: batch_size=${batchSize}, max_concurrent_jobs=${maxConcurrentJobs}, show_progress=${showProgress}, debug_mode=${debugMode}, max_export_cache_size=${maxExportCacheSize}`);
		} catch (err: unknown) {
			this.logger.warn(`Failed to send configuration to Lua: ${getErrorMessage(err)}`);
		}
	}


	private async applyGatewaysToLua(
		gateways: messages.ResolvedGateway[],
		activeGatewayNames?: string[],
	): Promise<{ gateways: number }> {
		const keyed: Record<string, { targets: messages.ResolvedGatewayTarget[] }> = {};
		for (const g of gateways || []) {
			keyed[g.gatewayName] = { targets: g.targets || [] };
		}
		return await this.lua.configureGateways(
			JSON.stringify(keyed),
			activeGatewayNames ? JSON.stringify(activeGatewayNames) : undefined,
		);
	}

	async handleTeleportRosterRequest(): Promise<void> {
		try {
			const resp = (await this.link.sendTo(
				"controller",
				new messages.GetInstanceRosterRequest({ instanceId: this.i.id }),
			)) as unknown as { instances?: messages.RosterInstance[] };
			const instances = resp?.instances || [];
			await this.lua.pushTeleportRoster(JSON.stringify({ instances }));
			this.logger.info(`Teleport roster pushed to Lua: ${instances.length} instance(s)`);
		} catch (err: unknown) {
			this.logger.error(`Teleport roster request failed: ${getErrorMessage(err)}`);
		}
	}

	async sendGatewayConfigToLua() {
		for (let attempt = 1; attempt <= 2; attempt++) {
			try {
				const resp = (await this.link.sendTo(
					"controller",
					new messages.GetGatewayConfigRequest({ instanceId: this.i.id }),
				)) as unknown as { gateways?: messages.ResolvedGateway[]; activeGatewayNames?: string[] };
				const applied = await this.applyGatewaysToLua(resp?.gateways || [], resp?.activeGatewayNames);
				this.logger.info(`Gateway config pulled from controller: ${applied.gateways} gateway(s) applied`);
				return;
			} catch (err: unknown) {
				if (attempt === 1) {
					this.logger.warn(`Gateway config pull failed, retrying in 10s: ${getErrorMessage(err)}`);
					await wait(10_000);
				} else {
					this.logger.error(
						`Gateway config pull FAILED after retry — this instance is running NO gateway config: `
						+ getErrorMessage(err));
				}
			}
		}
	}

	async handlePushGatewayConfig(request: { gateways: messages.ResolvedGateway[]; activeGatewayNames?: string[] }) {
		try {
			const applied = await this.applyGatewaysToLua(request.gateways || [], request.activeGatewayNames);
			this.logger.info(`Gateway config applied: ${applied.gateways} gateway(s)`);
			return { success: true };
		} catch (err: unknown) {
			return { success: false, error: getErrorMessage(err) };
		}
	}

	override async onStop() {
		this.logger.info("Instance stopped - Surface Export plugin shutting down");
	}

	async handleExportComplete(data: Record<string, unknown>) {
		const exportId = String(data.export_id || "").trim();
		this.logger.info(`Export complete send_json event received: export_id=${exportId}, platform=${data.platform_name}`);
		this.logger.verbose(`  destination_instance_id=${data.destination_instance_id} (type=${typeof data.destination_instance_id}), job_id=${data.job_id}`);
		this.logger.verbose(`  this.i.id=${this.i.id} (type=${typeof this.i.id})`);
		this.logger.info(`Platform export completed: ${exportId} (${data.platform_name})`);

		if (this.isInvalidExportId(exportId)) {
			this.logger.error(`Export completion send_json payload contained invalid export ID: ${JSON.stringify(data.export_id)}`);
			return;
		}

		try {
			const exportData = await this.getExportData(exportId);

			if (!exportData) {
				this.logger.error(`Failed to retrieve export data for ${exportId}`);
				return;
			}

			const sourcePlatformIndex = Number(data.platform_index);
			await this.i.sendTo("controller", new messages.PlatformExportEvent({
				exportId,
				platformName: String(data.platform_name || ""),
				platformIndex: Number.isInteger(sourcePlatformIndex) ? sourcePlatformIndex : null,
				instanceId: this.i.id,
				exportData: exportData,
				timestamp: Date.now(),
				exportMetrics: data.export_metrics || null,
			}));
			this.logger.info(`Sent platform export ${exportId} to controller`);

			if (data.destination_instance_id) {
				if (this.controllerManagedTransferExports.has(exportId)) {
					this.controllerManagedTransferExports.delete(exportId);
					this.logger.info(`Skipping instance auto-transfer for controller-managed export ${exportId}`);
					return;
				}
				this.logger.info(`Auto-transfer requested: dest_instance_id=${data.destination_instance_id} (type=${typeof data.destination_instance_id})`);
				await this.startControllerTransfer(exportId, Number(data.destination_instance_id), Number(data.platform_index));
				return;
			}

			if (this.pendingTransfer && this.pendingTransfer.job_id === data.job_id) {
				const pendingTargetId = Number(this.pendingTransfer.destination_instance_id);
				if (!Number.isInteger(pendingTargetId) || pendingTargetId <= 0) {
					this.logger.error(`Pending transfer has invalid target instance: ${this.pendingTransfer.destination_instance_id}`);
					this.pendingTransfer = null;
					return;
				}
				this.logger.info(`Transfer export complete, initiating transfer to instance ${this.pendingTransfer.destination_instance_id}`);
				await this.startControllerTransfer(exportId, pendingTargetId, Number(this.pendingTransfer.platform_index));
				this.pendingTransfer = null;
			}
		} catch (err: unknown) {
			this.logger.error(`Error handling export completion: ${getErrorMessage(err)}`);
		}
	}

	private async startControllerTransfer(exportId: string, targetInstanceId: number, platformIndex: number) {
		const canonicalExportId = makeCanonicalTransferId(this.i.id, exportId);
		this.logger.info(`  Sending TransferPlatformRequest to controller: exportId=${canonicalExportId}, targetInstanceId=${targetInstanceId}`);

		const transferResponse = await this.link.sendTo(
			"controller",
			new messages.TransferPlatformRequest({
				exportId: canonicalExportId,
				targetInstanceId,
				sourceInstanceId: this.i.id,
				sourceExportId: exportId,
			}),
		);

		if (transferResponse.success) {
			this.logger.info(`Transfer initiated: ${transferResponse.transferId}`);
			return;
		}
		this.logger.error(`Transfer failed: ${transferResponse.error}`);


		if (transferResponse.safeToUnlockSource === true) {
			if (Number.isInteger(platformIndex)) {
				const unlockResult = String(await this.lua.unlockPlatform(platformIndex)).trim();
				if (unlockResult.startsWith("SUCCESS")) {
					this.logger.info(`Source platform ${platformIndex} unlocked after refused transfer`);
				} else if (isBenignUnlockError(unlockResult)) {
					this.logger.info(`Source platform ${platformIndex} was already unlocked (${unlockResult})`);
				} else {
					this.logger.error(`Unlock after refused transfer did NOT succeed (${unlockResult}); `
						+ "the source-side TTL remains the backstop");
				}
			} else {
				this.logger.warn("Cannot unlock after failed transfer — no valid platform_index available");
			}
		}

		try {
			await this.lua.printToGame(`[Transfer] ${String(transferResponse.error)}`, "{1, 0.3, 0.3}");
		} catch (printErr: unknown) {
			this.logger.warn(`Could not print the transfer refusal in game: ${getErrorMessage(printErr)}`);
		}
	}

	async handlePlatformStateChanged(data: Record<string, unknown>) {
		try {
			await this.i.sendTo("controller", new messages.PlatformStateChangedEvent({
				instanceId: this.i.id,
				platformName: String(data.platform_name || ""),
				forceName: String(data.force_name || "player"),
			}));
		} catch (err: unknown) {
			this.logger.warn(`Platform state change notification failed: ${getErrorMessage(err)}`);
		}
	}

	async handleTransferRequest(data: Record<string, unknown>) {
		this.logger.info(`Transfer request send_json event received: platform=${data.platform_name}, dest=${data.destination_instance_id} (type=${typeof data.destination_instance_id}), job_id=${data.job_id}`);

		try {
			const platformIndex = Number(data.platform_index);
			const destinationInstanceId = Number(data.destination_instance_id);
			this.pendingTransfer = {
				platform_index: Number.isInteger(platformIndex) ? platformIndex : undefined,
				platform_name: typeof data.platform_name === "string" ? data.platform_name : undefined,
				force_name: typeof data.force_name === "string" ? data.force_name : undefined,
				destination_instance_id: Number.isInteger(destinationInstanceId) ? destinationInstanceId : undefined,
				job_id: typeof data.job_id === "string" || typeof data.job_id === "number" ? data.job_id : undefined,
			};

			this.logger.info(`Transfer queued: will execute after export ${data.job_id} completes`);

		} catch (err: unknown) {
			this.logger.error(`Error handling transfer request: ${getErrorMessage(err)}`);
		}
	}

	async handleImportFileRequest(data: Record<string, unknown>) {
		this.logger.info(`Received import file request: ${data.filename}`);

		try {
			const result = await this.importPlatformFromFile(
				String(data.filename || ""),
				typeof data.platform_name === "string" ? data.platform_name : null,
				typeof data.force_name === "string" ? data.force_name : "player",
			);

			if (result.success) {
				this.logger.info("Import request completed successfully");
			} else {
				this.logger.error(`Import request failed: ${result.error}`);
			}
		} catch (err: unknown) {
			this.logger.error(`Error handling import file request: ${getErrorMessage(err)}`);
		}
	}

	async exportPlatform(platformIndex: number, forceName = "player", targetInstanceId: number | null = null): Promise<ExportResult> {
		const resolvedTargetId = Number(targetInstanceId);
		const hasTargetInstance = Number.isInteger(resolvedTargetId) && resolvedTargetId > 0;
		const targetArg = hasTargetInstance ? String(resolvedTargetId) : "nil";
		this.logger.info(`Exporting platform index ${platformIndex} for force "${forceName}" (targetInstanceId=${targetArg})`);

		try {
			const rconResult = await this.lua.exportPlatform(platformIndex, forceName, targetArg);
			this.logger.info(`Export RCON result: ${rconResult}`);
			const exportResult = this.normalizeRconScalarResult(rconResult);
			if (!exportResult || exportResult.toLowerCase() === "nil") {
				return { success: false, error: "Export failed - no export_id returned" };
			}
			if (exportResult.toUpperCase().startsWith("EXPORT_FAILED")) {
				const parts = exportResult.split(":");
				const reason = parts.length > 1 ? parts.slice(1).join(":").trim() : "";
				return { success: false, error: reason ? `Export failed - ${reason}` : "Export failed" };
			}

			const exportId = exportResult.trim();
			if (this.isInvalidExportId(exportId)) {
				return { success: false, error: "Export failed - invalid export_id returned" };
			}
			this.logger.info(`Export completed with ID: ${exportId}`);

			return { success: true, exportId };
		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Export failed: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	async waitForExportData(exportId: string, timeoutMs = EXPORT_POLL_TIMEOUT_MS, intervalMs = EXPORT_POLL_INTERVAL_MS) {
		const deadline = Date.now() + timeoutMs;
		let lastAttempt: ExportData | null = null;
		while (Date.now() < deadline) {
			lastAttempt = await this.getExportData(exportId, { logOnMissing: false });
			if (lastAttempt) {
				return lastAttempt;
			}
			await wait(intervalMs);
		}
		this.logger.error(`Timed out waiting for export data for ${exportId} after ${timeoutMs}ms`);
		try {
			const availableExports = await this.listExports();
			this.logger.error(`Available exports in Lua: ${JSON.stringify(availableExports)}`);
		} catch (listErr: unknown) {
			this.logger.error(`Failed to list available exports: ${getErrorMessage(listErr)}`);
		}
		return null;
	}

	async getExportData(exportId: string, options: { logOnMissing?: boolean } = {}): Promise<ExportData | null> {
		try {
			const { logOnMissing = true } = options;
			const safeExportId = String(exportId || "").trim();
			if (this.isInvalidExportId(safeExportId)) {
				this.logger.warn(`Skipping getExportData for invalid export ID: ${JSON.stringify(exportId)}`);
				return null;
			}
			const exportData = await this.lua.getExportJson(safeExportId);
			if (!exportData) {
				if (logOnMissing) {
					this.logger.error(`Export data not found for ${safeExportId} - Lua returned empty/null`);
					try {
						const availableExports = await this.listExports();
						this.logger.error(`Available exports in Lua: ${JSON.stringify(availableExports)}`);
					} catch (listErr: unknown) {
						this.logger.error(`Failed to list available exports: ${getErrorMessage(listErr)}`);
					}
				}
				return null;
			}

			if (exportData.compressed && exportData.payload) {
				const compressedSize = ((exportData.payload as string).length / 1024).toFixed(1);
				this.logger.info(`Retrieved compressed export: ${compressedSize} KB (${exportData.compression})`);
			} else {
				const jsonSize = (JSON.stringify(exportData).length / 1024).toFixed(1);
				this.logger.info(`Retrieved uncompressed export: ${jsonSize} KB`);
			}

			return exportData as ExportData;
		} catch (err: unknown) {
			this.logger.error(`Get export data failed: ${getErrorMessage(err)}`);
			return null;
		}
	}

	async listExports(): Promise<string[]> {
		try {
			return await this.lua.listExportsJson();
		} catch (err: unknown) {
			this.logger.error(`List exports failed: ${getErrorMessage(err)}`);
			return [];
		}
	}

	async listPlatforms(forceName = "player") {
		try {
			const parsed = await this.lua.listPlatformsJson(forceName || "player");
			return parsed.map((platform: Record<string, unknown>) => ({
				platformIndex: platform.platform_index,
				platformName: platform.platform_name,
				forceName: platform.force_name || forceName || "player",
				surfaceIndex: platform.surface_index ?? null,
				surfaceName: platform.surface_name ?? null,
				entityCount: Number(platform.entity_count || 0),
				isLocked: Boolean(platform.is_locked),
				hasSpaceHub: Boolean(platform.has_space_hub),
				spaceLocation: platform.space_location ?? null,
				currentTarget: platform.current_target ?? null,
				speed: typeof platform.speed === "number" ? platform.speed : 0,
				state: platform.state ?? null,
				departureTick: platform.departure_tick ?? null,
				estimatedDurationTicks: platform.estimated_duration_ticks ?? null,
			}));
		} catch (err: unknown) {
			this.logger.error(`List platforms failed: ${getErrorMessage(err)}`);
			return [];
		}
	}

	async importPlatform(exportData: ExportData, forceName = "player"): Promise<ImportResult> {
		const platformName = exportData.platform_name || `Imported_${Date.now()}`;
		this.logger.info(`Importing platform "${platformName}" for force "${forceName}"`);

		try {
			const jsonData = JSON.stringify(exportData);
			const sizeKB = (jsonData.length / 1024).toFixed(1);

			if (exportData.compressed) {
				this.logger.info(`Import data size: ${sizeKB} KB (compressed with ${exportData.compression})`);
			} else {
				this.logger.info(`Import data size: ${sizeKB} KB (uncompressed)`);
			}

			await this.lua.importPlatformChunked(platformName, forceName, exportData);

			this.logger.info("All chunks sent, import queued for async processing");
			return { success: true };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Import failed: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	async importPlatformFromFile(filename: string, platformName: string | null = null, forceName = "player"): Promise<ImportResult> {
		this.logger.info(`Importing platform from file "${filename}" for force "${forceName}"`);

		try {
			const scriptOutputPath = this.instance.path("script-output", filename);

			this.logger.verbose(`Reading file from: ${scriptOutputPath}`);
			const fileContent = await fs.promises.readFile(scriptOutputPath, "utf8");
			const exportData = JSON.parse(fileContent);

			const sizeKB = (fileContent.length / 1024).toFixed(1);
			this.logger.info(`File loaded: ${sizeKB} KB`);

			const targetPlatformName = platformName || exportData.platform_name || `Imported_${Date.now()}`;

			await this.lua.importPlatformChunked(targetPlatformName, forceName, exportData);

			this.logger.info("Platform import chunks sent successfully");

			return { success: true };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Import from file failed: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	async ensureLuaConsoleUnlocked() {
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			try {
				await this.lua.signalReady();
				if (attempt === 1) {
					continue;
				}
				this.logger.info("Lua console unlocked for Surface Export automation");
				return;
			} catch (err: unknown) {
				this.logger.warn(`RCON handshake attempt ${attempt} failed: ${getErrorMessage(err)}`);
			}
		}
		this.logger.warn("Unable to confirm Lua console unlock; subsequent exports may require a manual command rerun.");
	}

	async handleExportPlatformRequest(request: { platformIndex: number; forceName?: string; targetInstanceId?: number | null }) {
		const result = await this.exportPlatform(request.platformIndex, request.forceName, request.targetInstanceId ?? null);
		const numericTargetInstanceId = Number(request.targetInstanceId);
		if (result?.success && Number.isInteger(numericTargetInstanceId) && numericTargetInstanceId > 0) {
			this.controllerManagedTransferExports.add(result.exportId as string);
		}
		return result;
	}

	async handleImportPlatformRequest(request: { exportData: ExportData; forceName?: string; targetPlanet?: string | null }) {
		const hasTransferId = Boolean(request.exportData && request.exportData._transferId);
		const dataSize = request.exportData ? JSON.stringify(request.exportData).length : 0;
		this.logger.info(`ImportPlatformRequest received: force=${request.forceName}, isTransfer=${hasTransferId}, dataSize=${(dataSize / 1024).toFixed(1)}KB, targetPlanet=${request.targetPlanet ?? "default"}`);
		if (hasTransferId) {
			this.logger.info(`  transfer_id=${request.exportData._transferId}, source_instance=${request.exportData._sourceInstanceId}`);
		}
		if (request.targetPlanet) {
			(request.exportData as Record<string, unknown>)._targetPlanet = request.targetPlanet;
		}
		return await this.importPlatform(request.exportData, request.forceName || "player");
	}

	async handleImportPlatformFromFileRequest(request: { filename: string; platformName?: string | null; forceName?: string }) {
		return await this.importPlatformFromFile(request.filename, request.platformName ?? null, request.forceName || "player");
	}

	async handleInstanceListPlatformsRequest(request: { forceName?: string }) {
		const forceName = request.forceName || "player";
		const platforms = await this.listPlatforms(forceName);
		return {
			instanceId: this.i.id,
			instanceName: this.i.config.get("instance.name"),
			forceName,
			platforms,
		};
	}

	async handleImportCompleteValidation(data: Record<string, unknown>) {
		this.logger.info(`Import completed for ${data.platform_name}, performing validation`);

		const transferId = String(data.transfer_id || "").trim();
		const sourceInstanceId = Number(data.source_instance_id);
		const operationId = data.operation_id ? String(data.operation_id) : null;

		const metrics = data.metrics || null;
		if (metrics) {
			this.logger.info(`Import metrics: ${JSON.stringify(metrics)}`);
		}

		if (!transferId || !Number.isInteger(sourceInstanceId) || sourceInstanceId <= 0) {
			if (operationId) {
				try {
					await this.i.sendTo("controller", new messages.ImportOperationCompleteEvent({
						operationId,
						platformName: String(data.platform_name || "Unknown"),
						instanceId: this.i.id,
						success: true,
						error: null,
						durationTicks: Number.isFinite(Number(data.duration_ticks)) ? Number(data.duration_ticks) : null,
						entityCount: Number.isFinite(Number(data.entity_count)) ? Number(data.entity_count) : null,
						metrics: (metrics as Record<string, unknown> | null) || null,
					}));
					await this.handlePlatformStateChanged({
						platform_name: String(data.platform_name || ""),
						force_name: String(data.force_name || "player"),
					});
				} catch (emitErr: unknown) {
					this.logger.error(`Failed to forward import operation completion for ${operationId}: ${getErrorMessage(emitErr)}`);
				}
				return;
			}
			this.logger.warn(`Import completed but missing transfer metadata, skipping validation. Received keys: ${Object.keys(data).join(", ")}`);
			this.logger.warn(`  transfer_id=${data.transfer_id} (type=${typeof data.transfer_id}), source_instance_id=${data.source_instance_id} (type=${typeof data.source_instance_id})`);
			return;
		}

		try {
			let validation: messages.ValidationResult = {
				itemCountMatch: false,
				fluidCountMatch: false,
				entityCount: Number.isFinite(Number(data.entity_count)) ? Number(data.entity_count) : undefined,
				mismatchDetails: "Validation payload not retrieved",
			};
			const hasValidationPayload = Boolean(data.validation && typeof data.validation === "object" && !Array.isArray(data.validation));
			if (hasValidationPayload) {
				const parsed = data.validation as Partial<messages.ValidationResult>;
				validation = {
					...parsed,
					itemCountMatch: Boolean(parsed.itemCountMatch),
					fluidCountMatch: Boolean(parsed.fluidCountMatch),
				};
			}
			const validationSaysSuccess = validation.itemCountMatch && validation.fluidCountMatch;
			const success = hasValidationPayload
				&& typeof data.success === "boolean"
				&& data.success === true
				&& validationSaysSuccess;

			let normalizedMetrics: Record<string, unknown> | undefined;
			if (metrics && typeof metrics === "object") {
				const src = metrics as Record<string, unknown>;
				normalizedMetrics = Object.fromEntries(
					Object.entries(src).filter(([, v]) => typeof v === "number" && Number.isFinite(v)),
				);
				if (Array.isArray(src.phase_spans)) normalizedMetrics.phase_spans = src.phase_spans;
			}

			await this.i.sendTo("controller", new messages.TransferValidationEvent({
				transferId,
				platformName: String(data.platform_name || "Unknown"),
				sourceInstanceId,
				success,
				validation,
				metrics: normalizedMetrics,
			}));

			this.logger.info(`Validation event sent for transfer ${transferId}: success=${success}`);

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error during validation: ${errMsg}`);

			try {
				await this.i.sendTo("controller", new messages.TransferValidationEvent({
					transferId,
					platformName: String(data.platform_name || "Unknown"),
					sourceInstanceId,
					success: false,
					validation: {
						itemCountMatch: false,
						fluidCountMatch: false,
						mismatchDetails: `Validation error: ${errMsg}`,
					},
				}));
				this.logger.info(`Sent failure validation for transfer ${transferId} due to error`);
				} catch (sendErr: unknown) {
					this.logger.error(`Failed to send failure validation: ${getErrorMessage(sendErr)}`);
			}
		}
	}

	async handleDeleteSourcePlatform(request: { platformIndex: number; platformName: string; forceName?: string; exportId?: string | null }) {
		const platformIndex = coercePlatformIndex(request.platformIndex);
		this.logger.info(`Deleting source platform: index ${platformIndex} ('${request.platformName}', export ${request.exportId ?? "—"})`);

		if (platformIndex === null) {
			const error = `invalid platformIndex: ${String(request.platformIndex)}`;
			this.logger.error(`Refusing source delete — ${error}`);
			return { success: false, error };
		}

		try {
			const result = await this.lua.deleteSourcePlatform(
				platformIndex,
				String(request.platformName || ""),
				String(request.forceName || "player"),
				request.exportId ?? null,
			);

			const trimmedResult = result.trim();
			if (trimmedResult === "SUCCESS") {
				this.logger.info(`Platform ${request.platformName} deleted successfully`);
				return { success: true };
			}
			const error = trimmedResult.replace("ERROR:", "");
			this.logger.error(`Failed to delete platform: ${error}`);
			return { success: false, error };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error deleting platform: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	async handleUnlockSourcePlatform(request: { platformIndex: number; platformName?: string }) {
		const platformIndex = coercePlatformIndex(request.platformIndex);
		this.logger.info(`Unlocking source platform for rollback: index ${platformIndex}`);

		if (platformIndex === null) {
			const error = `invalid platformIndex: ${String(request.platformIndex)}`;
			this.logger.warn(`Cannot unlock — ${error}`);
			return { success: false, error };
		}

		try {
			const result = await this.lua.unlockPlatform(platformIndex, request.platformName);

			if (result.trim() === "SUCCESS") {
				this.logger.info(`Platform index ${platformIndex} unlocked successfully`);
				return { success: true };
			}
			const error = result.trim().replace("ERROR:", "");
			this.logger.warn(`Failed to unlock platform: ${error}`);
			return { success: false, error };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error unlocking platform: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	async handleGetSourceTransferLockState(request: { transferId: string; platformIndex: number; platformName: string; forceName?: string }) {
		const platformIndex = coercePlatformIndex(request.platformIndex);
		if (platformIndex === null) {
			return { state: "identity_mismatch", transferId: request.transferId, error: `invalid platformIndex: ${String(request.platformIndex)}` };
		}
		try {
			const result = await this.lua.getSourceTransferLockState(
				request.transferId,
				platformIndex,
				String(request.platformName || ""),
				String(request.forceName || "player"),
			);
			return parseSourceTransferLockStateJson(result.trim());
		} catch (err: unknown) {
			return { state: "unknown/offline", transferId: request.transferId, error: getErrorMessage(err) };
		}
	}
	async handleTransferStatusUpdate(request: { message: string; color?: string }) {
		this.logger.info(`Transfer status: ${request.message}`);

		try {
			const colorMap: Record<string, string> = {
				green: "{0, 1, 0}",
				yellow: "{1, 1, 0}",
				red: "{1, 0, 0}",
				blue: "{0, 0.5, 1}",
				white: "{1, 1, 1}",
			};

			const colorCode = colorMap[request.color || ""] || "{1, 1, 1}";

			await this.lua.printToGame(String(request.message ?? ""), colorCode);

			return { success: true };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error displaying transfer status: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	validateInstanceConfiguration() {
		const scriptCommandsEnabled = this.i.config.get("factorio.enable_script_commands");
		if (!scriptCommandsEnabled) {
			throw new Error("Surface Export requires factorio.enable_script_commands to be enabled");
		}
		const cacheLimit = this.cfg("surface_export.max_export_cache_size");
		if (typeof cacheLimit !== "number" || cacheLimit < 1) {
			throw new Error("surface_export.max_export_cache_size must be >= 1");
		}
	}
}

