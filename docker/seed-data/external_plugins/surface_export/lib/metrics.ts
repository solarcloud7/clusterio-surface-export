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
	// A platform was LEFT BEHIND that automation could not remove: a committed transfer whose source
	// delete failed (a DUPLICATE exists until the source is removed), or a failed transfer whose
	// destination discard was refused by the engine (an ORPHAN exists on the target). The error text
	// on the transfer says which. Deliberately NOT emitted for a failed source unlock — the
	// source-side TTL self-heals that, nothing is left behind (owner ruling 2026-08-02).
	//
	// TWO SERIES NOTES from that ruling's deploy: (1) failed-unlock transfers moved from this bucket
	// into result="failure", so both series step at the deploy; (2) a transfer REFUSED by the
	// offline-destination preflight creates no ActiveTransfer at all, so the refusal produces NO
	// sample in any bucket — "destination offline" is visible in logs and to the player, not here.
	cleanup_failed: "cleanup_failed",
};

/** Operations that reached a terminal state, by operation type and result. The headline metric. */
const operationsTotal = new lib.Counter(
	"surface_export_operations_total",
	"Surface Export operations that reached a terminal state, labeled by operation type, result, and bounded failure stage.",
	{ labels: ["operation", "result", "failure_stage"] },
);

/**
 * End-to-end wall-clock duration of an operation, in seconds. Buckets span sub-second export prep
 * through multi-minute large-platform transfers (RCON throughput is the bottleneck — ~40s for 235KB).
 */
const operationDurationSeconds = new lib.Histogram(
	"surface_export_operation_duration_seconds",
	"Wall-clock duration of Surface Export operations from start to terminal state, in seconds.",
	{ labels: ["operation", "result", "failure_stage"], buckets: [0.5, 1, 2, 5, 10, 20, 40, 60, 120, 300] },
);

/**
 * Entities placed on the destination across successful imports/transfers (throughput).
 *
 * SERIES BREAK at plugin 0.10.211. This counter sums `importMetrics.entities_created`, and that
 * field changed meaning in the same deploy: it used to be the size of `job.entity_map` (an
 * ADDRESSABILITY index — entities needing later state/inventory restoration), and it is now the
 * measured per-batch placement tally from entity_creation.lua.
 *
 * Ground items are placed without ever being mapped, so the new value is strictly HIGHER than the
 * old one for the same platform — on the transfer that motivated the fix, by 106. The rate is
 * therefore discontinuous at the deploy timestamp: a step up in this series is a definition change,
 * not a throughput change. Do not compare across it without saying so. (The old field also
 * populated `entities_failed` as `total_entities - entities_created`, which is why it read 106
 * placement failures on a transfer that placed everything at exact item parity.)
 */
const entitiesTransferredTotal = new lib.Counter(
	"surface_export_entities_transferred_total",
	"Total entities created on the destination across successful Surface Export imports and transfers.",
	{ labels: ["operation"] },
);

/**
 * Source-side async export span, in seconds — the "export tick-stall" that can heartbeat-drop a connected
 * player (task #86: a player aboard a transferring platform is dropped during this window). Recorded for
 * operations that did a source export (transfer + export); import-only operations have no source export.
 * Buckets span a small platform (~0.5s) to a large one (~40s, RCON-bound). Diagnoses #86 from /metrics.
 */
const exportStallSeconds = new lib.Histogram(
	"surface_export_export_stall_seconds",
	"Source-side async export span in seconds (the tick-stall window that can drop a connected player), per operation.",
	{ labels: ["operation"], buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 60] },
);

/**
 * Extract the source-side async export span (seconds) from an operation's export metrics, or null when
 * absent (import-only ops, or metrics not yet populated). normalizeExportMetrics derives
 * `instanceAsyncExportMs` from the async export tick count, so it is the most reliably present field.
 */
function exportStallSecondsValue(exportMetrics: unknown): number | null {
	if (!exportMetrics || typeof exportMetrics !== "object") {
		return null;
	}
	const m = exportMetrics as Record<string, unknown>;
	const ms = Number(m.instanceAsyncExportMs);
	if (Number.isFinite(ms) && ms >= 0) {
		return ms / 1000;
	}
	const sec = Number(m.instanceAsyncExportSeconds);
	if (Number.isFinite(sec) && sec >= 0) {
		return sec;
	}
	return null;
}

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
	const failureStage = operation.failedStage === "items" || operation.failedStage === "fluids" ? operation.failedStage : "none";
	operationsTotal.labels({ operation: operationLabel, result, failure_stage: failureStage }).inc();

	const endMs = operation.completedAt || operation.failedAt || Date.now();
	const durationSec = (endMs - operation.startedAt) / 1000;
	if (Number.isFinite(durationSec) && durationSec >= 0) {
		operationDurationSeconds.labels({ operation: operationLabel, result, failure_stage: failureStage }).observe(durationSec);
	}

	const entitiesCreated = Number(operation.importMetrics?.entities_created);
	if (result === "success" && Number.isFinite(entitiesCreated) && entitiesCreated > 0) {
		entitiesTransferredTotal.labels({ operation: operationLabel }).inc(entitiesCreated);
	}

	// Source-side export stall — recorded regardless of result: a stall happens on every source export, and
	// #86's failure mode is a transfer that SUCCEEDS end-to-end but drops the connected player mid-stall.
	const stallSeconds = exportStallSecondsValue(operation.exportMetrics);
	if (stallSeconds !== null) {
		exportStallSeconds.labels({ operation: operationLabel }).observe(stallSeconds);
	}
}
