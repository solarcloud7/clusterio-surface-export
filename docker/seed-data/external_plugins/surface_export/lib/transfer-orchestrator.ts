
import { normalizeExportMetrics, TICKS_TO_MS, getErrorMessage, VALIDATION_TIMEOUT_MS, buildPayloadMetrics, buildImportMetrics } from "../helpers";
import { createOperationRecord } from "./operation-record";
import type { IControllerPlugin, ActiveTransfer, SimpleResponse, TransferValidationEvent, StoredExport, ValidationResult, ImportMetrics, ExportMetrics } from "../messages";function mergeExportMetrics(storedMetrics: ExportMetrics | null | undefined, runtimeMetrics: Record<string, unknown> | null | undefined) {
	const merged = {
		...normalizeExportMetrics((storedMetrics || null) as Record<string, unknown> | null),
		...normalizeExportMetrics(runtimeMetrics || null),
	};
	return Object.keys(merged).length ? merged : null;
}

/**
 * Transfer lifecycle state machine.
 * Handles the full transfer flow: export → transmit → import → validate → cleanup/rollback.
 */
export class TransferOrchestrator {
	private plugin: IControllerPlugin;
	private messages: typeof import("../messages");

	constructor(plugin: IControllerPlugin, messages: typeof import("../messages")) {
		this.plugin = plugin;
		this.messages = messages;
	}

	get logger() { return this.plugin.logger; }
	get txLogger() { return this.plugin.txLogger; }
	get subscriptions() { return this.plugin.subscriptions; }

	async waitForStoredExport(exportId: string, timeoutMs = 10000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const stored = this.plugin.platformStorage.get(exportId);
			if (stored) return stored;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		throw new Error(`Timed out waiting for export ${exportId} to be stored on controller`);
	}

	/** Send in-game status message to both source and destination instances. */
	async broadcastTransferStatus(transfer: ActiveTransfer, status: string, color: string | null = null) {
		const msg = new this.messages.TransferStatusUpdate({
			transferId: transfer.transferId,
			platformName: transfer.platformName,
			message: `[Transfer: ${transfer.platformName}] ${status}`,
			color,
		});
		for (const instanceId of [transfer.sourceInstanceId, transfer.targetInstanceId]) {
			try { await this.plugin.controller.sendTo({ instanceId }, msg).catch(() => {}); }
			catch (_err) { /* instance may be offline */ }
		}
	}

	/** Update transfer status and broadcast to UI subscribers. */
	updateTransfer(transfer: ActiveTransfer) {
		this.subscriptions.emitTransferUpdate(transfer);
		this.subscriptions.queueTreeBroadcast(transfer.forceName || "player");
	}

	/** Attempt to unlock source platform after a failure. Returns error string or null. */
	async tryUnlockSource(transferId: string, transfer: ActiveTransfer) {
		this.txLogger.logTransactionEvent(transferId, "rollback_attempt", "Unlocking source platform", {});
		try {
			const resp = await this.plugin.controller.sendTo(
				{ instanceId: transfer.sourceInstanceId },
				new this.messages.UnlockSourcePlatformRequest({
					platformName: transfer.platformName,
					forceName: transfer.forceName || "player",
				}),
			);
			if (resp?.success) {
				this.txLogger.logTransactionEvent(transferId, "rollback_success", "Source platform unlocked", {});
				return null;
			}
			const err = resp?.error || "Unknown unlock error";
			if (/platform not locked|no locked platforms/i.test(err)) {
				this.txLogger.logTransactionEvent(transferId, "rollback_success", `Source platform already unlocked (${err})`, {});
				return null;
			}
			this.txLogger.logTransactionEvent(transferId, "rollback_failed", `Unlock failed: ${err}`, { error: err });
			return err;
		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.txLogger.logTransactionEvent(transferId, "rollback_failed", `Unlock failed: ${errMsg}`, { error: errMsg });
			return errMsg;
		}
	}

	// ── Transfer initiation ─────────────────────────────────────────────

	async transferPlatform(exportId: string, targetInstanceId: number, exportMetrics: Record<string, unknown> | null = null, transferStartedAt: number | null = null) {
		const exportData = this.plugin.platformStorage.get(exportId);
		if (!exportData) {
			return { success: false, error: `Export not found: ${exportId}` };
		}

		const transferId = `transfer_${Date.now()}_${Math.random().toString(36).substring(7)}`;
		const innerData = exportData.exportData;
		const { payloadMetrics, itemCounts, fluidCounts } = buildPayloadMetrics(innerData);
		const platformInfo = (innerData?.platform && typeof innerData.platform === "object"
			? innerData.platform
			: {}) as { index?: number; force?: string };
		const mergedExportMetrics = mergeExportMetrics(exportData.exportMetrics, exportMetrics);

		// Shared skeleton via the common factory. Values are pre-resolved here so the
		// factory's defaults/guards are no-ops and the record is identical to the
		// previous inline construction. Transfer-only fields are overlaid afterward.
		const operation = createOperationRecord("transfer", {
			operationId: transferId,
			exportId,
			artifactSizeBytes: exportData.size ?? null,
			platformName: exportData.platformName || "Unknown",
			platformIndex: Number(platformInfo.index || 1),
			forceName: String(platformInfo.force || "player"),
			sourceInstanceId: exportData.instanceId,
			sourceInstanceName: this.plugin.platformTree.resolveInstanceName(exportData.instanceId),
			targetInstanceId,
			targetInstanceName: this.plugin.platformTree.resolveInstanceName(targetInstanceId),
			startedAt: transferStartedAt ?? Date.now(),
			status: "transporting",
		});
		operation.payloadMetrics = payloadMetrics;
		operation.exportMetrics = mergedExportMetrics;
		operation.sourceVerification = { itemCounts, fluidCounts };
		this.plugin.activeTransfers.set(transferId, operation);

		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) {
			return { success: false, error: "Failed to initialize transfer state" };
		}
		this.txLogger.logTransactionEvent(transferId, "transfer_created",
			`${transfer.platformName}: ${transfer.sourceInstanceName || transfer.sourceInstanceId} → ${transfer.targetInstanceName || targetInstanceId}`, {
				exportMetrics: mergedExportMetrics,
				payloadMetrics,
			});
		this.updateTransfer(transfer);

		try {
			// Transmit to target instance
			this.txLogger.startPhase(transferId, "transmission");
			const response = await this.plugin.controller.sendTo(
				{ instanceId: targetInstanceId },
				new this.messages.ImportPlatformRequest({
					exportId,
					exportData: { ...innerData, _transferId: transferId, _sourceInstanceId: exportData.instanceId },
					forceName: "player",
				}),
			);
			const transmissionMs = this.txLogger.endPhase(transferId, "transmission");

			if (!response.success) {
				return await this.handleImportFailure(transferId, response.error || "Import failed", transmissionMs);
			}

			// Import accepted — wait for validation callback
			transfer.status = "awaiting_validation";
			this.updateTransfer(transfer);
			this.txLogger.logTransactionEvent(transferId, "import_started",
				`Awaiting validation (timeout: ${VALIDATION_TIMEOUT_MS / 1000}s)`, { transmissionMs });
			this.txLogger.startPhase(transferId, "validation");
			this.scheduleValidationTimeout(transferId);

			return { success: true, transferId, message: `Transfer initiated: ${transferId}` };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error transferring platform: ${errMsg}`);
			return { success: false, error: errMsg };
		}
	}

	async handleImportFailure(transferId: string, error: string, transmissionMs: number) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) return { success: false, error };

		transfer.status = "failed";
		transfer.error = error || "Import failed";
		transfer.failedAt = Date.now();
		this.txLogger.logTransactionEvent(transferId, "import_failed",
			`Import failed: ${error}`, { error, transmissionMs });

		const rollbackError = await this.tryUnlockSource(transferId, transfer);
		if (rollbackError) transfer.error = `${transfer.error}; rollback failed: ${rollbackError}`;

		this.updateTransfer(transfer);
		await this.txLogger.persistTransactionLog(transferId);
		return { success: false, error };
	}

	scheduleValidationTimeout(transferId: string) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) return;

		transfer.validationTimeout = setTimeout(async () => {
			const current = this.plugin.activeTransfers.get(transferId);
			if (!current || current.status !== "awaiting_validation") return;

			this.txLogger.logTransactionEvent(transferId, "validation_timeout",
				"No validation response within 2 minutes", {});
			await this.handleTransferValidation(new this.messages.TransferValidationEvent({
				transferId,
				success: false,
				platformName: current.platformName,
				sourceInstanceId: current.sourceInstanceId,
				validation: {
					itemCountMatch: false,
					fluidCountMatch: false,
					mismatchDetails: "Validation timeout - no response received within 2 minutes",
				},
			}));
		}, VALIDATION_TIMEOUT_MS);
	}

	// ── Validation handling ─────────────────────────────────────────────

	async handleTransferValidation(event: TransferValidationEvent) {
		const validationMs = this.txLogger.endPhase(event.transferId, "validation");
		const importMetrics = buildImportMetrics(event.metrics);

		this.txLogger.logTransactionEvent(event.transferId, "validation_received",
			`Validation: ${event.success ? "SUCCESS" : "FAILED"}`, {
				success: event.success, validation: event.validation, validationMs, importMetrics,
			});

		const transfer = this.plugin.activeTransfers.get(event.transferId);
		if (!transfer) {
			this.logger.warn(`Validation for unknown transfer: ${event.transferId}`);
			return;
		}

		if (importMetrics) transfer.importMetrics = importMetrics;
		transfer.validationResult = event.validation || null;

		if (transfer.validationTimeout) {
			clearTimeout(transfer.validationTimeout);
			transfer.validationTimeout = null;
		}

		try {
			if (event.success) {
				await this.handleValidationSuccess(event.transferId, transfer);
			} else {
				await this.handleValidationFailure(event.transferId, transfer, event.validation);
			}
			this.pruneOldTransfers();
		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error handling validation: ${errMsg}`);
			transfer.status = "error";
			transfer.error = errMsg;
			this.updateTransfer(transfer);
			await this.broadcastTransferStatus(transfer, `Error: ${errMsg}`, "red");
		}
	}

	async handleValidationSuccess(transferId: string, transfer: ActiveTransfer) {
		this.txLogger.startPhase(transferId, "cleanup");
		await this.broadcastTransferStatus(transfer, "Validation passed ✓ — deleting source...", "green");

		const deleteResponse = await this.plugin.controller.sendTo(
			{ instanceId: transfer.sourceInstanceId },
			new this.messages.DeleteSourcePlatformRequest({
				platformIndex: transfer.platformIndex,
				platformName: transfer.platformName,
				forceName: transfer.forceName,
			}),
		);
		const cleanupMs = this.txLogger.endPhase(transferId, "cleanup");

		if (deleteResponse.success) {
			transfer.status = "completed";
			transfer.completedAt = Date.now();
			const durationMs = transfer.completedAt - transfer.startedAt;
			this.txLogger.logTransactionEvent(transferId, "transfer_completed",
				`Completed in ${Math.round(durationMs / 1000)}s`, {
					durationMs, cleanupMs,
					phases: this.txLogger.buildPhaseSummary(transfer),
				});
			this.updateTransfer(transfer);
			await this.broadcastTransferStatus(transfer, "Transfer complete! ✓", "green");
			await this.txLogger.persistTransactionLog(transferId);
			if (transfer.exportId) {
				this.plugin.platformStorage.delete(transfer.exportId);
			}
			await this.plugin.persistStorage();
			this.subscriptions.queueTreeBroadcast(transfer.forceName || "player");
		} else {
			this.logger.error(`Failed to delete source platform: ${deleteResponse.error}`);
			transfer.status = "cleanup_failed";
			transfer.error = deleteResponse.error;
			this.updateTransfer(transfer);
			await this.broadcastTransferStatus(transfer, `⚠ Cleanup failed: ${deleteResponse.error}`, "yellow");
		}
	}

	async handleValidationFailure(transferId: string, transfer: ActiveTransfer, validation: ValidationResult | undefined) {
		const errorMsg = validation?.mismatchDetails || "Unknown error";
		this.txLogger.logTransactionEvent(transferId, "validation_failed",
			`Validation failed: ${errorMsg}`, { validation });

		await this.broadcastTransferStatus(transfer, "Validation failed ✗ — rolling back...", "red");

		const rollbackError = await this.tryUnlockSource(transferId, transfer);
		if (rollbackError) {
			await this.broadcastTransferStatus(transfer, `⚠ Rollback failed: ${rollbackError}`, "red");
		} else {
			await this.broadcastTransferStatus(transfer, `Rolled back. Error: ${errorMsg}`, "red");
		}

		transfer.status = "failed";
		transfer.error = errorMsg;
		transfer.completedAt = Date.now();
		this.txLogger.logTransactionEvent(transferId, "transfer_failed",
			`Failed after ${Math.round((transfer.completedAt - transfer.startedAt) / 1000)}s`, {
				durationMs: transfer.completedAt - transfer.startedAt, error: errorMsg,
			});
		this.updateTransfer(transfer);
		await this.txLogger.persistTransactionLog(transferId);
	}

	pruneOldTransfers() {
		if (this.plugin.activeTransfers.size <= 100) return;
		const sorted = Array.from(this.plugin.activeTransfers.entries()) as Array<[string, ActiveTransfer]>;
		sorted.sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));
		for (let i = 100; i < sorted.length; i++) {
			this.plugin.activeTransfers.delete(sorted[i][0]);
		}
	}

	// ── Request handlers ────────────────────────────────────────────────

	async handleStartPlatformTransferRequest(request: { sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number; forceName?: string }) {
		const sourceInstanceId = Number(request.sourceInstanceId);
		if (!Number.isInteger(sourceInstanceId)) {
			return { success: false, error: `Invalid source instance: ${request.sourceInstanceId}` };
		}
		const sourceInstance = this.plugin.controller.instances.get(sourceInstanceId);
		if (!sourceInstance || sourceInstance.isDeleted) {
			return { success: false, error: `Unknown source instance ${sourceInstanceId}` };
		}
		const resolvedTarget = this.plugin.platformTree.resolveTargetInstance(request.targetInstanceId);
		if (!resolvedTarget) {
			return { success: false, error: `Unknown target instance ${request.targetInstanceId}` };
		}
		if (resolvedTarget.id === sourceInstanceId) {
			return { success: false, error: "Source and destination instances must be different" };
		}
		const forceName = request.forceName || "player";
		const sourcePlatformIndex = Number(request.sourcePlatformIndex);
		if (!Number.isInteger(sourcePlatformIndex) || sourcePlatformIndex < 1) {
			return { success: false, error: `Invalid platform index ${request.sourcePlatformIndex}` };
		}

		try {
			const t0 = Date.now();
			const exportResponse = await this.plugin.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new this.messages.ExportPlatformRequest({
					platformIndex: sourcePlatformIndex,
					forceName,
					targetInstanceId: resolvedTarget.id,
				}),
			) as SimpleResponse & { exportId?: string };
			const exportRequestMs = Date.now() - t0;
			if (!exportResponse?.success || !exportResponse.exportId) {
				return { success: false, error: exportResponse?.error || "Export failed" };
			}

			const t1 = Date.now();
			await this.waitForStoredExport(exportResponse.exportId);
			const waitForStoredMs = Date.now() - t1;

			const result = await this.transferPlatform(exportResponse.exportId, resolvedTarget.id, {
				requestExportAndLockMs: exportRequestMs,
				waitForControllerStoreMs: waitForStoredMs,
				controllerExportPrepTotalMs: exportRequestMs + waitForStoredMs,
			}, t0);
			return { ...result, exportId: exportResponse.exportId };
		} catch (err: unknown) {
			return { success: false, error: getErrorMessage(err) };
		}
	}

	async handleTransferPlatformRequest(request: { exportId: string; targetInstanceId: number }) {
		const resolved = this.plugin.platformTree.resolveTargetInstance(request.targetInstanceId);
		if (!resolved) {
			return { success: false, error: `Unknown instance ${request.targetInstanceId}` };
		}
		return this.transferPlatform(request.exportId, resolved.id);
	}
}
