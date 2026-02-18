"use strict";

const TICKS_TO_MS = 16.67;
const VALIDATION_TIMEOUT_MS = 120000;

/** Extract payload metrics from stored export data. */
function buildPayloadMetrics(innerData) {
	const verification = innerData?.verification || {};
	const itemCounts = verification.item_counts || {};
	const fluidCounts = verification.fluid_counts || {};
	return {
		payloadMetrics: {
			isCompressed: !!innerData?.compressed,
			compressionType: innerData?.compression || "none",
			payloadSizeKB: innerData?.payload ? Math.round(innerData.payload.length / 1024 * 10) / 10 : null,
			entityCount: innerData?.stats?.entity_count || 0,
			tileCount: innerData?.stats?.tile_count || 0,
			uniqueItemTypes: Object.keys(itemCounts).length,
			totalItemCount: Object.values(itemCounts).reduce((sum, c) => sum + c, 0),
			uniqueFluidTypes: Object.keys(fluidCounts).length,
			totalFluidVolume: Math.round(Object.values(fluidCounts).reduce((sum, c) => sum + c, 0) * 10) / 10,
		},
		itemCounts,
		fluidCounts,
	};
}

/** Convert Lua tick-based metrics to milliseconds. */
function buildImportMetrics(raw) {
	if (!raw) return null;
	const tickFields = ["tiles", "entities", "fluids", "belts", "state", "validation", "total"];
	const countFields = ["tiles_placed", "entities_created", "entities_failed", "fluids_restored",
		"belt_items_restored", "circuits_connected", "total_items", "total_fluids"];
	const result = { total_ticks: raw.total_ticks || 0 };
	for (const f of tickFields) result[`${f}_ms`] = Math.round((raw[`${f}_ticks`] || 0) * TICKS_TO_MS);
	for (const f of countFields) result[f] = raw[f] || 0;
	return result;
}

/**
 * Transfer lifecycle state machine.
 * Handles the full transfer flow: export → transmit → import → validate → cleanup/rollback.
 */
class TransferOrchestrator {
	constructor(plugin, messages) {
		this.plugin = plugin;
		this.messages = messages;
	}

	get logger() { return this.plugin.logger; }
	get txLogger() { return this.plugin.txLogger; }
	get subscriptions() { return this.plugin.subscriptions; }

	async waitForStoredExport(exportId, timeoutMs = 10000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const stored = this.plugin.platformStorage.get(exportId);
			if (stored) return stored;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		throw new Error(`Timed out waiting for export ${exportId} to be stored on controller`);
	}

	/** Send in-game status message to both source and destination instances. */
	async broadcastTransferStatus(transfer, status, color = null) {
		const msg = new this.messages.TransferStatusUpdate({
			transferId: transfer.transferId,
			platformName: transfer.platformName,
			message: `[Transfer: ${transfer.platformName}] ${status}`,
			color,
		});
		for (const instanceId of [transfer.sourceInstanceId, transfer.targetInstanceId]) {
			try { await this.plugin.controller.sendTo({ instanceId }, msg).catch(() => {}); }
			catch (_) { /* instance may be offline */ }
		}
	}

	/** Update transfer status and broadcast to UI subscribers. */
	updateTransfer(transfer) {
		this.subscriptions.emitTransferUpdate(transfer);
		this.subscriptions.queueTreeBroadcast(transfer.forceName || "player");
	}

	/** Attempt to unlock source platform after a failure. Returns error string or null. */
	async tryUnlockSource(transferId, transfer) {
		this.txLogger.logTransactionEvent(transferId, "rollback_attempt", "Unlocking source platform", {});
		try {
			const resp = await this.plugin.controller.sendTo(
				{ instanceId: transfer.sourceInstanceId },
				new this.messages.UnlockSourcePlatformRequest({
					platformName: transfer.platformName,
					forceName: transfer.forceName || "player",
				})
			);
			if (resp?.success) {
				this.txLogger.logTransactionEvent(transferId, "rollback_success", "Source platform unlocked", {});
				return null;
			}
			const err = resp?.error || "Unknown unlock error";
			this.txLogger.logTransactionEvent(transferId, "rollback_failed", `Unlock failed: ${err}`, { error: err });
			return err;
		} catch (err) {
			this.txLogger.logTransactionEvent(transferId, "rollback_failed", `Unlock failed: ${err.message}`, { error: err.message });
			return err.message;
		}
	}

	// ── Transfer initiation ─────────────────────────────────────────────

	async transferPlatform(exportId, targetInstanceId, exportMetrics = null) {
		const exportData = this.plugin.platformStorage.get(exportId);
		if (!exportData) {
			return { success: false, error: `Export not found: ${exportId}` };
		}

		const transferId = `transfer_${Date.now()}_${Math.random().toString(36).substring(7)}`;
		const innerData = exportData.exportData;
		const { payloadMetrics, itemCounts, fluidCounts } = buildPayloadMetrics(innerData);
		const platformInfo = innerData?.platform || {};

		this.plugin.activeTransfers.set(transferId, {
			transferId,
			exportId,
			platformName: exportData.platformName,
			platformIndex: platformInfo.index || 1,
			forceName: platformInfo.force || "player",
			sourceInstanceId: exportData.instanceId,
			sourceInstanceName: this.plugin.platformTree.resolveInstanceName(exportData.instanceId),
			targetInstanceId,
			targetInstanceName: this.plugin.platformTree.resolveInstanceName(targetInstanceId),
			startedAt: Date.now(),
			status: "transporting",
			payloadMetrics,
			exportMetrics: exportMetrics || null,
			sourceVerification: { itemCounts, fluidCounts },
		});

		const transfer = this.plugin.activeTransfers.get(transferId);
		this.txLogger.logTransactionEvent(transferId, "transfer_created",
			`${transfer.platformName}: ${transfer.sourceInstanceName || transfer.sourceInstanceId} → ${transfer.targetInstanceName || targetInstanceId}`, {
				exportMetrics: exportMetrics || null,
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
				})
			);
			const transmissionMs = this.txLogger.endPhase(transferId, "transmission");

			if (!response.success) {
				return await this.handleImportFailure(transferId, response.error, transmissionMs);
			}

			// Import accepted — wait for validation callback
			transfer.status = "awaiting_validation";
			this.updateTransfer(transfer);
			this.txLogger.logTransactionEvent(transferId, "import_started",
				`Awaiting validation (timeout: ${VALIDATION_TIMEOUT_MS / 1000}s)`, { transmissionMs });
			this.txLogger.startPhase(transferId, "validation");
			this.scheduleValidationTimeout(transferId);

			return { success: true, transferId, message: `Transfer initiated: ${transferId}` };

		} catch (err) {
			this.logger.error(`Error transferring platform:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}

	async handleImportFailure(transferId, error, transmissionMs) {
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

	scheduleValidationTimeout(transferId) {
		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) return;

		transfer.validationTimeout = setTimeout(async () => {
			const current = this.plugin.activeTransfers.get(transferId);
			if (!current || current.status !== "awaiting_validation") return;

			this.txLogger.logTransactionEvent(transferId, "validation_timeout",
				"No validation response within 2 minutes", {});
			await this.handleTransferValidation({
				transferId,
				success: false,
				platformName: current.platformName,
				sourceInstanceId: current.sourceInstanceId,
				validation: {
					itemCountMatch: false,
					fluidCountMatch: false,
					mismatchDetails: "Validation timeout - no response received within 2 minutes",
				},
			});
		}, VALIDATION_TIMEOUT_MS);
	}

	// ── Validation handling ─────────────────────────────────────────────

	async handleTransferValidation(event) {
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
		} catch (err) {
			this.logger.error(`Error handling validation:\n${err.stack}`);
			transfer.status = "error";
			transfer.error = err.message;
			this.updateTransfer(transfer);
			await this.broadcastTransferStatus(transfer, `Error: ${err.message}`, "red");
		}
	}

	async handleValidationSuccess(transferId, transfer) {
		this.txLogger.startPhase(transferId, "cleanup");
		await this.broadcastTransferStatus(transfer, "Validation passed \u2713 — deleting source...", "green");

		const deleteResponse = await this.plugin.controller.sendTo(
			{ instanceId: transfer.sourceInstanceId },
			new this.messages.DeleteSourcePlatformRequest({
				platformIndex: transfer.platformIndex,
				platformName: transfer.platformName,
				forceName: transfer.forceName,
			})
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
			await this.broadcastTransferStatus(transfer, "Transfer complete! \u2713", "green");
			await this.txLogger.persistTransactionLog(transferId);
			this.plugin.platformStorage.delete(transfer.exportId);
			await this.plugin.persistStorage();
			this.subscriptions.queueTreeBroadcast(transfer.forceName || "player");
		} else {
			this.logger.error(`Failed to delete source platform: ${deleteResponse.error}`);
			transfer.status = "cleanup_failed";
			transfer.error = deleteResponse.error;
			this.updateTransfer(transfer);
			await this.broadcastTransferStatus(transfer, `\u26A0 Cleanup failed: ${deleteResponse.error}`, "yellow");
		}
	}

	async handleValidationFailure(transferId, transfer, validation) {
		const errorMsg = validation?.mismatchDetails || "Unknown error";
		this.txLogger.logTransactionEvent(transferId, "validation_failed",
			`Validation failed: ${errorMsg}`, { validation });

		await this.broadcastTransferStatus(transfer, "Validation failed \u2717 — rolling back...", "red");

		const rollbackError = await this.tryUnlockSource(transferId, transfer);
		if (rollbackError) {
			await this.broadcastTransferStatus(transfer, `\u26A0 Rollback failed: ${rollbackError}`, "red");
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
		const sorted = Array.from(this.plugin.activeTransfers.entries())
			.sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));
		for (let i = 100; i < sorted.length; i++) {
			this.plugin.activeTransfers.delete(sorted[i][0]);
		}
	}

	// ── Request handlers ────────────────────────────────────────────────

	async handleStartPlatformTransferRequest(request) {
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
				new this.messages.ExportPlatformRequest({ platformIndex: sourcePlatformIndex, forceName })
			);
			const exportRequestMs = Date.now() - t0;
			if (!exportResponse?.success || !exportResponse.exportId) {
				return { success: false, error: exportResponse?.error || "Export failed" };
			}

			const t1 = Date.now();
			await this.waitForStoredExport(exportResponse.exportId);
			const waitForStoredMs = Date.now() - t1;

			const result = await this.transferPlatform(exportResponse.exportId, resolvedTarget.id, {
				exportRequestMs, waitForStoredMs, exportPrepTotalMs: exportRequestMs + waitForStoredMs,
			});
			return { ...result, exportId: exportResponse.exportId };
		} catch (err) {
			return { success: false, error: err.message };
		}
	}

	async handleTransferPlatformRequest(request) {
		const resolved = this.plugin.platformTree.resolveTargetInstance(request.targetInstanceId);
		if (!resolved) {
			return { success: false, error: `Unknown instance ${request.targetInstanceId}` };
		}
		return this.transferPlatform(request.exportId, resolved.id);
	}
}

module.exports = TransferOrchestrator;
