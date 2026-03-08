import React, { useMemo, useState, useEffect, useRef } from "react";
import { useEntityMetadata } from "@clusterio/web_ui";
import {
	Alert,
	Button,
	Card,
	Empty,
	Space,
	Spin,
	Table,
	Tabs,
	Tag,
	Tooltip,
	Typography,
	message as antMessage,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { InfoCircleOutlined, DownloadOutlined } from "@ant-design/icons";
import {
	statusColor,
	humanizeMetricKey,
	formatNumeric,
	formatSigned,
	formatCompactEnergy,
	formatBytes,
	buildOperationCountRows,
	buildExpectedActualRows,
	buildFluidInventoryRows,
	buildDetailedLogSummary,
	getErrorMessage,
type ExpectedActualRow,
type FluidInventoryRow,
type MetricRow,
} from "./utils";
import type { JsonObject, LogEvent, SurfaceExportPlugin, SurfaceExportState, TransferSummary } from "./types";

const { Text } = Typography;

type MermaidApi = {
	initialize: (config: Record<string, unknown>) => void;
	render: (id: string, text: string) => Promise<{ svg: string }>;
};

let _mermaidPromise: Promise<MermaidApi> | null = null;
function getMermaid() {
	if (!_mermaidPromise) {
		_mermaidPromise = import("mermaid").then(m => {
			m.default.initialize({ startOnLoad: false, theme: "dark", themeVariables: { background: "transparent" } });
			return m.default as MermaidApi;
		}).catch(err => {
			_mermaidPromise = null;
			throw err;
		});
	}
	return _mermaidPromise;
}

function formatMsLabel(ms: number | null) {
	if (ms == null) return "";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function buildMermaidGanttText(rows: Array<JsonObject>, totalMs: number) {
	if (!rows || rows.length === 0 || totalMs <= 0) return null;
	let axisFormat;
	if (totalMs < 1000) {
		axisFormat = "%L";
	} else if (totalMs < 60000) {
		axisFormat = "%Ss";
	} else {
		axisFormat = "%M:%S";
	}
	const eventRows: string[] = [];
	const exportRows: string[] = [];
	const importRows: string[] = [];
	const transferRows: string[] = [];
	let taskIdx = 0, milestoneIdx = 0;
	for (const row of rows) {
		const start = Math.max(0, Math.round(row.startMs));
		const end = Math.max(start + 1, Math.round(row.endMs));
		const durationSuffix = row.durationMs != null ? " (" + formatMsLabel(row.durationMs) + ")" : "";
		const safeName = row.label.replace(/[:\[\];#]/g, " ").trim() + durationSuffix;
		if (row.isEvent) {
			eventRows.push("    " + safeName + " :milestone, m" + milestoneIdx++ + ", " + start + ", 0");
		} else if (row.key.startsWith("export:")) {
			exportRows.push("    " + safeName + " :active, t" + taskIdx++ + ", " + start + ", " + end);
		} else if (row.key.startsWith("import:")) {
			importRows.push("    " + safeName + " :active, t" + taskIdx++ + ", " + start + ", " + end);
		} else if (row.key.startsWith("phase:")) {
			transferRows.push("    " + safeName + " :active, t" + taskIdx++ + ", " + start + ", " + end);
		}
	}
	const lines = ["gantt", "    dateFormat x", "    axisFormat " + axisFormat, "    title Transfer Timeline"];
	if (eventRows.length)    { lines.push("    section Events");   lines.push(...eventRows); }
	if (exportRows.length)   { lines.push("    section Export");   lines.push(...exportRows); }
	if (importRows.length)   { lines.push("    section Import");   lines.push(...importRows); }
	if (transferRows.length) { lines.push("    section Transfer"); lines.push(...transferRows); }
	return lines.join("\n");
}

function buildGanttRows(events: Array<LogEvent>, detailedSummary: JsonObject | null) {
	// Produce one row per named phase across all events.
	// Each row: { key, label, isEvent, indent, startMs, endMs, durationMs, color }
	// All times are absolute ms from transfer start (elapsedMs of first event = 0).
	const rows: Array<JsonObject> = [];
	let totalMs = 0;

	for (const event of events || []) {
		const elapsedMs = typeof event?.elapsedMs === "number" ? event.elapsedMs : null;
		const isFailure = String(event?.eventType || "").includes("failed") || String(event?.eventType || "").includes("error");
		const isSuccess = String(event?.eventType || "").includes("completed") || String(event?.eventType || "").includes("success");
		const color = isFailure ? "red" : isSuccess ? "green" : "blue";

		// Event anchor row (marker only, no duration bar)
		rows.push({ key: `event:${event?.eventType}:${elapsedMs}`, label: event?.eventType || "event",
			isEvent: true, indent: 0, startMs: elapsedMs ?? 0, endMs: elapsedMs ?? 0,
			durationMs: null, color });
		if (elapsedMs !== null) totalMs = Math.max(totalMs, elapsedMs);

		// Export sub-phases (on transfer_created)
		// These phases all ENDED at transfer_created — place them backward from eventStart.
		// Sequential order: [lock (includes async export)] → [wait for store] → transfer_created marker.
		// instanceAsyncExportMs is a sub-component of requestExportAndLockMs (async export runs
		// inside the lock RTT), shown as an indented sub-bar at the end of the lock phase.
		const exportMetrics = event?.exportMetrics
			|| (event?.eventType === "transfer_created" ? detailedSummary?.export || null : null);
		if (exportMetrics && typeof exportMetrics === "object") {
			const eventStart = elapsedMs ?? 0;
			const lockMs = Number(exportMetrics.requestExportAndLockMs ?? 0);
			const storeMs = Number(exportMetrics.waitForControllerStoreMs ?? 0);
			const asyncMs = Number(exportMetrics.instanceAsyncExportMs ?? 0);
			const ticks = Number(exportMetrics.instanceAsyncExportTicks ?? 0);
			// storeMs ends at eventStart; lockMs ends where storeMs begins.
			const lockEnd = eventStart - storeMs;
			const lockStart = lockEnd - lockMs;
			// Controller prep fills the gap from t=0 to lockStart, anchoring the chart origin.
			if (lockStart > 1) {
				rows.push({ key: `export:prep:${eventStart}`, label: "Controller prep",
					isEvent: false, indent: 1, startMs: 0, endMs: lockStart,
					durationMs: lockStart, color: "blue" });
			}
			if (lockMs > 0) {
				// Split lock into sequential non-overlapping bars: RCON overhead → async export
				const overheadMs = asyncMs > 0 ? Math.max(0, lockMs - asyncMs) : lockMs;
				const asyncStart = lockStart + overheadMs;
				if (overheadMs > 0) {
					rows.push({ key: `export:queue:${eventStart}`, label: "Queue + RCON",
						isEvent: false, indent: 1, startMs: lockStart, endMs: asyncStart,
						durationMs: overheadMs, color: "blue" });
				}
				if (asyncMs > 0) {
					const asyncLabel = ticks > 0 ? `Async export (${ticks.toLocaleString()} ticks)` : "Async export";
					rows.push({ key: `export:async:${eventStart}`, label: asyncLabel,
						isEvent: false, indent: 1, startMs: asyncStart, endMs: lockEnd,
						durationMs: asyncMs, color: "blue" });
				}
				totalMs = Math.max(totalMs, lockEnd);
			}
			if (storeMs > 0) {
				rows.push({ key: `export:store:${eventStart}`, label: "Wait for store",
					isEvent: false, indent: 1, startMs: lockEnd, endMs: eventStart,
					durationMs: storeMs, color: "blue" });
				totalMs = Math.max(totalMs, eventStart);
			}
		}

		// Import sub-phases — sequential flat bars (tiles → entities → fluids)
		if (event?.importMetrics && typeof event.importMetrics === "object") {
			const m = event.importMetrics;
			const eventStart = elapsedMs ?? 0;
			const tilesMs = Number(m.tiles_ms ?? 0);
			const tilesCount = Number(m.tiles_placed ?? 0);
			const entitiesMs = Number(m.entities_ms ?? 0);
			const entitiesCount = Number(m.entities_created ?? 0);
			const fluidsMs = Number(m.fluids_ms ?? 0);
			const fluidsCount = Number(m.fluids_restored ?? 0);
			const totalImportMs = Number(m.total_ms ?? 0);
			if (totalImportMs > 0) {
				totalMs = Math.max(totalMs, eventStart);
				let cursor = eventStart - totalImportMs;
				if (tilesMs > 0 || tilesCount > 0) {
					const label = tilesCount > 0 ? `Tiles (${tilesCount.toLocaleString()})` : "Tiles";
					const dur = tilesMs || 1;
					rows.push({ key: `import:tiles:${eventStart}`, label,
						isEvent: false, indent: 1, startMs: cursor, endMs: cursor + dur,
						durationMs: tilesMs || null, color: "blue" });
					cursor += dur;
				}
				if (entitiesMs > 0 || entitiesCount > 0) {
					const label = entitiesCount > 0 ? `Entities (${entitiesCount.toLocaleString()})` : "Entities";
					const dur = entitiesMs || 1;
					rows.push({ key: `import:entities:${eventStart}`, label,
						isEvent: false, indent: 1, startMs: cursor, endMs: cursor + dur,
						durationMs: entitiesMs || null, color: "blue" });
					cursor += dur;
				}
				if (fluidsMs > 0 || fluidsCount > 0) {
					const label = fluidsCount > 0 ? `Fluids (${fluidsCount.toLocaleString()})` : "Fluids";
					const dur = fluidsMs || 1;
					rows.push({ key: `import:fluids:${eventStart}`, label,
						isEvent: false, indent: 1, startMs: cursor, endMs: cursor + dur,
						durationMs: fluidsMs || null, color: "blue" });
				}
			}
		}

		// Transfer-level phases (transmission, validation, cleanup)
		if (typeof event?.transmissionMs === "number" && event.transmissionMs > 0) {
			const eventStart = elapsedMs ?? 0;
			rows.push({ key: `phase:transmission:${eventStart}`, label: "Transmission",
				isEvent: false, indent: 1, startMs: eventStart - event.transmissionMs, endMs: eventStart,
				durationMs: event.transmissionMs, color: "blue" });
			totalMs = Math.max(totalMs, eventStart);
		}
		if (typeof event?.validationMs === "number" && event.validationMs > 0) {
			const eventStart = elapsedMs ?? 0;
			rows.push({ key: `phase:validation:${eventStart}`, label: "Validation",
				isEvent: false, indent: 1, startMs: eventStart - event.validationMs, endMs: eventStart,
				durationMs: event.validationMs, color: "blue" });
			totalMs = Math.max(totalMs, eventStart);
		}
		if (event?.phases && typeof event.phases === "object") {
			const eventStart = elapsedMs ?? 0;
			// Skip phases already captured by individual event fields at correct timeline positions:
			// transmissionMs comes from import_started.transmissionMs
			// validationMs comes from validation_received.validationMs
			const skipFromPhaseSummary = new Set(["transmissionMs", "validationMs"]);
			for (const [k, v] of Object.entries(event.phases)) {
				if (skipFromPhaseSummary.has(k)) continue;
				if (typeof v === "number" && v > 0) {
					rows.push({ key: `phase:${k}:${eventStart}`, label: humanizeMetricKey(String(k).replace(/Ms$/, "")),
						isEvent: false, indent: 1, startMs: eventStart - v, endMs: eventStart,
						durationMs: v, color: "blue" });
					totalMs = Math.max(totalMs, eventStart);
				}
			}
		}
	}

	const scale = totalMs > 0 ? totalMs : 1;
	return {
		totalMs,
		rows: rows.map(row => ({
			...row,
			ganttStartPct: Math.max(0, Math.min(100, (row.startMs / scale) * 100)),
			ganttWidthPct: row.endMs > row.startMs
				? Math.max(0.8, Math.min(100 - (row.startMs / scale) * 100, ((row.endMs - row.startMs) / scale) * 100))
				: 0,
			ganttMarkerPct: Math.max(0, Math.min(100, (row.endMs / scale) * 100)),
		})),
	};
}


function MermaidGantt({ rows, totalMs }: { rows: Array<JsonObject>; totalMs: number }) {
	const [svgHtml, setSvgHtml] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const idRef = useRef(`mermaid-gantt-${Math.random().toString(36).slice(2)}`);
	const mermaidText = useMemo(() => buildMermaidGanttText(rows, totalMs), [rows, totalMs]);
	useEffect(() => {
		if (!mermaidText) {
			setSvgHtml(null);
			return;
		}
		let cancelled = false;
		setSvgHtml(null);
		setError(null);
		getMermaid()
			.then(mermaid => mermaid.render(idRef.current, mermaidText))
			.then(({ svg }) => { if (!cancelled) setSvgHtml(svg); })
			.catch((err: unknown) => { if (!cancelled) setError(getErrorMessage(err)); });
		return () => { cancelled = true; };
	}, [mermaidText]);
	if (!mermaidText) return <Empty description="No transfer flow events available" />;
	if (error) return <Alert type="warning" message="Gantt diagram unavailable" description={error} />;
	if (!svgHtml) return <Spin />;
	return <div style={{ overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: svgHtml }} />;
}

export default function TransactionLogsTab({ plugin, state }: { plugin: SurfaceExportPlugin; state: SurfaceExportState }) {
	const entityMetadata = useEntityMetadata();
	const [selectedTransferId, setSelectedTransferId] = useState<string | null>(null);
	const [downloadingTransferId, setDownloadingTransferId] = useState<string | null>(null);
	const selectedDetails = selectedTransferId ? state.logDetails[selectedTransferId] : null;
	type DetailedSummary = ReturnType<typeof buildDetailedLogSummary>;
	const detailedSummary = useMemo<DetailedSummary | null>(
		() => (selectedDetails ? buildDetailedLogSummary(selectedDetails, selectedTransferId) : null),
		[selectedDetails, selectedTransferId],
	);

	const columns: ColumnsType<TransferSummary> = [
		{
			title: "Type",
			dataIndex: "operationType",
			key: "operationType",
			render: (operationType: string) => (
				<Tag color={operationType === "transfer" ? "blue" : "default"}>
					{operationType || "transfer"}
				</Tag>
			),
		},
		{
			title: "Platform",
			dataIndex: "platformName",
			key: "platformName",
		},
		{
			title: "Status",
			dataIndex: "status",
			key: "status",
			render: (status: string) => <Tag color={statusColor(status)}>{status}</Tag>,
		},
		{
			title: "Timestamp",
			dataIndex: "startedAt",
			key: "startedAt",
			render: (startedAt: number) => startedAt ? new Date(startedAt).toLocaleString() : "-",
		},
		{
			title: "Size",
			dataIndex: "artifactSizeBytes",
			key: "artifactSizeBytes",
			render: (value: number) => formatBytes(value),
		},
		{
			title: "Actions",
			key: "actions",
			render: (_: unknown, row: TransferSummary) => (
				<Button
					icon={<DownloadOutlined />}
					size="small"
					disabled={!row.downloadable || !row.exportId}
					loading={downloadingTransferId === row.transferId}
					onClick={async event => {
						event.stopPropagation();
						if (!row.downloadable || !row.exportId) {
							return;
						}
						setDownloadingTransferId(row.transferId);
						try {
							const response = await plugin.getStoredExport(row.exportId);
							if (!response.success) {
								throw new Error(response.error || "Download failed");
							}
							const blob = new Blob([JSON.stringify(response.exportData, null, 2)], { type: "application/json" });
							const url = URL.createObjectURL(blob);
							const link = document.createElement("a");
							link.href = url;
							const safeName = (response.platformName || row.platformName || "platform").replace(/[^\w-]+/g, "_");
							const timestamp = new Date(response.timestamp || Date.now()).toISOString().replace(/[:.]/g, "-");
							link.download = `${safeName}_${timestamp}.json`;
							document.body.appendChild(link);
							link.click();
							document.body.removeChild(link);
							URL.revokeObjectURL(url);
						} catch (err: unknown) {
							antMessage.error(getErrorMessage(err, "Failed to download export"));
						} finally {
							setDownloadingTransferId(null);
						}
					}}
				>
					Download
				</Button>
			),
		},
	];
	const metricColumns = [
		{
			title: "Metric",
			dataIndex: "metric",
			key: "metric",
			width: "60%",
		},
		{
			title: "Value",
			dataIndex: "value",
			key: "value",
		},
	];
	const comparisonColumns = [
		{
			title: "Key",
			dataIndex: "name",
			key: "name",
			width: "40%",
			render: (name: string) => (
				<Space size={6}>
					<div className={`item-${CSS.escape(name)}`} title={name} />
					<Text code>{name}</Text>
				</Space>
			),
		},
		{
			title: "Expected",
			dataIndex: "expected",
			key: "expected",
			render: (value: number) => formatNumeric(value, Number.isInteger(value) ? 0 : 1),
		},
		{
			title: "Actual",
			dataIndex: "actual",
			key: "actual",
			render: (value: number) => formatNumeric(value, Number.isInteger(value) ? 0 : 1),
		},
		{
			title: "Δ",
			dataIndex: "delta",
			key: "delta",
			render: (delta: number) => (
				<Text type={delta === 0 ? undefined : delta > 0 ? "success" : "danger"}>
					{formatSigned(delta, Number.isInteger(delta) ? 0 : 1)}
				</Text>
			),
		},
		{
			title: "Preserved",
			dataIndex: "preservedPct",
			key: "preservedPct",
			render: (value: number | null) => (value === null ? "-" : `${formatNumeric(value, 1)}%`),
		},
	];
	const flowTimeline = useMemo(
		() => buildGanttRows(selectedDetails?.events || [], detailedSummary as JsonObject | null),
		[selectedDetails, detailedSummary],
	);
	const compressionSummary = useMemo(() => {
		const p = (detailedSummary?.payload ?? null) as JsonObject | null;
		const e = (detailedSummary?.export ?? null) as JsonObject | null;
		if (!p && !e) return null;
		const uncompressed = e?.uncompressedPayloadBytes ?? null;
		const compressed = e?.compressedPayloadBytes ?? null;
		const pct = e?.compressionReductionPct ?? null;
		const isCompressed = p?.isCompressed ?? (compressed !== null && uncompressed !== null && compressed < uncompressed);
		if (uncompressed === null) return null;
		if (isCompressed && compressed !== null && pct !== null) {
			return `${formatNumeric(pct, 1)}% compression: ${formatBytes(compressed)} (${formatBytes(uncompressed)} uncompressed)`;
		}
		return `0% compression: ${formatBytes(uncompressed)} (uncompressed)`;
	}, [detailedSummary]);
	const operationRows = useMemo(
		() => buildOperationCountRows((detailedSummary?.export ?? null) as JsonObject | null, (detailedSummary?.import ?? null) as JsonObject | null),
		[detailedSummary],
	);


	const validation = (detailedSummary?.validation ?? null) as JsonObject | null;

	const expectedItems = (validation?.expectedItemCounts as Record<string, number> | undefined)
		|| (detailedSummary?.sourceVerification?.itemCounts as Record<string, number> | undefined)
		|| {};
	const actualItems = (validation?.actualItemCounts as Record<string, number> | undefined) || {};
	const expectedFluids = (validation?.expectedFluidCounts as Record<string, number> | undefined)
		|| (detailedSummary?.sourceVerification?.fluidCounts as Record<string, number> | undefined)
		|| {};
	const actualFluids = (validation?.actualFluidCounts as Record<string, number> | undefined) || {};

	const itemRows = useMemo(() => buildExpectedActualRows(expectedItems, actualItems), [expectedItems, actualItems]);
	const highTempThreshold = Number(validation?.fluidReconciliation?.highTempThreshold ?? 10000);
	const fluidInventoryRows = useMemo(
		() => buildFluidInventoryRows(
			expectedFluids,
			actualFluids,
			highTempThreshold,
			(validation?.fluidReconciliation?.highTempAggregates as JsonObject | undefined) || {},
		),
		[expectedFluids, actualFluids, highTempThreshold, validation],
	);


	const entityRows = useMemo(
		() => Object.entries(validation?.entityTypeBreakdown || {})
			.map(([type, count]) => ({
				key: type,
				entityType: type,
				count: Number(count) || 0,
			}))
			.sort((a, b) => b.count - a.count),
		[validation],
	);
	const entityColumns = [
		{
			title: "Entity Type",
			dataIndex: "entityType",
			key: "entityType",
			render: (value: string) => {
				const meta = entityMetadata.get(value);
				const sz = meta?.size ?? 32;
				return (
					<Space size={6}>
						<div className={`entity-${CSS.escape(value)}`} title={value} style={{ width: sz, height: sz, imageRendering: "pixelated", display: "inline-block", verticalAlign: "middle", flexShrink: 0 }} />
						<Text code>{value}</Text>
					</Space>
				);
			},
		},
		{
			title: "Count",
			dataIndex: "count",
			key: "count",
			render: (value: number) => formatNumeric(value, 0),
		},
	];

	const fluidReconciliationRows = useMemo(() => {
		const recon = validation?.fluidReconciliation as JsonObject | undefined;
		if (!recon) {
			return [] as MetricRow[];
		}
		return [
			{ key: "rawFluidDelta", metric: "Raw fluid delta", value: formatSigned(Number(recon.rawFluidDelta ?? 0), 1) },
			{ key: "reconciledFluidLoss", metric: "Reconciled fluid loss", value: formatNumeric(Number(recon.reconciledFluidLoss ?? 0), 1) },
			{ key: "lowTempLoss", metric: "Low-temp loss", value: formatNumeric(Number(recon.lowTempLoss ?? 0), 1) },
			{ key: "highTempReconciledLoss", metric: "High-temp reconciled loss", value: formatNumeric(Number(recon.highTempReconciledLoss ?? 0), 1) },
			{ key: "fluidPreservedPct", metric: "Fluid preserved", value: `${formatNumeric(Number(recon.fluidPreservedPct ?? 0), 1)}%` },
			{ key: "highTempThreshold", metric: "High-temp threshold", value: formatNumeric(Number(recon.highTempThreshold ?? 0), 0) },
		];
	}, [validation]);

	const fluidColumns: ColumnsType<FluidInventoryRow> = [
		{
			title: "Fluid / Bucket",
			key: "fluid",
			width: "32%",
			render: (_: unknown, row: FluidInventoryRow) => (
				row.isGroup
					? (
						<Space size={6} align="center">
							<div style={{ width: 32, height: 32 }}>
								<div className={`item-${CSS.escape(row.name)}`} title={row.name} />
							</div>
							<Text code>{row.name}</Text>
							{row.tempDisplay && <Text type="secondary" style={{ fontSize: 12 }}>{row.tempDisplay}</Text>}
						</Space>
					)
					: row.isThermalSummary
						? (
							<Tooltip title="Total thermal energy: Volume × Temperature">
								<Text type="secondary" style={{ paddingLeft: 28 }}>Thermal (V×T)</Text>
							</Tooltip>
						)
						: (
							<Text type="secondary" style={{ paddingLeft: 28 }}>{row.tempDisplay ?? row.name}</Text>
						)
			),
		},
		{
			title: "Category",
			dataIndex: "category",
			key: "category",
			render: (value: string) => (
				<Tag color={value === "High-temp" ? "gold" : "default"}>
					{value}
				</Tag>
			),
		},
		{
			title: "Expected",
			dataIndex: "expected",
			key: "expected",
			render: (value: number, row: FluidInventoryRow) => row.isThermalSummary ? formatCompactEnergy(value) : formatNumeric(value, 1),
		},
		{
			title: "Actual",
			dataIndex: "actual",
			key: "actual",
			render: (value: number, row: FluidInventoryRow) => row.isThermalSummary ? formatCompactEnergy(value) : formatNumeric(value, 1),
		},
		{
			title: "Δ",
			dataIndex: "delta",
			key: "delta",
			render: (delta: number, row: FluidInventoryRow) => {
				if (row.isThermalSummary) {
					const color = row.reconciled ? undefined : "warning";
					return <Text type={color}>{formatCompactEnergy(delta)}</Text>;
				}
				if (!row.isGroup && row.category === "High-temp" && row.reconciled && Math.abs(delta) > 0.0001) {
					return <Text type="warning">{formatSigned(delta, 1)}</Text>;
				}
				return (
					<Text type={delta === 0 ? undefined : delta > 0 ? "success" : "danger"}>
						{formatSigned(delta, 1)}
					</Text>
				);
			},
		},
		{
			title: "Preserved",
			dataIndex: "preservedPct",
			key: "preservedPct",
			render: (value: number | null, row: FluidInventoryRow) => {
				if (value === null) return "-";
				if (row.isThermalSummary) return `${formatNumeric(value, 2)}%`;
				return `${formatNumeric(value, 1)}%`;
			},
		},
		{
			title: "Status",
			dataIndex: "status",
			key: "status",
			render: (status: string, row: FluidInventoryRow) => {
				if (status === "Verified (thermal)") {
					return (
						<Tooltip title="Volume preserved; thermal energy (V×T) validated.">
							<Tag color="green">Verified (thermal)</Tag>
						</Tooltip>
					);
				}
				if (status === "Thermal match") {
					return (
						<Tooltip title="Total thermal energy (Volume × Temperature) preserved within tolerance.">
							<Tag color="green">Thermal match</Tag>
						</Tooltip>
					);
				}
				if (status === "Thermal drift") {
					return <Tag color="warning">Thermal drift</Tag>;
				}
				if (status === "Reconciled aggregate") {
					return <Tag color="green">Reconciled aggregate</Tag>;
				}
				if (status === "Bucket drift (reconciled)") {
					return (
						<Tooltip title="High-temp bucket drift is expected from temperature merging/averaging.">
							<Tag color="gold">Bucket drift (reconciled)</Tag>
						</Tooltip>
					);
				}
				if (status === "Mismatch") {
					return <Tag color={row.category === "High-temp" ? "warning" : "error"}>Mismatch</Tag>;
				}
				return <Tag color="default">Match</Tag>;
			},
		},
	];

	const selectedStatus = detailedSummary?.status || selectedDetails?.transferInfo?.status || "unknown";
	const selectedResult = detailedSummary?.result || "IN_PROGRESS";
	const summaryAlertType = selectedResult === "SUCCESS"
		? "success"
		: selectedResult === "FAILED" ? "error" : "info";
	const summaryOutcomeText = selectedResult === "FAILED"
		? "Transfer error"
		: selectedResult === "SUCCESS"
			? "Transfer completed"
			: "Transfer in progress";
	const detailLoaded = Boolean(selectedDetails && detailedSummary);
	const hasValidation = Boolean(validation);

	return (
		<div className="surface-export-log-body">
			<Card title="Recent Transfer Logs">
				<Table
					size="small"
					columns={columns}
					dataSource={state.transferSummaries}
					rowKey={row => row.transferId}
					pagination={{ pageSize: 10 }}
					rowClassName={row => row.transferId === selectedTransferId ? "surface-export-log-row-selected" : "surface-export-log-row"}
					onRow={row => ({
						onClick: async () => {
							setSelectedTransferId(row.transferId);
							try {
								await plugin.loadTransactionLog(row.transferId);
								} catch (err: unknown) {
									antMessage.error(getErrorMessage(err, "Failed to load transaction log"));
							}
						},
					})}
				/>
			</Card>

			{!selectedTransferId ? (
				<Card title="Transfer Details">
					<Empty description="Select a transfer row to view details" />
				</Card>
			) : null}

			{selectedTransferId && !selectedDetails ? (
				<Card title="Transfer Details">
					<Spin />
				</Card>
			) : null}

			{detailLoaded ? (
				<>
					<Card title="Transfer Summary">
						<Alert
							type={summaryAlertType}
							showIcon
							message={<span className="surface-export-summary-platform-title">{detailedSummary.platform?.name || selectedTransferId}</span>}
							description={(
								<Space direction="vertical" size={2}>
									<span>{summaryOutcomeText} {`(${detailedSummary.totalDurationStr}):`}</span>
									{detailedSummary.error ? <span>{detailedSummary.error}</span> : null}
								</Space>
							)}
						/>
						<Space direction="vertical" style={{ width: "100%", marginTop: 12 }}>
							<Space size="small">
								<Text strong>Transfer Flow</Text>
								<Tooltip title="Mermaid Gantt diagram of all transfer phases and events, with timing in milliseconds.">
									<InfoCircleOutlined />
								</Tooltip>
							</Space>
							<MermaidGantt rows={flowTimeline?.rows || []} totalMs={flowTimeline?.totalMs || 0} />
						</Space>
					</Card>


					<Card title="Transfer Details">
						<Tabs
							items={[
								{
									key: "metrics",
									label: "Metrics",
									children: (
										<Space direction="vertical" style={{ width: "100%" }} size="middle">
											{compressionSummary ? (
												<Text type="secondary">{compressionSummary}</Text>
											) : null}
											<Space direction="vertical" style={{ width: "100%" }} size="small">
												<Text strong>Operation Counts</Text>
												{operationRows.length ? (
													<Table size="small" pagination={false} columns={metricColumns} dataSource={operationRows} />
												) : (
													<Empty description="No operation metrics available" />
												)}
											</Space>
										</Space>
									),
								},
								{
									key: "entities",
									label: detailedSummary?.export?.exportedEntityCount
										? `Entities (${Number(((detailedSummary.export ?? {}) as JsonObject).exportedEntityCount ?? 0).toLocaleString()})`
										: "Entities",
									children: hasValidation ? (
										entityRows.length ? (
											<Table
												size="small"
												pagination={{ pageSize: 20 }}
												columns={entityColumns}
												dataSource={entityRows}
												rowKey={entry => entry.key}
											/>
										) : (
											<Empty description="No entity details available" />
										)
									) : (
										<Empty description="No validation data available yet" />
									),
								},
								{
									key: "items",
									label: "Items",
									children: hasValidation ? (
										<Space direction="vertical" style={{ width: "100%" }} size="middle">
											{itemRows.length ? (
												<Table
													size="small"
													pagination={{ pageSize: 20 }}
													columns={comparisonColumns}
													dataSource={itemRows}
													rowKey={entry => entry.key}
												/>
											) : (
												<Empty description="No item details available" />
											)}
											{validation?.inventoryOverflowLosses?.total > 0 && (() => {
												const iol = validation.inventoryOverflowLosses as JsonObject;
												type InventoryOverflowEntity = {
													name?: string;
													position?: { x?: number; y?: number };
													item?: string;
													expected?: number;
													actual?: number;
													lost?: number;
												};
												const entityLines = ((iol.entities as InventoryOverflowEntity[]) || [])
													.map((e) => `${e.name} @ (${e.position?.x?.toFixed(1)}, ${e.position?.y?.toFixed(1)}): ${e.item} — wanted ${e.expected}, placed ${e.actual}, lost ${e.lost}`)
													.join("\n");
												return (
													<Tooltip title={<pre style={{ margin: 0, fontSize: 11 }}>{entityLines}</pre>}>
														<Alert
															type="info"
															showIcon
															message={`API stack cap: ${iol.total} item${iol.total !== 1 ? "s" : ""} excluded from expected (hover for details)`}
														/>
													</Tooltip>
												);
											})()}
										</Space>
									) : (
										<Empty description="No validation data available yet" />
									),
								},
								{
									key: "fluids",
									label: "Fluids",
									children: hasValidation ? (
										<Space direction="vertical" style={{ width: "100%" }} size="middle">
											{fluidInventoryRows.length ? (
												<Table
													size="small"
													pagination={{ pageSize: 20 }}
													columns={fluidColumns}
													dataSource={fluidInventoryRows}
													rowKey={entry => entry.key}
												/>
											) : (
												<Empty description="No fluid details available" />
											)}
										</Space>
									) : (
										<Empty description="No validation data available yet" />
									),
								},
							]}
						/>
					</Card>

				</>
			) : null}
		</div>
	);
}
