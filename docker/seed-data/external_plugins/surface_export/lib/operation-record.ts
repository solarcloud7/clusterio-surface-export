
import type { ActiveTransfer, OperationOptions, OperationType } from "../messages";
import { generateOperationId } from "../helpers";

/**
 * Build an {@link ActiveTransfer} record with the canonical defaults/guards shared by
 * the controller (export/import operations) and the transfer orchestrator.
 *
 * This is a pure factory: it does NOT touch `activeTransfers` — callers are responsible
 * for inserting the returned record into their map (so the existing `activeTransfers.set`
 * ordering relative to logging is preserved at each call site).
 *
 * Instance-name resolution is injected via `options.resolveInstanceName` so this module
 * stays free of plugin/controller dependencies. When omitted, source/target instance
 * names fall back to `null` (matching callers that pass explicit names).
 */
export function createOperationRecord(
	operationType: OperationType,
	options: OperationOptions & { resolveInstanceName?: (instanceId: number) => string | null } = {},
): ActiveTransfer {
	const resolveInstanceName = options.resolveInstanceName ?? (() => null);
	const sourceInstanceId = Number.isInteger(Number(options.sourceInstanceId))
		? Number(options.sourceInstanceId)
		: -1;
	const targetInstanceId = Number.isInteger(Number(options.targetInstanceId))
		? Number(options.targetInstanceId)
		: -1;
	const operationId = String(options.operationId || generateOperationId(operationType));
	const sourceInstanceName = options.sourceInstanceName
		?? (sourceInstanceId > 0 ? resolveInstanceName(sourceInstanceId) : null);
	const targetInstanceName = options.targetInstanceName
		?? (targetInstanceId > 0 ? resolveInstanceName(targetInstanceId) : null);
	const operation: ActiveTransfer = {
		transferId: operationId,
		operationType,
		exportId: options.exportId || null,
		artifactSizeBytes: options.artifactSizeBytes ?? null,
		platformName: options.platformName || "Unknown",
		platformIndex: Number.isInteger(Number(options.platformIndex)) ? Number(options.platformIndex) : 1,
		forceName: options.forceName || "player",
		sourceInstanceId,
		sourceInstanceName,
		targetInstanceId,
		targetInstanceName,
		status: options.status || "in_progress",
		startedAt: options.startedAt || Date.now(),
		completedAt: options.completedAt || null,
		failedAt: options.failedAt || null,
		error: options.error || null,
	};
	return operation;
}
