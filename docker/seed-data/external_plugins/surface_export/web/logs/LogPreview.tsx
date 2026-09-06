import React, { useMemo, useState } from "react";
import { Alert, Button, Modal, Select } from "antd";
import type { JsonObject, LogDetail, TransferSummary } from "../view-models";
import recorded from "./recorded-fixtures";
import TransferDetail from "./TransferDetail";
import measuredTiming from "./timing-fixture";

const options = [
	["profiling", "Recorded profiling sample"], ["tick-only", "Ticks with missing profiler output"],
	["success", "Recorded success"], ["failure", "Recorded failure and rollback"],
	["unconfirmed", "Failure, recovery unknown"], ["cleanup", "Cleanup needs attention"],
	["pending", "Validation pending"], ["missing", "Missing audit evidence"],
	["equal", "Equal totals, failed gate"], ["reconciled", "Thermally reconciled fluids"],
	["expired", "Expired details"], ["export", "Standalone export"], ["import", "Standalone import"],
	["error", "Retryable load error"], ["loading", "Loading details"],
].map(([value, label]) => ({ value, label }));

function scenario(name: string): { row: TransferSummary; detail: LogDetail } {
	const data = structuredClone(name === "failure" || name === "unconfirmed" ? recorded.failure : recorded.success) as unknown as { row: TransferSummary; detail: LogDetail };
	const { row, detail } = data;
	const summary = detail.summary!;
	const validation = summary.validation as JsonObject;
	if (name === "profiling" || name === "tick-only") {
		row.platformName = "Timing sample"; row.observedDurationMs = name === "profiling" ? 1428.17746 : null;
		row.startedAt = summary.startedAt = 1788729734413;
		row.completedAt = summary.completedAt = name === "profiling" ? 1788729735841 : null;
		detail.events = []; summary.validation = null; summary.export = null; summary.import = null;
		summary.totalDurationMs = row.observedDurationMs; summary.totalDurationStr = null;
		summary.timing = structuredClone(measuredTiming) as unknown as JsonObject;
		summary.timingBoundary = "Recorded local-clock measurements. Audit evidence is omitted from this timing-only sample.";
		if (name === "tick-only") summary.timing = { v: 1, records: [{
			...measuredTiming.records.find(record => record.owner === "source-lua" && record.stage === "entities")!,
			startMs: null, endMs: null, executionMs: null, status: "interrupted", error: "Profiler output unavailable",
		}] } as unknown as JsonObject;
	}
	if (name === "unconfirmed") detail.events = detail.events.filter(event => !String(event.eventType).startsWith("rollback_"));
	if (name === "cleanup") { row.status = "cleanup_failed"; row.error = "Destination discard did not complete"; }
	if (name === "pending") {
		row.status = "awaiting_validation"; row.startedAt = Date.now() - 3000; row.completedAt = null;
		detail.events = []; delete summary.validation; delete summary.phases; delete summary.import;
		summary.startedAt = row.startedAt; summary.completedAt = null; summary.totalDurationMs = null;
	}
	if (name === "missing") { delete summary.validation; detail.events = []; }
	if (name === "equal") {
		validation.itemCountMatch = false; validation.success = false;
		validation.expectedItemCounts = { coal: 60 }; validation.actualItemCounts = { "iron-plate": 60 };
	}
	if (name === "reconciled") {
		validation.expectedFluidCounts = { "fusion-plasma@1000000C": 100 };
		validation.actualFluidCounts = { "fusion-plasma@999999C": 100.0001 };
		validation.fluidReconciliation = { highTempThreshold: 10000, highTempAggregates: {
			"fusion-plasma": { reconciled: true, expectedEnergy: 100000000, actualEnergy: 99999999.9999 },
		} };
	}
	if (name === "export" || name === "import") {
		row.operationType = name;
		if (name === "export") { detail.events = []; delete summary.validation; }
	}
	if (name === "expired") { detail.detailRetained = false; detail.summary = null; detail.events = []; }
	summary.status = row.status; summary.operationType = row.operationType;
	detail.transferInfo = { ...row };
	return data;
}

export default function LogPreview({ onClose }: { onClose: () => void }) {
	const [selected, setSelected] = useState("success"), [revision, setRevision] = useState(0), [retried, setRetried] = useState(false);
	const fixture = useMemo(() => scenario(selected), [selected]);
	const detail = useMemo(() => ({ ...fixture.detail, events: [...fixture.detail.events,
		...(fixture.detail.detailRetained === false ? [] : Array.from({ length: revision }, (_, index) => ({ eventType: "preview_update", message: `Preview update ${index + 1}` })))] }), [fixture, revision]);
	return <Modal open title="Transfer log preview" onCancel={onClose} footer={null} width={1200} style={{ top: 24 }} className="se-log-preview">
		<div data-testid="log-preview"><Alert type="info" showIcon message="Isolated preview — no operations are performed"
			description="Success and rollback use sanitized records captured from the local cluster. Other scenarios are constructed display cases. This uses the same detail view as live history." />
			<div className="se-preview-controls"><Select aria-label="Preview scenario" style={{ width: 280 }} value={selected} options={options}
				onChange={value => { setSelected(value); setRevision(0); setRetried(false); }} />
				<Button onClick={() => setRevision(value => value + 1)}>Replay detail update</Button></div>
			<TransferDetail row={fixture.row} detail={selected === "loading" || (selected === "error" && !retried) ? undefined : detail}
				loading={selected === "loading"} error={selected === "error" && !retried ? "Simulated connection failure" : undefined}
				onRetry={() => setRetried(true)} preview />
		</div>
	</Modal>;
}
