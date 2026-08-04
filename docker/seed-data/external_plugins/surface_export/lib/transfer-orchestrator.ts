
import { wait } from "@clusterio/lib";
import { normalizeExportMetrics, TICKS_TO_MS, getErrorMessage, isSessionLostError, isBenignUnlockError, coercePlatformIndex, VALIDATION_TIMEOUT_MS, buildPayloadMetrics, buildImportMetrics, makeCanonicalTransferId, parseCanonicalTransferId } from "../helpers";
import { createOperationRecord } from "./operation-record";
import type { IControllerPlugin, ActiveTransfer, SimpleResponse, TransferValidationEvent, StoredExport, ValidationResult, ImportMetrics, ExportMetrics } from "../messages";
function mergeExportMetrics(storedMetrics: ExportMetrics | null | undefined, runtimeMetrics: Record<string, unknown> | null | undefined) {
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
			catch (err: unknown) {
				this.logger.warn(`Failed to broadcast transfer status to instance ${instanceId}: ${getErrorMessage(err)}`);
			}
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

	/**
	 * `safeToUnlockSource` on a failure return is the callers' unlock authority, and it is OPT-IN:
	 * true ONLY where this method can prove nothing was delivered to the destination, absent (falsy)
	 * everywhere else — including any future return someone adds without thinking about it. The
	 * review that mandated it found the inverse defect armed and loaded: the instance-side caller
	 * unlocked on ANY success:false, and one success:false return here follows a DELIVERED import
	 * (the post-acceptance throw below) — unlock there and a later validation success finds the
	 * source lock gone, the delete gate refuses, and a permanent duplicate exists. For a
	 * source-deleting protocol the fail-safe direction is "don't unlock unless proven safe",
	 * exactly like the retry guard's unknown-status rule.
	 */
	async transferPlatform(exportId: string, targetInstanceId: number, exportMetrics: Record<string, unknown> | null = null, transferStartedAt: number | null = null): Promise<{
		success: boolean; error?: string; transferId?: string; message?: string;
		/** See the doc comment above — opt-in unlock authority, absent means DO NOT unlock. */
		safeToUnlockSource?: boolean;
	}> {
		const exportData = this.plugin.platformStorage.get(exportId);
		if (!exportData) {
			return { success: false, error: `Export not found: ${exportId}`, safeToUnlockSource: true };
		}

		// PREFLIGHT (owner ruling 2026-08-02: prevent the failure, don't build recovery for it): an
		// offline destination is refused HERE — before any ActiveTransfer record exists, so the
		// canonical ID is not burned and the retry guard never sees this attempt. The source instance
		// prints the error to the player and unlocks the platform through its existing failure path;
		// no new message, no new recovery flow. The residual (an instance dying MID-transfer) stays
		// possible and lands in the same place it always did: a loud cleanup_failed with the reason.
		if (!this.plugin.isInstanceOnline(targetInstanceId)) {
			const name = this.plugin.platformTree.resolveInstanceName(targetInstanceId);
			return { success: false, safeToUnlockSource: true, error:
				`Destination instance ${name ? `"${name}" ` : ""}(${targetInstanceId}) is offline — `
				+ "transfer refused before starting. The source platform is unchanged; retry when the "
				+ "destination is running." };
		}

		const transferId = exportData.exportId || exportId;
		const sourceExportId = exportData.sourceExportId || parseCanonicalTransferId(transferId)?.sourceJobId || transferId;
		const existingTransfer = this.plugin.activeTransfers.get(transferId);
		if (existingTransfer) {
			// Same-ID resubmit semantics, by what the existing record PROVES about the destination:
			// - LIVE states dedupe (idempotent success — the transfer is in flight).
			// - "failed" is the ONLY replaceable settled state: its rollback DISCARDED the destination,
			//   so a re-run cannot duplicate. Deterministic worlds (golden-save batches reset the Lua
			//   export counter) legitimately regenerate identical IDs after a failure, and the old
			//   unconditional short-circuit silently swallowed that retry while REPORTING success
			//   (measured: census-fusion R2, 2026-07-18).
			// - Everything else — completed / cleanup_failed / error / any UNKNOWN status — REFUSES
			//   loudly: those states mean the destination committed (or may have committed) a live
			//   copy, and re-running the same export would import a SECOND copy (the duplication
			//   class of platform identity is the stable index). Unknown statuses take
			//   the refusing branch on purpose: for a source-deleting path the fail-safe direction is
			//   "block the retry", never "re-run it" (/code-review finding, 2026-07-18).
			const live = existingTransfer.status === "transporting"
				|| existingTransfer.status === "awaiting_validation"
				|| existingTransfer.status === "awaiting_completion"
				|| existingTransfer.status === "in_progress";
			if (live) {
				return { success: true, transferId, message: `Transfer already active: ${transferId}` };
			}
			if (existingTransfer.status !== "failed") {
				// Unlocking the SOURCE here is safe even though the refusal names a committed
				// DESTINATION copy: nothing was sent on THIS attempt, and a fresh source lock from a
				// replayed export holds a platform this refusal just declined to move. For the settled
				// statuses themselves the unlock is a no-op or benign: a completed transfer's source
				// is deleted ("no longer exists"), a failure-path cleanup_failed source was unlocked
				// before its delete was attempted, and a SUCCESS-path cleanup_failed source (delete
				// refused post-commit) is still locked — where unlocking merely restores visibility of
				// a duplicate an operator must resolve anyway; it cannot create one, the copy already
				// exists. Verified branch by branch in review.
				return { success: false, safeToUnlockSource: true, error:
					`Refusing retry of settled transfer ${transferId} (status=${existingTransfer.status}): `
					+ "the destination may hold a committed copy; create a NEW export to transfer again" };
			}
			if (existingTransfer.validationResult?.destinationPreserved === true) {
				// "failed" is replaceable BECAUSE its rollback discarded the destination — the one-shot
				// debug preserve flag breaks that premise: the destination still exists, paused, and a
				// re-run would import a second copy beside it. Refuse like any other settled status.
				return { success: false, safeToUnlockSource: true, error:
					`Refusing retry of failed transfer ${transferId}: its destination was deliberately `
					+ "PRESERVED by the debug preserve_failed_destination flag, so a re-run would "
					+ "duplicate beside it. Remove the preserved platform (or restart the controller "
					+ "to clear the record), then create a NEW export." };
			}
			this.plugin.logger.info(
				`Replacing failed (destination-discarded) transfer record for retried export ${transferId}`);
		}
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
			return { success: false, safeToUnlockSource: true, error: `Transfer aborted: source platform index unavailable (top-level=${String(topLevelIndex)}, payload=${String(platformInfo.index)})` };
		}

		// Shared skeleton via the common factory. Values are pre-resolved here so the
		// factory's defaults/guards are no-ops and the record is identical to the
		// previous inline construction. Transfer-only fields are overlaid afterward.
		const operation = createOperationRecord("transfer", {
			operationId: transferId,
			exportId,
			sourceExportId,
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

		// EXPORT PHASE. The transaction log's waterfall used to begin at "transmission", so the
		// entire source-side export was missing from it — the one span whose stall is significant
		// enough to carry its own Prometheus histogram (surface_export_export_stall_seconds).
		// startPhase/endPhase cannot bracket it: they look the transfer up in activeTransfers, and
		// the export has to finish before this record can be built. The duration is already measured,
		// so record it as an ALREADY-COMPLETE phase rather than leaving a hole.
		// TWO DIFFERENT QUANTITIES can fill this slot, so they get DIFFERENT NAMES. Collapsing them
		// under one "export" label would be the exact defect the sibling commits exist to remove: a
		// number whose name implies a measurement it did not make.
		//
		//   controllerExportPrepTotalMs — WALL CLOCK (Date.now deltas: request + source lock + wait
		//     for the controller store). Only populated when the CONTROLLER drove the export.
		//   instanceAsyncExportMs — NOT wall clock. It is `math.floor(duration_ticks * 16.67)`
		//     (export-pipeline.lua), a tick count scaled by a nominal 60 UPS. It therefore cannot see
		//     wall-clock cost inside a single tick, and cannot see the game running BELOW 60 UPS —
		//     which is exactly what a large export causes. A tick-derived number is structurally
		//     blind to a tick stall, so this must NOT be described as measuring one.
		//
		// A transfer kicked off at the source instance (the RCON path, which transfer-platform.ps1
		// and the in-game command both use) carries only the instance-side timings — measured on a
		// live transfer: instanceAsyncExportMs=166, controllerExportPrepTotalMs absent entirely — so
		// preferring the wall-clock value unconditionally left the phase missing on the common path.
		// The fallback stays; it just stops pretending to be the same measurement.
		const finiteMs = (value: unknown): value is number =>
			typeof value === "number" && Number.isFinite(value) && value >= 0;
		const prepMs = mergedExportMetrics?.controllerExportPrepTotalMs;
		const inGameMs = mergedExportMetrics?.instanceAsyncExportMs;
		const exportPhase = finiteMs(prepMs) ? { name: "export", ms: prepMs }
			: finiteMs(inGameMs) ? { name: "exportTickEstimate", ms: inGameMs }
				: null;
		if (exportPhase) {
			// The end boundary is only real on the wall-clock path. On the tick-estimate path the
			// export finished on the instance some time before this record existed, so the bar's
			// absolute placement is approximate — another reason it carries its own name.
			const exportEndMs = Date.now();
			operation.phases = {
				...(operation.phases ?? {}),
				[exportPhase.name]: {
					startMs: exportEndMs - exportPhase.ms,
					endMs: exportEndMs,
					durationMs: exportPhase.ms,
				},
			};
		}
		operation.sourceVerification = { itemCounts, fluidCounts };
		this.plugin.activeTransfers.set(transferId, operation);

		const transfer = this.plugin.activeTransfers.get(transferId);
		if (!transfer) {
			return { success: false, safeToUnlockSource: true, error: "Failed to initialize transfer state" };
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
				// safeToUnlockSource stays FALSE here, explicitly: this is the one failure return that follows
				// a DELIVERED import, and it is exactly the return the review caught the instance-side caller
				// unlocking on. An unlock here clears the lock the source-delete gate requires, so a
				// subsequent validation SUCCESS finds "source is not locked-for-transfer", refuses the
				// delete, and a permanent duplicate exists.
				return { success: false, safeToUnlockSource: false, error: errMsg };
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
				// stays locked-for-transfer (hidden) until the SOURCE-SIDE TTL auto-unlocks it (~10 min). The
				// durable fix is that source-side tick-based expiry — the controller does NOT reconcile on boot
				// (the #60 controller boot-reconcile/auto-delete spine was removed). A recoverable
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
			// has nothing — safe to roll back (mirrors handleImportFailure). The unlock happens HERE, so
			// safeToUnlockSource stays falsy on the return: a caller unlocking again would be a benign no-op
			// that logs a spurious "not locked" error.
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

		// The unlock happens here (controller-side); safeToUnlockSource stays falsy on the return so
		// the instance caller does not re-unlock and log a spurious "not locked" error.
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
		transfer.failedStage = event.validation?.failedStage ?? null;

		if (transfer.validationTimeout) {
			clearTimeout(transfer.validationTimeout);
			transfer.validationTimeout = null;
		}

		try {
			// #106: whether the SOURCE is definitively resolved (deleted on success, unlocked on
			// failure). BOTH handlers report it directly. It used to be inferred from a status set
			// ("completed"/"failed"/"error"), which was a proxy twice over: a failed unlock had to
			// wear cleanup_failed just to dodge the removal, and a destination-orphan (source fully
			// unlocked, status cleanup_failed for the TARGET-side leftover) kept a pending intent
			// for a source that owed nothing. The condition is now the condition.
			let sourceResolved;
			if (event.success) {
				({ sourceResolved } = await this.handleValidationSuccess(event.transferId, transfer));
			} else {
				({ sourceResolved } = await this.handleValidationFailure(event.transferId, transfer, event.validation));
			}
			// Drop the bounded observability record once the SOURCE is definitively resolved. A
			// still-locked source (unlock failed, TTL pending — or a post-commit delete failure)
			// KEEPS its intent until bounded retention pruning; Phase 1 recovery remains source-side
			// TTL unlock, never controller auto-delete on restart.
			if (sourceResolved) {
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
				// Name-free request-vs-lock correlation: transfer.sourceExportId == the source lock's transfer_job_id.
				exportId: transfer.sourceExportId ?? transfer.exportId ?? null,
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
			return { sourceResolved: true };
		}
		// cleanup_failed in its one remaining post-commit meaning: the destination holds the
		// committed copy and the SOURCE could not be deleted — a DUPLICATE exists until an operator
		// (or a later delete) removes the source. The preflight makes this rare (an instance has to
		// die MID-transfer); it cannot make it impossible. Source unresolved: keep the intent.
		this.logger.error(`Failed to delete source platform: ${deleteResponse.error}`);
		transfer.status = "cleanup_failed";
		transfer.error = deleteResponse.error;
		this.updateTransfer(transfer);
		await this.broadcastTransferStatus(transfer, `⚠ Cleanup failed: ${deleteResponse.error}`, "yellow");
		return { sourceResolved: false };
	}

	async handleValidationFailure(transferId: string, transfer: ActiveTransfer, validation: ValidationResult | undefined) {
		const errorMsg = validation?.mismatchDetails || "Unknown error";
		const destinationCleanupError = validation?.cleanup_failed
			? String(validation.cleanup_error || "destination discard failed")
			: null;
		this.txLogger.logTransactionEvent(transferId, "validation_failed",
			`Validation failed: ${errorMsg}`, { validation });

		await this.broadcastTransferStatus(transfer, "Validation failed ✗ — rolling back...", "red");

		const rollbackError = await this.tryUnlockSource(transferId, transfer);
		if (rollbackError) {
			await this.broadcastTransferStatus(transfer, `⚠ Rollback failed: ${rollbackError}`, "red");
		} else {
			await this.broadcastTransferStatus(transfer, `Rolled back. Error: ${errorMsg}`, "red");
		}

		// Status semantics (owner ruling 2026-08-02, contract-over-recovery): `cleanup_failed` means
		// exactly one thing — A PLATFORM WAS LEFT BEHIND that automation could not remove (here: the
		// failed destination's discard failed, so an orphan exists on the target). A failed source
		// UNLOCK is deliberately NOT that status: the source-side TTL auto-unlock is the designed
		// recovery, so the distinct status was decoration — handling that exists only to make the
		// record look different is not handling. The unlock failure still rides in the error text,
		// and the #106 protection (keep the persisted intent while the source is still locked) now
		// keys on the CONDITION itself via this method's return value, not on the status that used
		// to proxy for it.
		transfer.status = destinationCleanupError ? "cleanup_failed" : "failed";
		transfer.error = [errorMsg, rollbackError, destinationCleanupError].filter(Boolean).join("; ");
		transfer.completedAt = Date.now();
		this.txLogger.logTransactionEvent(transferId, "transfer_failed",
			`Failed after ${Math.round((transfer.completedAt - transfer.startedAt) / 1000)}s`, {
				durationMs: transfer.completedAt - transfer.startedAt,
				error: transfer.error,
				destinationCleanupError,
			});
		this.updateTransfer(transfer);
		await this.txLogger.persistTransactionLog(transferId);
		// #106: the caller keeps the persisted awaiting_validation intent while the source is still
		// locked (unlock failed → only the source-side TTL will recover it — the record must outlive
		// this method so that state stays observable).
		return { sourceResolved: !rollbackError };
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

		// PREFLIGHT, BEFORE the export request: on this path the EXPORT is what locks the source
		// (kind="transfer" deliberately skips the completion unlock), so refusing after it means a
		// locked-and-hidden platform, a wasted export stall, and — review finding — no rollback,
		// because transferPlatform's refusal is a RETURN and the rollback below lives in the catch.
		// Refusing here costs nothing and leaves nothing to clean up.
		if (!this.plugin.isInstanceOnline(resolvedTarget.id)) {
			const name = this.plugin.platformTree.resolveInstanceName(resolvedTarget.id);
			return { success: false, error:
				`Destination instance ${name ? `"${name}" ` : ""}(${resolvedTarget.id}) is offline — `
				+ "transfer refused before starting. Nothing was locked or exported; retry when the "
				+ "destination is running." };
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
			const canonicalExportId = makeCanonicalTransferId(sourceInstanceId, exportResponse.exportId);
			await this.waitForStoredExport(canonicalExportId);
			const waitForStoredMs = Date.now() - t1;

			const result = await this.transferPlatform(canonicalExportId, resolvedTarget.id, {
				requestExportAndLockMs: exportRequestMs,
				waitForControllerStoreMs: waitForStoredMs,
				controllerExportPrepTotalMs: exportRequestMs + waitForStoredMs,
			}, t0);
			// A refusal that transferPlatform proves delivery-free must UNLOCK the source on THIS
			// path too: the export above locked it, this handler owns that lock, and the instance's
			// own unlock-on-refusal never fires here (controllerManagedTransferExports suppresses
			// its handleExportComplete continuation). Review finding: without this, a refusal —
			// offline destination raced past the preflight, or a settled-ID collision — stranded the
			// platform locked-and-hidden for the full TTL while the message said "unchanged".
			if (!result.success && result.safeToUnlockSource) {
				const rollbackError = await this.sendUnlockRequest(sourceInstanceId, sourcePlatformIndex, forceName);
				if (rollbackError) {
					this.logger.error(`Unlock after refused transfer of #${sourcePlatformIndex} failed: ${rollbackError}`);
					return { ...result, error: `${result.error}; rollback failed: ${rollbackError}`,
						exportId: canonicalExportId, sourceExportId: exportResponse.exportId };
				}
			}
			return { ...result, exportId: canonicalExportId, sourceExportId: exportResponse.exportId };
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
			if (isBenignUnlockError(err)) return null;
			return err;
		} catch (err: unknown) {
			return getErrorMessage(err);
		}
	}

	async handleTransferPlatformRequest(request: { exportId: string; targetInstanceId: number; sourceInstanceId?: number | null; sourceExportId?: string | null }) {
		const resolved = this.plugin.platformTree.resolveTargetInstance(request.targetInstanceId);
		if (!resolved) {
			// Provably pre-send — nothing exists to have been delivered to — so the refusal carries
			// the unlock authority. The reconciliation review caught this handler sitting OUTSIDE the
			// flag taxonomy: it refuses before transferPlatform is ever reached, so an in-game
			// `/transfer-platform <idx> <bogus-id>` stranded its export lock for the full TTL while
			// the instance-side gate (correctly, per contract) declined to unlock an unflagged refusal.
			return { success: false, safeToUnlockSource: true, error: `Unknown instance ${request.targetInstanceId}` };
		}
		try {
			const exportId = this.plugin.platformStorage.get(request.exportId)
				? request.exportId
				: (request.sourceInstanceId && request.sourceExportId
					? makeCanonicalTransferId(Number(request.sourceInstanceId), request.sourceExportId)
					: request.exportId);
			return await this.transferPlatform(exportId, resolved.id);
		} catch (err: unknown) {
			// transferPlatform's own try/catch self-heals its transmission failures, but a throw in its
			// PRE-transmit setup propagates here. On the auto-continuation path the source is already
			// locked-for-transfer, so roll it back rather than leave it stuck locked-and-hidden.
			const errMsg = getErrorMessage(err);
			this.logger.error(`Error transferring export ${request.exportId}: ${errMsg}`);
			const fallbackExportId = request.sourceInstanceId && request.sourceExportId
				? makeCanonicalTransferId(Number(request.sourceInstanceId), request.sourceExportId)
				: request.exportId;
			const stored = this.plugin.platformStorage.get(request.exportId) || this.plugin.platformStorage.get(fallbackExportId);
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
