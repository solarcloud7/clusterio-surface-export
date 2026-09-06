import type { JsonObject, LogDetail, TransferSummary } from "../view-models";
import { buildDetailedLogSummary, buildExpectedActualRows } from "../utils";

export function record(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
export function countMap(value: unknown): Record<string, number> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const entries = Object.entries(value);
	return entries.every(([, n]) => typeof n === "number" && Number.isFinite(n) && n >= 0)
		? Object.fromEntries(entries) as Record<string, number> : null;
}
export const terminal = (status?: string) => ["completed", "failed", "error", "cleanup_failed"].includes(status || "");
export const outcomeGroup = (status?: string) => status === "completed" ? "completed"
	: ["failed", "error", "cleanup_failed"].includes(status || "") ? "attention" : "active";
export const statusLabel = (status?: string) => ({
	completed: "Completed", failed: "Failed", error: "Error", cleanup_failed: "Cleanup needs attention",
	transporting: "In transit", awaiting_validation: "Validating", awaiting_completion: "Finishing", in_progress: "In progress",
}[status || ""] || status || "Unknown");

export function route(row: TransferSummary): string {
	const instance = (name?: string | null, id?: number) => name || (id != null && id >= 0 ? `Instance ${id}` : "Unknown instance");
	if (row.operationType === "import") return `Uploaded file → ${instance(row.targetInstanceName, row.targetInstanceId)}`;
	if (row.operationType === "export") return `${instance(row.sourceInstanceName, row.sourceInstanceId)} → Stored export`;
	return `${instance(row.sourceInstanceName, row.sourceInstanceId)} → ${instance(row.targetInstanceName, row.targetInstanceId)}`;
}
export function duration(row: TransferSummary, now: number): number | null {
	const end = row.completedAt ?? row.failedAt ?? (terminal(row.status) ? row.lastEventAt : now);
	return row.startedAt != null && end != null ? Math.max(0, end - row.startedAt) : null;
}

export function evidence(row: TransferSummary, detail?: LogDetail) {
	const retained = detail?.detailRetained !== false;
	const summary = detail && retained ? buildDetailedLogSummary(detail as unknown as JsonObject, row.transferId) : null;
	const validation = record(summary?.validation);
	const rawSummary = record(detail?.summary);
	const created = detail?.events.find(event => event.eventType === "transfer_created");
	// Do not use the summary builder's empty-map fallback: missing measurements are not zeros.
	const source = record(rawSummary.sourceVerification ?? created?.sourceVerification);
	const status = row.status || String(summary?.status || "unknown");
	const operation = row.operationType || summary?.operationType || "transfer";
	const audit = (kind: "Item" | "Fluid") => {
		const expected = countMap(validation[`expected${kind}Counts`] ?? source[kind === "Item" ? "itemCounts" : "fluidCounts"]);
		const actual = countMap(validation[`actual${kind}Counts`]);
		const verdict = retained ? validation[kind === "Item" ? "itemCountMatch" : "fluidCountMatch"] : undefined;
		const state = operation === "export" ? "not-applicable" : verdict === false ? "mismatch" : verdict === true ? "passed"
			: !terminal(status) ? "pending" : "unavailable";
		const rows = expected && actual ? buildExpectedActualRows(expected, actual) : [];
		return { expected, actual, rows, state,
			available: expected !== null && actual !== null && retained,
			expectedTotal: expected ? Object.values(expected).reduce((a, b) => a + b, 0) : null,
			actualTotal: actual ? Object.values(actual).reduce((a, b) => a + b, 0) : null,
			types: expected && actual ? new Set([...Object.keys(expected), ...Object.keys(actual)]).size : null,
		};
	};
	const items = audit("Item"), fluids = audit("Fluid");
	const events = retained ? detail?.events || [] : [];
	const recovery = [...events].reverse().find(event => ["rollback_success", "rollback_failed", "rollback_attempt"].includes(String(event.eventType)));
	const recoveryText = recovery?.eventType === "rollback_success" ? "Rollback succeeded"
		: recovery?.eventType === "rollback_failed" ? "Rollback failed — attention required"
			: recovery?.eventType === "rollback_attempt" ? "Rollback attempted; outcome not recorded" : null;
	const verified = validation.success === true && items.state === "passed" && fluids.state === "passed";
	const verb = operation === "import" ? "Imported" : "Arrived";
	const outcome = status === "cleanup_failed" ? "Cleanup needs attention"
		: ["failed", "error"].includes(status) ? `Failed${recoveryText ? `; ${recoveryText.toLowerCase()}` : "; recovery not confirmed"}`
			: status === "completed" ? operation === "export" ? "Export stored"
				: verified ? `${verb} and verified` : validation.success === false || items.state === "mismatch" || fluids.state === "mismatch"
					? "Completed; audit reported a failure" : "Completed; audit evidence unavailable"
				: statusLabel(status);
	const tone = ["failed", "error", "cleanup_failed"].includes(status) || (status === "completed" && validation.success === false)
		|| items.state === "mismatch" || fluids.state === "mismatch" ? "error"
		: status === "completed" && (verified || operation === "export") ? "success" : "info";
	const reconciliation = record(validation.fluidReconciliation);
	const aggregates = record(reconciliation.highTempAggregates ?? validation.highTempAggregates);
	// Display the recorded reconciliation verdict, never infer it from a similar total.
	const measured = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
	const fluidRows = Object.entries(aggregates).map(([name, value]) => {
		const aggregate = record(value), expected = measured(aggregate.expectedEnergy), actual = measured(aggregate.actualEnergy);
		return { key: `thermal:${name}`, name, expected, actual, delta: expected !== null && actual !== null ? actual - expected : null,
			tempDisplay: "Recorded high-temperature aggregate", isThermalSummary: true,
			status: aggregate.reconciled === true ? "Reconciled" : aggregate.reconciled === false ? "Not reconciled" : "Verdict unavailable",
			reconciled: aggregate.reconciled === true, category: "Thermal" };
	});
	return { summary, validation, retained, status, operation, items, fluids, fluidRows, outcome, tone, recoveryText,
		isTest: validation.testForcedFailure === true || validation.testForcedEntityFailure === true,
		reconciled: Object.values(aggregates).some(value => record(value).reconciled === true),
	};
}
export type Evidence = ReturnType<typeof evidence>;
export type Audit = Evidence["items"];

export function diagnosticReport(row: TransferSummary, detail?: LogDetail, preview = false) {
	return { schemaVersion: 1, exportedAt: new Date().toISOString(), transferId: row.transferId, preview,
		detailRetention: !detail ? "unavailable" : detail.detailRetained === false ? "summary-only" : "retained",
		operation: row, transferInfo: detail?.transferInfo ?? null, summary: detail?.summary ?? null, events: detail?.events ?? [] };
}
export function downloadJson(value: unknown, filename: string) {
	const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
	const link = document.createElement("a");
	link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
