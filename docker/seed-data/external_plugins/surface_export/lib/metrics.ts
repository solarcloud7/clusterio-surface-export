import * as lib from "@clusterio/lib";
import type { ActiveTransfer } from "../messages";

const TERMINAL_RESULT: Record<string, string> = {
	completed: "success",
	failed: "failure",
	error: "failure",
	cleanup_failed: "cleanup_failed",
};

const operationsTotal = new lib.Counter(
	"surface_export_operations_total",
	"Surface Export operations that reached a terminal state, labeled by operation type, result, and bounded failure stage.",
	{ labels: ["operation", "result", "failure_stage"] },
);

const operationDurationSeconds = new lib.Histogram(
	"surface_export_operation_duration_seconds",
	"Wall-clock duration of Surface Export operations from start to terminal state, in seconds.",
	{ labels: ["operation", "result", "failure_stage"], buckets: [0.5, 1, 2, 5, 10, 20, 40, 60, 120, 300] },
);

const entitiesTransferredTotal = new lib.Counter(
	"surface_export_entities_transferred_total",
	"Total entities created on the destination across successful Surface Export imports and transfers.",
	{ labels: ["operation"] },
);

const exportStallSeconds = new lib.Histogram(
	"surface_export_export_stall_seconds",
	"Source-side async export span in seconds (the tick-stall window that can drop a connected player), per operation.",
	{ labels: ["operation"], buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 60] },
);

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

export function recordOperationOutcome(operation: ActiveTransfer | null | undefined): void {
	if (!operation || operation.metricsRecorded) {
		return;
	}
	const result = TERMINAL_RESULT[operation.status];
	if (!result) {
		return;
	}
	operation.metricsRecorded = true;

	const operationLabel = operation.operationType || "unknown";
	const failureStage = operation.failedStage === "items" || operation.failedStage === "fluids" || operation.failedStage === "belts"
		? operation.failedStage : "none";
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

	const stallSeconds = exportStallSecondsValue(operation.exportMetrics);
	if (stallSeconds !== null) {
		exportStallSeconds.labels({ operation: operationLabel }).observe(stallSeconds);
	}
}
