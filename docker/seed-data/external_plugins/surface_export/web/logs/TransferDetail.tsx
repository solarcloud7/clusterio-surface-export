import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Collapse, Descriptions, Empty, Space, Spin, Table, Tabs, Tag, Tooltip, message as antMessage } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import type { JsonObject, LogDetail, SurfaceExportPlugin, TransferSummary } from "../view-models";
import { buildGanttRows, buildOperationCountRows, formatBytes, formatNumeric, getErrorMessage } from "../utils";
import { formatMs } from "../../shared/utils";
import { diagnosticReport, downloadJson, duration, evidence, record, route, terminal } from "./evidence";
import AuditTable, { auditLabel } from "./AuditTable";
import TimingTable from "./TimingTable";
import EntityAudit, { entityAuditLabel } from "./EntityAudit";
import type { OperationTiming } from "../../shared/timing";
import { useAccount } from "@clusterio/web_ui";
import { PERMISSIONS } from "../../messages";
import type { RestoreSnapshot } from "../ImportModal";
import { importableSnapshot } from "../../shared/snapshot";

export default function TransferDetail({ row, detail, loading, error, onRetry, plugin, preview = false, onRestore }: {
	row: TransferSummary; detail?: LogDetail; loading?: boolean; error?: string; onRetry?: () => void;
	plugin?: SurfaceExportPlugin; preview?: boolean;
	onRestore?: (snapshot: RestoreSnapshot) => void;
}) {
	const account = useAccount();
	const [restoring, setRestoring] = useState(false);
	const [activeTab, setActiveTab] = useState("overview"), [downloading, setDownloading] = useState(false);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (terminal(row.status)) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [row.status]);
	const model = useMemo(() => evidence(row, detail), [row, detail]);
	const flow = useMemo(() => buildGanttRows(model.retained ? detail?.events || [] : [], model.summary as JsonObject | null), [detail, model.summary, model.retained]);
	const elapsed = model.summary?.totalDurationMs ?? duration(row, now);
	const failure = model.validation.failedStage;
	const reason = row.error || model.summary?.error || model.validation.mismatchDetails;
	const failed = ["failed", "error"].includes(model.status);
	const failureTitle = model.operation === "import" ? "Import failed" : model.operation === "export" ? "Export failed" : "Transfer failed";
	const canDownload = !preview && !!plugin && !!row.downloadable && !!row.exportId;
	const unavailableReason = preview ? "Preview data has no downloadable platform."
		: "The stored platform export is no longer available for this operation.";
	const download = async () => {
		if (!canDownload || !plugin || !row.exportId) return;
		setDownloading(true);
		try {
			const response = await plugin.getStoredExport(row.exportId);
			if (!response.success) throw new Error(String(response.error || "Download failed"));
			downloadJson(response.exportData, `${String(row.platformName || "platform").replace(/[^\w-]+/g, "_")}.json`);
		} catch (err) { antMessage.error(getErrorMessage(err, "Download failed")); }
		finally { setDownloading(false); }
	};
	const canRestore = canDownload && row.restorable !== false && !!onRestore && account.hasPermission(PERMISSIONS.TRANSFER_EXPORTS)
		&& account.hasPermission(PERMISSIONS.LIST_EXPORTS);
	const restore = async () => {
		if (!canRestore || !plugin || !row.exportId || !onRestore) return;
		setRestoring(true);
		try {
			const response = await plugin.getStoredExport(row.exportId);
			if (!response.success || !response.exportData || !Number.isFinite(response.timestamp)) {
				throw new Error(String(response.error || "An importable snapshot is unavailable."));
			}
			importableSnapshot(response.exportData);
			onRestore({ exportId: row.exportId, timestamp: Number(response.timestamp),
				platformName: String(response.platformName || row.platformName), exportData: response.exportData as JsonObject });
		} catch (err) { antMessage.error(getErrorMessage(err, "Snapshot unavailable")); }
		finally { setRestoring(false); }
	};
	const overview = <>
		<div className="se-audit-cards">
			<button className={`se-audit-card se-audit-${model.entities.state}`} onClick={() => setActiveTab("entities")}>
				<span className="se-card-eyebrow">Entity audit</span><strong>{entityAuditLabel(model.entities.state)}</strong>
				<span>{model.entities.failedStage ? `Failed stage: ${model.entities.failedStage}`
					: model.entities.census === null ? "Count not recorded" : `${formatNumeric(model.entities.census, 0)} in destination count`}</span>
				<small>Structure and placement · Inspect entities →</small>
			</button>
			{(["items", "fluids"] as const).map(kind => {
			const audit = model[kind];
			const count = (value: number | null) => value === null ? "Not recorded" : formatNumeric(value, kind === "items" ? 0 : 4);
			return <button key={kind} className={`se-audit-card se-audit-${audit.state}`} onClick={() => setActiveTab(kind)}>
				<span className="se-card-eyebrow">{kind === "items" ? "Item audit" : "Fluid audit"}</span>
				<strong>{auditLabel(audit.state)}{kind === "fluids" && model.reconciled ? " · Reconciled" : ""}</strong>
				<span>{count(audit.expectedTotal)} <span className="se-muted">→</span> {count(audit.actualTotal)}</span>
				<small>{audit.types === null ? "Key count unavailable" : `${audit.types} recorded keys`} · Inspect {kind} →</small>
			</button>;
		})}</div>
		<p className="se-muted">Entity restoration and cargo checks are separate. Equal item and fluid totals do not prove that belt structure or entity state was restored.</p>
		<div className="se-section-heading"><h3>Recorded stage timings</h3><Button type="link" onClick={() => setActiveTab("timing")}>View every recorded step</Button></div>
		<TimingTable timing={model.summary?.timing as OperationTiming | undefined} rows={flow.rows} attribution={flow.attribution} compact />
	</>;
	const metrics = buildOperationCountRows(record(model.summary?.export), record(model.summary?.import));
	const technical = <>
		<Descriptions size="small" column={1} bordered items={[
			{ key: "id", label: "Operation ID", children: row.transferId },
			{ key: "size", label: "Stored export size", children: row.artifactSizeBytes == null ? "Not recorded" : formatBytes(row.artifactSizeBytes) },
			{ key: "retention", label: "Detail retention", children: !detail ? "Unavailable" : model.retained ? "Retained" : "Expired; summary only" },
		]} />
		{model.validation.inventoryOverflowLosses != null && <Alert type="warning" message="Inventory overflow exclusions recorded" description="The audit may exclude items recorded as overflow loss. Inspect the validation evidence below for exact quantities and affected entities." />}
		{model.validation.forceDataMismatches != null && <Alert type="info" message="Force bonus comparison recorded" description="Inspect the validation evidence for force bonuses and any adjustments." />}
		{record(model.validation.failureBlackBox).file != null && <p>Server diagnostic reference: <code>{String(record(model.validation.failureBlackBox).file)}</code>. This reference is not a downloadable browser file.</p>}
		{metrics.length > 0 && <Table size="small" pagination={false} rowKey="key" dataSource={metrics} columns={[
			{ title: "Operation metric", dataIndex: "metric", key: "metric" }, { title: "Value", dataIndex: "value", key: "value" },
		]} />}
		<Collapse items={[
			{ key: "validation", label: "Validation evidence and entity breakdown", children: <pre>{JSON.stringify(model.validation, null, 2)}</pre> },
			{ key: "summary", label: "Recorded summary and metrics", children: <pre>{JSON.stringify(detail?.summary ?? null, null, 2)}</pre> },
			{ key: "events", label: `Event history (${detail?.events.length || 0})`, children: <pre>{JSON.stringify(detail?.events ?? [], null, 2)}</pre> },
		]} />
	</>;
	return <section className="se-transfer-detail" data-testid="transfer-detail" aria-label="Selected operation">
		<header className="se-detail-header">
			<Space wrap><Tag>{model.operation}</Tag>{preview && <Tag color="purple">Preview</Tag>}{model.isTest && <Tag color="gold">Intentional test</Tag>}</Space>
			<h2>{row.platformName || "Unnamed platform"}</h2><p className="se-route">{route(row)}</p>
			<Alert className="se-operation-outcome" data-testid="operation-outcome" showIcon
				type={model.tone as "info" | "success" | "error"} message={failed ? failureTitle : model.outcome}
				description={<>
					{!terminal(row.status) && row.jobObservation && <div role="status" data-testid="job-observation">
						<strong>{row.jobObservation.message}</strong>
						{row.jobObservation.phase && <span> · {row.jobObservation.phase}</span>}
						{row.jobObservation.observedTick != null && <div className="se-muted">Observed at simulation tick {row.jobObservation.observedTick}.</div>}
					</div>}
					{failure != null && <div className="se-outcome-stage">Failed stage: <strong>{String(failure)}</strong></div>}
					{reason && <div>{String(reason)}</div>}
					{model.entities.failure && <Button className="se-outcome-inspect" size="small" onClick={() => setActiveTab("entities")}>Inspect entity evidence</Button>}
					{(model.recoveryText || failed) && <div className="se-outcome-recovery">
						<span className="se-card-eyebrow">Recovery</span><strong>{model.recoveryText || "Recovery not confirmed"}</strong>
						<span className="se-muted">Audit evidence below describes the destination attempt, before recovery.</span>
					</div>}
					{model.status === "cleanup_failed" && <div>Inspect recorded events for arrival, discard, and cleanup outcomes.</div>}
				</>} />
			<div className="se-detail-meta"><span>{terminal(row.status) ? "Duration" : "Elapsed"}: <strong>{elapsed == null ? "Not recorded" : formatMs(elapsed) || "0 ms"}</strong></span>
				<span>Started: {row.startedAt == null ? "Not recorded" : new Date(row.startedAt).toLocaleString()}</span>
				{row.completedAt != null && <span>Completed: {new Date(row.completedAt).toLocaleString()}</span>}</div>
			<Space wrap><Tooltip title={canDownload ? "Download the stored platform export" : unavailableReason}><span><Button icon={<DownloadOutlined />} disabled={!canDownload} loading={downloading} onClick={download}>Download platform</Button></span></Tooltip>
				<Tooltip title={canRestore ? "Create a new import from this snapshot" : row.restoreUnavailableReason || (canDownload ? "Restoration requires permission to list and transfer exports." : unavailableReason)}><span>
					<Button disabled={!canRestore} loading={restoring} onClick={restore}>Restore from snapshot</Button>
				</span></Tooltip>
				<Button onClick={() => downloadJson(diagnosticReport(row, detail, preview), `transfer-${row.transferId.replace(/[^\w-]+/g, "_")}.json`)}>Download diagnostic report</Button></Space>
		</header>
		{loading && !detail ? <div className="se-loading" role="status"><Spin /><p>Loading recorded evidence…</p></div> : error ?
			<Alert type="error" showIcon message="Could not load operation details" description={error} action={<Button onClick={onRetry}>Retry</Button>} /> : <>
			{detail?.detailRetained === false && <Alert type="info" showIcon message="Detailed evidence has expired" description="The operation summary remains available. Timing and cargo measurements are no longer retained; you can still download a summary report." />}
			{!detail && <Empty description="Detailed evidence is unavailable" />}
			<Tabs activeKey={activeTab} onChange={setActiveTab} items={[
				{ key: "overview", label: "Overview", children: overview },
				{ key: "timing", label: "Timing", children: <><p className="se-muted">{String(detail?.summary?.timingBoundary || "Historical controller observation; precise boundaries may be unavailable.")}</p><TimingTable timing={model.summary?.timing as OperationTiming | undefined} rows={flow.rows} attribution={flow.attribution} /></> },
				{ key: "items", label: "Items", children: <AuditTable model={model} kind="items" /> },
				{ key: "entities", label: "Entities", children: <EntityAudit model={model} /> },
				{ key: "fluids", label: "Fluids", children: <AuditTable model={model} kind="fluids" /> },
				{ key: "technical", label: "Technical details", children: technical },
			]} />
		</>}
	</section>;
}
