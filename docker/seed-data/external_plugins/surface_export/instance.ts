/**
 * @file instance.ts
 * @description Instance plugin for Surface Export - runs on each Factorio host
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

import fs from "fs";
import path from "path";
import { BaseInstancePlugin } from "@clusterio/host";
import { escapeString } from "@clusterio/lib";
import type { ExportData, ExportResult, ImportResult, PendingTransfer } from "./messages";
import * as messages from "./messages";
import { sendChunkedJson, getErrorMessage, RCON_CHUNK_SIZE, EXPORT_POLL_TIMEOUT_MS, EXPORT_POLL_INTERVAL_MS } from "./helpers";


/**
 * Instance plugin class
 * Runs on each Clusterio host and handles communication with Factorio servers
 */
export class InstancePlugin extends BaseInstancePlugin {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private get i(): any { return this.instance; }
	private controllerManagedTransferExports: Set<string> = new Set();
	private pendingTransfer: PendingTransfer | null = null;

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

	/**
	 * Initialize plugin
	 * Called when plugin is loaded
	 */
	async init() {
		this.logger.info("Surface Export plugin initializing...");
		this.logger.info(`Instance ID: ${this.i.id}, Name: ${this.i.config.get("instance.name")}`);
		this.validateInstanceConfiguration();

		// Listen for platform export completion from Factorio mod
		// The mod sends data via clusterio_api.send_json("surface_export_complete", data)
		this.i.server.handle("surface_export_complete", this.handleExportComplete.bind(this));

		// Listen for import file requests from mod
		// The mod sends data via clusterio_api.send_json("surface_import_file_request", data)
		this.i.server.handle("surface_import_file_request", this.handleImportFileRequest.bind(this));

		// Listen for import completion with validation from mod
		this.i.server.handle("surface_export_import_complete", this.handleImportCompleteValidation.bind(this));

		// Listen for space platform state changes from Factorio mod
		this.i.server.handle("surface_platform_state_changed", this.handlePlatformStateChanged.bind(this));

		// Listen for transfer requests from mod
		this.i.server.handle("surface_transfer_request", this.handleTransferRequest.bind(this));

		// Register message handlers
		this.i.handle(messages.ExportPlatformRequest, this.handleExportPlatformRequest.bind(this));
		this.i.handle(messages.ImportPlatformRequest, this.handleImportPlatformRequest.bind(this));
		this.i.handle(messages.ImportPlatformFromFileRequest, this.handleImportPlatformFromFileRequest.bind(this));
		this.i.handle(messages.DeleteSourcePlatformRequest, this.handleDeleteSourcePlatform.bind(this));
		this.i.handle(messages.UnlockSourcePlatformRequest, this.handleUnlockSourcePlatform.bind(this));
		this.i.handle(messages.TransferStatusUpdate, this.handleTransferStatusUpdate.bind(this));
		this.i.handle(messages.InstanceListPlatformsRequest, this.handleInstanceListPlatformsRequest.bind(this));

		this.logger.info("Surface Export plugin initialized");
	}

	/**
	 * Called when instance starts
	 */
	async onStart() {
		this.logger.info("Instance started - Surface Export plugin ready");
		await this.ensureLuaConsoleUnlocked();
		await this.sendConfigurationToLua();
	}

	/**
	 * Send plugin configuration to Lua
	 */
	async sendConfigurationToLua() {
		try {
			const batchSize = this.i.config.get("surface_export.batch_size");
			const maxConcurrentJobs = this.i.config.get("surface_export.max_concurrent_jobs");
			const showProgress = this.i.config.get("surface_export.show_progress");
			const debugMode = this.i.config.get("surface_export.debug_mode");

			const configScript = `/sc ` +
				`if remote.interfaces["surface_export"] and remote.interfaces["surface_export"]["configure"] then ` +
				`remote.call("surface_export", "configure", {` +
				`batch_size=${batchSize}, ` +
				`max_concurrent_jobs=${maxConcurrentJobs}, ` +
				`show_progress=${showProgress}, ` +
				`debug_mode=${debugMode}` +
				`}) ` +
				`end`;

			await this.i.sendRcon(configScript, true);
			this.logger.info(`Configuration sent to Lua: batch_size=${batchSize}, max_concurrent_jobs=${maxConcurrentJobs}, show_progress=${showProgress}, debug_mode=${debugMode}`);
		} catch (err: unknown) {
			this.logger.warn(`Failed to send configuration to Lua: ${getErrorMessage(err)}`);
		}
	}

	/**
	 * Called when instance stops
	 */
	async onStop() {
		this.logger.info("Instance stopped - Surface Export plugin shutting down");
	}

	/**
	 * Handle export completion event from Factorio mod
	 * @param data - Export data from mod
	 */
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
			// Retrieve full export data from mod
			const exportData = await this.getExportData(exportId);

			if (!exportData) {
				this.logger.error(`Failed to retrieve export data for ${exportId}`);
				return;
			}

			// Send export to controller for storage
			await this.i.sendTo("controller", new messages.PlatformExportEvent({
				exportId,
				platformName: String(data.platform_name || ""),
				instanceId: this.i.id,
				exportData: exportData,
				timestamp: Date.now(),
				exportMetrics: data.export_metrics || null,
			}));
			this.logger.info(`Sent platform export ${exportId} to controller`);

			// Check if auto-transfer was requested (destination_instance_id in send_json payload)
			if (data.destination_instance_id) {
				if (this.controllerManagedTransferExports.has(exportId)) {
					this.controllerManagedTransferExports.delete(exportId);
					this.logger.info(`Skipping instance auto-transfer for controller-managed export ${exportId}`);
					return;
				}
				this.logger.info(`Auto-transfer requested: dest_instance_id=${data.destination_instance_id} (type=${typeof data.destination_instance_id})`);
				this.logger.info(`  Sending TransferPlatformRequest to controller: exportId=${exportId}, targetInstanceId=${data.destination_instance_id}`);

				// Send transfer request to controller
				const transferResponse = await this.i.sendTo("controller",
					new messages.TransferPlatformRequest({
						exportId,
						targetInstanceId: Number(data.destination_instance_id),
					}) as unknown as messages.SimpleResponse & { transferId?: string }
				);

				if (transferResponse.success) {
					this.logger.info(`Transfer initiated: ${transferResponse.transferId}`);
				} else {
					this.logger.error(`Transfer failed: ${transferResponse.error}`);
				}
				return;
			}

			// Check if this was part of a pending transfer request (legacy path)
			if (this.pendingTransfer && this.pendingTransfer.job_id === data.job_id) {
				const pendingTargetId = Number(this.pendingTransfer.destination_instance_id);
				if (!Number.isInteger(pendingTargetId) || pendingTargetId <= 0) {
					this.logger.error(`Pending transfer has invalid target instance: ${this.pendingTransfer.destination_instance_id}`);
					this.pendingTransfer = null;
					return;
				}
				this.logger.info(`Transfer export complete, initiating transfer to instance ${this.pendingTransfer.destination_instance_id}`);

				// Send transfer request to controller
				const transferResponse = await this.i.sendTo("controller",
					new messages.TransferPlatformRequest({
						exportId,
						targetInstanceId: Number(pendingTargetId),
					}) as unknown as messages.SimpleResponse & { transferId?: string }
				);

				if (transferResponse.success) {
					this.logger.info(`Transfer initiated: ${transferResponse.transferId}`);
				} else {
					this.logger.error(`Transfer failed: ${transferResponse.error}`);

					// Unlock platform on failure
					await this.sendRcon(
						`/sc local SurfaceLock = require("modules/surface_export/utils/surface-lock"); ` +
						`SurfaceLock.unlock_platform("${escapeString(String(data.platform_name || ""))}")`,
					);
				}

				// Clear pending transfer
				this.pendingTransfer = null;
			}
		} catch (err: unknown) {
			this.logger.error(`Error handling export completion: ${getErrorMessage(err)}`);
		}
	}

	/**
	 * Handle space platform state change notification from Factorio mod.
	 * Forwards a lightweight event to the controller so it can push a tree refresh.
	 */
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

	/**
	 * Handle transfer request from Lua command
	 */
	async handleTransferRequest(data: Record<string, unknown>) {
		this.logger.info(`Transfer request send_json event received: platform=${data.platform_name}, dest=${data.destination_instance_id} (type=${typeof data.destination_instance_id}), job_id=${data.job_id}`);

		try {
			const platformIndex = Number(data.platform_index);
			const destinationInstanceId = Number(data.destination_instance_id);
			// Store transfer request for when export completes
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

	/**
	 * Handle import file request from Factorio mod
	 */
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

	/**
	 * Export a platform by platform index
	 */
	async exportPlatform(platformIndex: number, forceName = "player", targetInstanceId: number | null = null): Promise<ExportResult> {
		const resolvedTargetId = Number(targetInstanceId);
		const hasTargetInstance = Number.isInteger(resolvedTargetId) && resolvedTargetId > 0;
		const targetArg = hasTargetInstance ? String(resolvedTargetId) : "nil";
		this.logger.info(`Exporting platform index ${platformIndex} for force "${forceName}" (targetInstanceId=${targetArg})`);

		try {
			// Call mod's remote interface to export platform - this returns the export_id
			const rconResult = await this.sendRcon(
				`/sc local export_id, err = remote.call("surface_export", "export_platform", ${platformIndex}, "${escapeString(forceName)}", ${targetArg}); ` +
				`if export_id then rcon.print(export_id) else rcon.print("EXPORT_FAILED:" .. tostring(err or "unknown")) end`,
			);
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

			// The export data will be sent to the controller automatically via the
			// send_json event-triggered handleExportComplete() path, which uses the real platform
			// name from Lua (not the sanitized exportId). No need to send it here too.
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
			await new Promise(resolve => setTimeout(resolve, intervalMs));
		}
		this.logger.error(`Timed out waiting for export data for ${exportId} after ${timeoutMs}ms`);
		// Log available exports for debugging once at timeout
		try {
			const availableExports = await this.listExports();
			this.logger.error(`Available exports in Lua: ${JSON.stringify(availableExports)}`);
		} catch (listErr: unknown) {
			this.logger.error(`Failed to list available exports: ${getErrorMessage(listErr)}`);
		}
		return null;
	}

	/**
	 * Get export data from mod
	 */
	async getExportData(exportId: string, options: { logOnMissing?: boolean } = {}): Promise<ExportData | null> {
		try {
			const { logOnMissing = true } = options;
			const safeExportId = String(exportId || "").trim();
			if (this.isInvalidExportId(safeExportId)) {
				this.logger.warn(`Skipping getExportData for invalid export ID: ${JSON.stringify(exportId)}`);
				return null;
			}
			// Call the _json version which pre-encodes the result in Lua
			const result = await this.sendRcon(
				`/sc rcon.print(remote.call("surface_export", "get_export_json", "${safeExportId}"))`,
			);

			const jsonText = String(result || "").trim();
			if (!jsonText || jsonText === "null") {
				if (logOnMissing) {
					this.logger.error(`Export data not found for ${safeExportId} - Lua returned empty/null`);
					// List available exports for debugging
					try {
						const availableExports = await this.listExports();
						this.logger.error(`Available exports in Lua: ${JSON.stringify(availableExports)}`);
					} catch (listErr: unknown) {
						this.logger.error(`Failed to list available exports: ${getErrorMessage(listErr)}`);
					}
				}
				return null;
			}

			const exportData = JSON.parse(jsonText);
			if (!exportData || typeof exportData !== "object") {
				return null;
			}

			// Log compression info if data is compressed
			if (exportData.compressed && exportData.payload) {
				const compressedSize = (exportData.payload.length / 1024).toFixed(1);
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

	/**
	 * List all platform exports stored in mod
	 */
	async listExports(): Promise<string[]> {
		try {
			const result = await this.sendRcon(
				"/sc rcon.print(remote.call(\"surface_export\", \"list_exports_json\"))",
			);

			return JSON.parse(result);
		} catch (err: unknown) {
			this.logger.error(`List exports failed: ${getErrorMessage(err)}`);
			return [];
		}
	}

	/**
	 * List all current platforms on this instance for a force
	 */
	async listPlatforms(forceName = "player") {
		const safeForceName = escapeString(String(forceName || "player"));

		try {
			const result = await this.sendRcon(
				`/sc rcon.print(remote.call("surface_export", "list_platforms_json", "${safeForceName}"))`,
			);
			const parsed = JSON.parse(result);
			if (!Array.isArray(parsed)) {
				return [];
			}

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

	/**
	 * Import a platform from export data using chunked RCON (like inventory_sync)
	 */
	async importPlatform(exportData: ExportData, forceName = "player"): Promise<ImportResult> {
		const platformName = exportData.platform_name || `Imported_${Date.now()}`;
		this.logger.info(`Importing platform "${platformName}" for force "${forceName}"`);

		try {
			// Keep data in its current format (compressed or uncompressed)
			// Lua side will handle decompression in queue_import
			const jsonData = JSON.stringify(exportData);
			const sizeKB = (jsonData.length / 1024).toFixed(1);

			if (exportData.compressed) {
				this.logger.info(`Import data size: ${sizeKB} KB (compressed with ${exportData.compression})`);
			} else {
				this.logger.info(`Import data size: ${sizeKB} KB (uncompressed)`);
			}

			// Use chunked approach like inventory_sync
			const chunkSize = RCON_CHUNK_SIZE;
			const chunks: string[] = [];
			for (let i = 0; i < jsonData.length; i += chunkSize) {
				chunks.push(jsonData.slice(i, i + chunkSize));
			}

			this.logger.info(`Sending import in ${chunks.length} chunks`);

			const escapedPlatformName = escapeString(platformName);
			const escapedForceName = escapeString(forceName);

			// Send chunks using import_platform_chunk remote interface
			for (let i = 0; i < chunks.length; i++) {
				const chunk = escapeString(chunks[i]);
				const chunkNum = i + 1;
				const totalChunks = chunks.length;

				await this.sendRcon(
					`/sc remote.call("surface_export", "import_platform_chunk", ` +
					`"${escapedPlatformName}", '${chunk}', ${chunkNum}, ${totalChunks}, "${escapedForceName}")`,
					true,
				);

				if (i % 10 === 0 || chunkNum === totalChunks) {
					this.logger.verbose(`Sent chunk ${chunkNum}/${totalChunks}`);
				}
			}

			this.logger.info(`All ${chunks.length} chunks sent, import queued for async processing`);
			return { success: true };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Import failed: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	/**
	 * Import a platform from a file in script-output directory
	 * FACTORIO 2.0: Lua cannot read files, so Node.js reads and sends via RCON chunks
	 */
	async importPlatformFromFile(filename: string, platformName: string | null = null, forceName = "player"): Promise<ImportResult> {
		this.logger.info(`Importing platform from file "${filename}" for force "${forceName}"`);

		try {
			// Step 1: Node.js reads the file (Lua cannot do this in Factorio 2.0)
			const instanceDir = String(this.i.config.get("instance.directory"));
			const scriptOutputPath = path.join(instanceDir, "script-output", filename);

			this.logger.verbose(`Reading file from: ${scriptOutputPath}`);
			const fileContent = await fs.promises.readFile(scriptOutputPath, "utf8");
			const exportData = JSON.parse(fileContent);

			const sizeKB = (fileContent.length / 1024).toFixed(1);
			this.logger.info(`File loaded: ${sizeKB} KB`);

			// Use the original platform name if no custom name provided
			const targetPlatformName = platformName || exportData.platform_name || `Imported_${Date.now()}`;

			// Step 2: Send to Factorio via RCON chunking
			// Use the existing import_platform_chunk remote interface
			const escapedTargetName = escapeString(targetPlatformName);
			const escapedForceName = escapeString(forceName);
			await sendChunkedJson(
				this.i,
				`remote.call("surface_export", "import_platform_chunk", "${escapedTargetName}", %CHUNK%, %INDEX%, %TOTAL%, "${escapedForceName}")`,
				exportData,
				this.logger,
				RCON_CHUNK_SIZE,
			);

			this.logger.info("Platform import chunks sent successfully");

			// Step 3: Wait a moment for async processing to start
			await new Promise(resolve => setTimeout(resolve, 500));

			// Step 4: Verify the import was queued
			try {
				const result = await this.sendRcon(
					"/sc rcon.print('{\"success\":true}')",
				);
				const response = JSON.parse(result);

				if (response.success) {
					this.logger.info("Platform import queued for async processing");
					return { success: true };
				}
			} catch (verifyErr: unknown) {
				this.logger.warn(`Could not verify import: ${getErrorMessage(verifyErr)}`);
			}

			return { success: true };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Import from file failed: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	/**
	 * Factorio requires the first Lua console command to be confirmed.
	 * Send a harmless command twice so subsequent RCON calls execute immediately.
	 */
	async ensureLuaConsoleUnlocked() {
		const unlockCommand = "/sc rcon.print(\"surface-export-ready\")";
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			try {
				await this.sendRcon(unlockCommand);
				if (attempt === 1) {
					// First attempt may only trigger the confirmation prompt; always run twice.
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

	/**
	 * Handle export platform request
	 */
	async handleExportPlatformRequest(request: { platformIndex: number; forceName?: string; targetInstanceId?: number | null }) {
		const result = await this.exportPlatform(request.platformIndex, request.forceName, request.targetInstanceId ?? null);
		const numericTargetInstanceId = Number(request.targetInstanceId);
		if (result?.success && Number.isInteger(numericTargetInstanceId) && numericTargetInstanceId > 0) {
			this.controllerManagedTransferExports.add(result.exportId as string);
		}
		return result;
	}

	/**
	 * Handle import platform request
	 */
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

	/**
	 * Handle import platform from file request
	 */
	async handleImportPlatformFromFileRequest(request: { filename: string; platformName?: string | null; forceName?: string }) {
		return await this.importPlatformFromFile(request.filename, request.platformName ?? null, request.forceName || "player");
	}

	/**
	 * Handle controller request for platform inventory on this instance
	 */
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

	/**
	 * Handle import completion and perform validation
	 * Called by Lua when async import completes
	 */
	async handleImportCompleteValidation(data: Record<string, unknown>) {
		this.logger.info(`Import completed for ${data.platform_name}, performing validation`);

		// Extract transfer metadata from platform data
		const transferId = String(data.transfer_id || "").trim();
		const sourceInstanceId = Number(data.source_instance_id);
		const operationId = data.operation_id ? String(data.operation_id) : null;

		// Extract metrics from send_json payload
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
						metrics: (metrics as Record<string, number> | null) || null,
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
			// Get validation data from Lua
			const validationStartMs = Date.now();
			const validationResult = await this.sendRcon(
				`/sc rcon.print(remote.call("surface_export", "get_validation_result_json", "${escapeString(String(data.platform_name || ""))}"))`,
			);
			const validationDurationMs = Date.now() - validationStartMs;

			this.logger.info(`Validation RCON call took ${validationDurationMs}ms, result: ${validationResult.substring(0, 200)}...`);

			// Default to failed validation - only pass if we get actual validation data
			let validation: messages.ValidationResult = {
				itemCountMatch: false,
				fluidCountMatch: false,
				entityCount: Number.isFinite(Number(data.entity_count)) ? Number(data.entity_count) : undefined,
				mismatchDetails: "Validation data not retrieved",
			};
			let validationRetrieved = false;

			if (validationResult && validationResult !== "null" && validationResult.startsWith("{")) {
				try {
					const parsed = JSON.parse(validationResult) as Partial<messages.ValidationResult>;
					validation = {
						...parsed,
						itemCountMatch: Boolean(parsed.itemCountMatch),
						fluidCountMatch: Boolean(parsed.fluidCountMatch),
					};
					validationRetrieved = true;
				} catch (_parseErr) {
					this.logger.error(`Failed to parse validation result: ${validationResult}`);
					validation.mismatchDetails = "Failed to parse validation result";
				}
			} else if (validationResult && !validationResult.startsWith("{") && validationResult !== "null") {
				this.logger.warn(`Unexpected validation result format: ${validationResult}`);
				validation.mismatchDetails = `Validation error: ${validationResult.substring(0, 100)}`;
			}

			const normalizedMetrics = metrics && typeof metrics === "object"
				? Object.fromEntries(Object.entries(metrics as Record<string, unknown>)
					.filter(([, v]) => typeof v === "number" && Number.isFinite(v))
					.map(([k, v]) => [k, v as number]))
				: undefined;

			// Send validation event to controller with metrics
			await this.i.sendTo("controller", new messages.TransferValidationEvent({
				transferId,
				platformName: String(data.platform_name || "Unknown"),
				sourceInstanceId,
				success: Boolean(validation.itemCountMatch && validation.fluidCountMatch),
				validation,
				metrics: normalizedMetrics, // Forward Lua import metrics to controller
			}));

			this.logger.info(`Validation event sent for transfer ${transferId}: success=${validation.itemCountMatch && validation.fluidCountMatch}`);

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error during validation: ${errMsg}`);

			// Send failure validation to prevent controller from hanging
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

	/**
	 * Handle delete source platform request
	 */
	async handleDeleteSourcePlatform(request: { platformName: string; forceName?: string }) {
		this.logger.info(`Deleting source platform: ${request.platformName}`);

		// Fields use lowercase_underscore to match Lua message schema
		const escapedPlatformName = escapeString(String(request.platformName || ""));
		const escapedForceName = escapeString(String(request.forceName || "player"));

		try {
			const result = await this.sendRcon(
				`/sc ` +
				// Clean up lock data first (clears storage.locked_platforms entry)
				`pcall(function() remote.call("surface_export", "unlock_platform", "${escapedPlatformName}") end); ` +
				`local force = game.forces["${escapedForceName}"]; ` +
				`local platform = nil; ` +
				`for _, p in pairs(force.platforms) do ` +
				`    if p.name == "${escapedPlatformName}" then platform = p; break; end ` +
				`end; ` +
				`if platform then ` +
				// CRITICAL: platform.destroy() is a no-op in Factorio 2.0 Space Age.
				// It returns without error but does NOT remove the platform or its surface.
				// game.delete_surface() is the only reliable way to remove a space platform.
				`    local surface = platform.surface; ` +
				`    if surface and surface.valid then ` +
				`        local ok, err = pcall(function() game.delete_surface(surface) end); ` +
				`        if ok then ` +
				`            game.print("[Transfer Complete] Platform '${escapedPlatformName}' transferred and deleted from source", {0, 1, 0}); ` +
				`            rcon.print("SUCCESS"); ` +
				`        else ` +
				`            rcon.print("ERROR:delete_surface failed: " .. tostring(err)); ` +
				`        end ` +
				`    else ` +
				`        rcon.print("ERROR:Platform surface not valid"); ` +
				`    end ` +
				`else ` +
				`    rcon.print("ERROR:Platform not found"); ` +
				`end`,
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

	/**
	 * Handle unlock source platform request (rollback)
	 */
	async handleUnlockSourcePlatform(request: { platformName: string }) {
		this.logger.info(`Unlocking source platform for rollback: ${request.platformName}`);

		const escapedPlatformName = escapeString(String(request.platformName || ""));

		try {
			const result = await this.sendRcon(
				`/sc ` +
				`local success, err = remote.call("surface_export", "unlock_platform", "${escapedPlatformName}"); ` +
				`if success then ` +
				`    rcon.print("SUCCESS"); ` +
				`else ` +
				`    rcon.print("ERROR:" .. (err or "Unknown error")); ` +
				`end`,
			);

			if (result.trim() === "SUCCESS") {
				this.logger.info(`Platform ${request.platformName} unlocked successfully`);
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

	/**
	 * Handle transfer status update from controller
	 * Broadcasts status to all players in-game
	 */
	async handleTransferStatusUpdate(request: { message: string; color?: string }) {
		this.logger.info(`Transfer status: ${request.message}`);

		try {
			// Map color names to RGB arrays for Factorio
			const colorMap: Record<string, string> = {
				green: "{0, 1, 0}",
				yellow: "{1, 1, 0}",
				red: "{1, 0, 0}",
				blue: "{0, 0.5, 1}",
				white: "{1, 1, 1}",
			};

			const colorCode = colorMap[request.color || ""] || "{1, 1, 1}";

			// Send message to Factorio for in-game display
			await this.sendRcon(
				`/sc game.print("${escapeString(String(request.message ?? ""))}", ${colorCode})`,
				true,
			);

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
		const cacheLimit = this.i.config.get("surface_export.max_export_cache_size");
		if (typeof cacheLimit !== "number" || cacheLimit < 1) {
			throw new Error("surface_export.max_export_cache_size must be >= 1");
		}
	}
}

