
import { wait } from "@clusterio/lib";
import { normalizeExportMetrics, TICKS_TO_MS, getErrorMessage, isSessionLostError, generateOperationId, coercePlatformIndex, VALIDATION_TIMEOUT_MS, buildPayloadMetrics, buildImportMetrics } from "../helpers";
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
			await wait(100);
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
			// Best-effort in-game status broadcast; the instance may legitimately be offline. The single
			// catch handles both the sync throw and the promise rejection (no redundant inner `.catch`).
			try { await this.plugin.controller.sendTo({ instanceId }, msg); }
			catch (_err) { /* instance may be offline */ }
		}
	}

	/** Update transfer status and broadcast to UI subscribers. */
	updateTransfer(transfer: ActiveTransfer) {
		this.subscriptions.emitTransferUpdate(transfer);
		this.subscriptions.queueTreeBroadcast(transfer.forceName || "player");
	}

	/** Attempt to unlock source platform after a failure. Returns error string or null. Delegates the raw
	 *  send (and the benign already-unlocked handling) to sendUnlockRequest; adds the tx-log breadcrumbs. */
	async tryUnlockSource(transferId: string, transfer: ActiveTransfer) {
		this.txLogger.logTransactionEvent(transferId, "rollback_attempt", "Unlocking source platform", {});
		const err = await this.sendUnlockRequest(transfer.sourceInstanceId, transfer.platformIndex, transfer.forceName || "player", transfer.platformName);
		if (!err) {
			this.txLogger.logTransactionEvent(transferId, "rollback_success", "Source platform unlocked", {});
			return null;
		}
		this.txLogger.logTransactionEvent(transferId, "rollback_failed", `Unlock failed: ${err}`, { error: err });
		return err;
	}


	// ── Transfer initiation ─────────────────────────────────────────────

	async transferPlatform(exportId: string, targetInstanceId: number, exportMetrics: Record<string, unknown> | null = null, transferStartedAt: number | null = null) {
		const exportData = this.plugin.platformStorage.get(exportId);
		if (!exportData) {
			return { success: false, error: `Export not found: ${exportId}` };
		}

		const transferId = generateOperationId("transfer");
		const innerData = exportData.exportData;
		const { payloadMetrics, itemCounts, fluidCounts } = buildPayloadMetrics(innerData);
		const platformInfo = (innerData?.platform && typeof innerData.platform === "object"
			? innerData.platform
			: {}) as { index?: number; force?: string };
		const mergedExportMetrics = mergeExportMetrics(exportData.exportMetrics, exportMetrics);

		// Source platform index — the KEY for the source delete. Prefer the TOP-LEVEL value surfaced on the
		// stored export (compression-proof); fall back to the payload's platform.index (readable only for
		// small, uncompressed exports). FAIL LOUD if neither is a valid index — never default to platform 1
		// (the old `|| 1`), which the now index-keyed source delete would (correctly) refuse via its name
		// cross-check, but which must not silently target the wrong platform if a path ever skipped the check.
		const topLevelIndex = exportData.platformIndex;
		const payloadIndex = Number(platformInfo.index);
		const sourcePlatformIndex = Number.isInteger(topLevelIndex) ? (topLevelIndex as number)
			: (Number.isInteger(payloadIndex) ? payloadIndex : null);
		if (sourcePlatformIndex === null || sourcePlatformIndex < 1) {
			return { success: false, error: `Transfer aborted: source platform index unavailable (top-level=${String(topLevelIndex)}, payload=${String(platformInfo.index)})` };
		}

		// Shared skeleton via the common factory. Values are pre-resolved here so the
		// factory's defaults/guards are no-ops and the record is identical to the
		// previous inline construction. Transfer-only fields are overlaid afterward.
		const operation = createOperationRecord("transfer", {
			operationId: transferId,
			exportId,
			artifactSizeBytes: exportData.size ?? null,
			platformName: exportData.platformName || "Unknown",
			platformIndex: sourcePlatformIndex,
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

		let importAccepted = false;
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

			// Destination ACCEPTED the import. Arm the validation timeout FIRST so that even if a later line
			// throws, the transfer is still resolved (fail -> rollback) by the timeout — and the catch below
			// must NOT unlock the source (the dest now holds the import; unlocking would leave a live source
			// coexisting with the dest copy = duplication).
			importAccepted = true;
			this.enterAwaitingValidation(transfer, transferId);
			this.txLogger.logTransactionEvent(transferId, "import_started",
				`Awaiting validation (timeout: ${VALIDATION_TIMEOUT_MS / 1000}s)`, { transmissionMs });

			return { success: true, transferId, message: `Transfer initiated: ${transferId}` };

		} catch (err: unknown) {
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error transferring platform: ${errMsg}`);
			if (importAccepted) {
				// Throw AFTER the destination accepted the import: do NOT unlock the source — it would coexist
				// with the destination copy (duplication). The validation timeout armed above will resolve it.
				return { success: false, error: errMsg };
			}
			if (isSessionLostError(err)) {
				// AMBIGUOUS delivery (#80): the import send was rejected by a controller↔host session drop
				// (Session Lost/Closed), which does NOT prove non-delivery — the destination may already have
				// started importing. Unlocking here would leave a live source alongside a destination copy
				// (duplication). Instead treat it like the ACK path: enter awaiting_validation so the normal
				// state machine resolves it — a real validation event completes it, or the timeout rolls it
				// back. Same residual profile as an ACK'd import whose validation never returns; strictly safer
				// than the guaranteed duplication of the unconditional unlock this replaces.
				//
				// KNOWN EXPOSURE (#106): for a GENUINE non-delivery SessionLost, the source unlock is now
				// deferred to the in-memory validation timeout instead of being synchronous. If the controller
				// restarts within that window, the timeout + activeTransfers record are lost and the source
				// stays locked-for-transfer (hidden) until an admin /unlock-platform. This is the SAME restart
				// fragility the ACK path already has (awaiting_validation is in-memory); the durable fix is
				// persisting/reconciling awaiting_validation transfers on controller boot (#106). A recoverable
				// stranded-lock is still strictly better than the unrecoverable duplication this branch prevents.
				//
				// Close the "transmission" phase the throw at the sendTo skipped (else a recovered+completed
				// transfer reports blank transmission timing — buildPhaseSummary drops phases with no duration).
				const transmissionMs = this.txLogger.endPhase(transferId, "transmission");
				this.enterAwaitingValidation(transfer, transferId);
				this.txLogger.logTransactionEvent(transferId, "import_delivery_uncertain",
					`Import send interrupted by session loss (${errMsg}); NOT unlocking source — awaiting validation`,
					{ error: errMsg, transmissionMs });
				return { success: true, transferId, message: `Transfer initiated (delivery unconfirmed after a session interruption; awaiting validation): ${transferId}` };
			}
			// Throw BEFORE accept with a definite non-delivery error: the source is locked but the destination
			// has nothing — safe to roll back (mirrors handleImportFailure).
			const rollbackError = await this.tryUnlockSource(transferId, transfer);
			if (rollbackError) {
				return { success: false, error: `${errMsg}; rollback failed: ${rollbackError}` };
			}
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

	/**
	 * Enter the `awaiting_validation` state: start the validation phase timer, arm the validation timeout
	 * (which fails → rolls back if no result arrives), and broadcast. Shared by the two paths that hand a
	 * transfer to the validation state machine — the destination-ACK path and the ambiguous-delivery path
	 * (a SessionLost on the import send, where the destination may already be importing).
	 */
	enterAwaitingValidation(transfer: ActiveTransfer, transferId: string) {
		this.txLogger.startPhase(transferId, "validation");
		this.scheduleValidationTimeout(transferId);
		transfer.status = "awaiting_validation";
		this.updateTransfer(transfer);
		// #106 Phase 1: persist an observability record while source-side Lua TTL is the recovery authority.
		// A restarted controller must not auto-delete or auto-unlock from this record.
		this.plugin.persistPendingTransfer({
			transferId,
			sourceInstanceId: transfer.sourceInstanceId,
			sourcePlatformIndex: transfer.platformIndex,
			sourcePlatformName: transfer.platformName,
			forceName: transfer.forceName || "player",
			targetInstanceId: Number(transfer.targetInstanceId),
			startedAt: transfer.startedAt,
			exportId: transfer.exportId ?? null,
		});
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
			// Drop the bounded observability record once the SOURCE is definitively resolved (deleted on success,
			// unlocked on failure). Keep cleanup_failed visible until retention pruning; Phase 1 recovery remains
			// source-side TTL unlock, never controller auto-delete on restart.
			if (transfer.status === "completed" || transfer.status === "failed" || transfer.status === "error") {
				this.plugin.removePendingTransfer(event.transferId);
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

		// #106: if the source unlock ALSO failed, the source is NOT resolved (still locked) — mark it
		// cleanup_failed (not failed) so handleTransferValidation KEEPS the persisted intent, letting a restart
		// reconcile retry the unlock. Mirrors the success path's cleanup_failed on a failed source delete.
		transfer.status = rollbackError ? "cleanup_failed" : "failed";
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
			// Export succeeded ⇒ the source is now locked-for-transfer on the source instance.

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
			const errMsg = getErrorMessage(err);
			// NEVER silent: the source is locked-for-transfer once the export succeeds, so a throw below it
			// (waitForStoredExport timeout, or transferPlatform's pre-transmission setup) would otherwise
			// leave it stuck locked-and-hidden with no trace. transferPlatform's own catch self-heals its
			// transmission failures; this covers the paths it can't.
			this.logger.error(`Error starting transfer (source instance ${sourceInstanceId}, platform #${sourcePlatformIndex}): ${errMsg}`);
			// Unlock the source by its UNIQUE index — we have it up-front from the request (no name resolution
			// needed now that the lock registry is index-keyed). Benign if it was never locked.
			const rollbackError = await this.sendUnlockRequest(sourceInstanceId, sourcePlatformIndex, forceName);
			if (rollbackError) {
				this.logger.error(`Rollback unlock of source #${sourcePlatformIndex} failed: ${rollbackError}`);
				return { success: false, error: `${errMsg}; rollback failed: ${rollbackError}` };
			}
			return { success: false, error: errMsg };
		}
	}

	/**
	 * Raw unlock send to a source instance. Returns null on success (including the already-unlocked /
	 * not-locked cases, which are benign), or an error string. Shared by the rollback paths so a thrown
	 * transfer step can never leave the source stuck locked-and-hidden.
	 */
	private async sendUnlockRequest(sourceInstanceId: number, platformIndex: number, forceName: string, platformName?: string): Promise<string | null> {
		if (coercePlatformIndex(platformIndex) === null) return `invalid platformIndex: ${String(platformIndex)}`;
		try {
			const resp = await this.plugin.controller.sendTo(
				{ instanceId: sourceInstanceId },
				// platformName is a name tripwire — harmless for the same-tick rollback (it matches), load-bearing
				// if a stale caller sees a reused index pointing at a different, in-flight platform.
				new this.messages.UnlockSourcePlatformRequest({ platformIndex, platformName: platformName ?? null, forceName }),
			);
			if (resp?.success) return null;
			const err = resp?.error || "Unknown unlock error";
			if (/platform not locked|no locked platforms/i.test(err)) return null;
			return err;
		} catch (err: unknown) {
			return getErrorMessage(err);
		}
	}

	async handleTransferPlatformRequest(request: { exportId: string; targetInstanceId: number }) {
		const resolved = this.plugin.platformTree.resolveTargetInstance(request.targetInstanceId);
		if (!resolved) {
			return { success: false, error: `Unknown instance ${request.targetInstanceId}` };
		}
		try {
			return await this.transferPlatform(request.exportId, resolved.id);
		} catch (err: unknown) {
			// transferPlatform's own try/catch self-heals its transmission failures, but a throw in its
			// PRE-transmit setup propagates here. On the auto-continuation path the source is already
			// locked-for-transfer, so roll it back rather than leave it stuck locked-and-hidden.
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error transferring export ${request.exportId}: ${errMsg}`);
			const stored = this.plugin.platformStorage.get(request.exportId);
			const force = String((stored?.exportData as { platform?: { force?: string } } | undefined)?.platform?.force || "player");
			if (stored && Number.isInteger(stored.platformIndex)) {
				const rollbackError = await this.sendUnlockRequest(stored.instanceId, stored.platformIndex as number, force);
				if (rollbackError) {
					this.logger.error(`Rollback unlock of source #${stored.platformIndex} ('${stored.platformName}') failed: ${rollbackError}`);
				}
			}
			return { success: false, error: errMsg };
		}
	}
}
