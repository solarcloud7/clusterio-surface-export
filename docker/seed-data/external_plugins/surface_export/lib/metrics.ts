/**
 * @file lib/metrics.ts
 * @description Prometheus collectors for Surface Export operations.
 *
 * Collectors register to Clusterio's default registry on import, so they surface on the controller's
 * live /metrics endpoint (controller :8080) with no extra wiring — the same endpoint that already
 * exposes the core `clusterio_*` metrics. `recordOperationOutcome()` is the single recording hook,
 * called from `SubscriptionManager.emitTransferUpdate` (the universal "operation changed" chokepoint
 * every terminal transfer/export/import passes through), so each operation is counted exactly once.
 *
 * This is the "real fix" for plugin observability noted in CLAUDE.md — transfer success/fail counts
 * and durations — replacing log-grepping as the only way to see how transfers are faring.
 */

import * as lib from "@clusterio/lib";
import type { ActiveTransfer } from "../messages";

/** Map a terminal `ActiveTransfer.status` to the `result` metric label. Non-terminal statuses → undefined. */
const TERMINAL_RESULT: Record<string, string> = {
	completed: "success",
	failed: "failure",
	error: "failure",
	cleanup_failed: "cleanup_failed", // import landed on destination but source platform delete failed
};

/** Operations that reached a terminal state, by operation type and result. The headline metric. */
const operationsTotal = new lib.Counter(
	"surface_export_operations_total",
	"Surface Export operations that reached a terminal state, labeled by operation type and result.",
	{ labels: ["operation", "result"] },
);

/**
 * End-to-end wall-clock duration of an operation, in seconds. Buckets span sub-second export prep
 * through multi-minute large-platform transfers (RCON throughput is the bottleneck — ~40s for 235KB).
 */
const operationDurationSeconds = new lib.Histogram(
	"surface_export_operation_duration_seconds",
	"Wall-clock duration of Surface Export operations from start to terminal state, in seconds.",
	{ labels: ["operation", "result"], buckets: [0.5, 1, 2, 5, 10, 20, 40, 60, 120, 300] },
);

/** Entities placed on the destination across successful imports/transfers (throughput). */
const entitiesTransferredTotal = new lib.Counter(
	"surface_export_entities_transferred_total",
	"Total entities created on the destination across successful Surface Export imports and transfers.",
	{ labels: ["operation"] },
);

/**
 * Record terminal Prometheus metrics for an operation. Idempotent: the first terminal call stamps
 * `operation.metricsRecorded` and later calls no-op, so this is safe to call on every operation
 * update — it also no-ops while the operation is still in a non-terminal state.
 *
 * @param operation - the ActiveTransfer whose current status to (maybe) record.
 */
export function recordOperationOutcome(operation: ActiveTransfer | null | undefined): void {
	if (!operation || operation.metricsRecorded) {
		return;
	}
	const result = TERMINAL_RESULT[operation.status];
	if (!result) {
		return; // still in flight — nothing terminal to record yet
	}
	operation.metricsRecorded = true;

	const operationLabel = operation.operationType || "unknown";
	operationsTotal.labels({ operation: operationLabel, result }).inc();

	const endMs = operation.completedAt || operation.failedAt || Date.now();
	const durationSec = (endMs - operation.startedAt) / 1000;
	if (Number.isFinite(durationSec) && durationSec >= 0) {
		operationDurationSeconds.labels({ operation: operationLabel, result }).observe(durationSec);
	}

	const entitiesCreated = Number(operation.importMetrics?.entities_created);
	if (result === "success" && Number.isFinite(entitiesCreated) && entitiesCreated > 0) {
		entitiesTransferredTotal.labels({ operation: operationLabel }).inc(entitiesCreated);
	}
}
