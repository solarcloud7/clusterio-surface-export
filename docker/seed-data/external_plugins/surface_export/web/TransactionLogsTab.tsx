import React, { useMemo, useState, useEffect } from "react";
import { ItemIcon, EntityIcon, FluidIcon } from "./icons";
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
	formatNumeric,
	formatSigned,
	formatCompactEnergy,
	formatBytes,
	buildOperationCountRows,
	buildGanttRows,
	buildExpectedActualRows,
	buildFluidInventoryRows,
	buildDetailedLogSummary,
	getErrorMessage,
	getProp,
type ExpectedActualRow,
type FluidInventoryRow,
} from "./utils";
import type { JsonObject, LogEvent, SurfaceExportPlugin, SurfaceExportState, TransferSummary, GanttRow } from "./view-models";

const { Text } = Typography;

function formatMsLabel(ms: number | null) {
	if (ms == null) return "";
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}


const TIMELINE_COLORS: Record<string, string> = {
	red: "#ff4d4f", green: "#52c41a", blue: "#1890ff",
	// Import waterfall — distinct hues of blue/cyan→indigo in pipeline order so the cascade reads
	// segment-by-segment. Unknown color keys fall back to blue (see PhaseTimeline lookup).
	tiles: "#36cfc9", entities: "#1890ff", belts: "#40a9ff", state: "#597ef7",
	inventories: "#2f54eb", validation: "#85a5ff", fluids: "#08979c",
	// Transfer-level segments
	transmission: "#13c2c2", cleanup: "#73d13d",
	// Cross-machine gap decomposition: delivery (RCON bottleneck, prominent), queue (async wait),
	// roundtrip (muted slate — derived residual, not a direct measurement).
	delivery: "#1d39c4", queue: "#adc6ff", roundtrip: "#737d8c",
	// Export sub-phases (when an exportMetrics block is present)
	exportPrep: "#bae0ff", exportQueue: "#91caff", exportAsync: "#69c0ff", exportStore: "#4096ff",
};

// Lightweight CSS bar timeline. Each row is positioned from the ganttStartPct/ganttWidthPct/
// ganttMarkerPct that buildGanttRows already computes — duration phases render as bars, events as
// markers. Replaces the former mermaid gantt (a multi-MB dep for one diagram).
function PhaseTimeline({ rows, totalMs }: { rows: GanttRow[]; totalMs: number }) {
	if (!rows || rows.length === 0 || totalMs <= 0) {
		return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No transfer flow events available" />;
	}
	return (
		<div className="surface-export-timeline">
			{rows.map((row) => {
				const isEvent = row.isEvent;
				const label = row.label;
				const durationMs = row.durationMs;
				const indent = row.indent;
				const color = TIMELINE_COLORS[row.color] ?? TIMELINE_COLORS.blue;
				const startPct = row.ganttStartPct;
				const widthPct = row.ganttWidthPct;
				const markerPct = row.ganttMarkerPct;
				const endMs = row.endMs;
				const timeLabel = durationMs != null ? formatMsLabel(durationMs) : "";
				return (
					<div key={row.key} className="surface-export-timeline-row">
						<div className="surface-export-timeline-label" style={{ paddingLeft: 4 + indent * 14 }} title={label}>
							<Text strong={isEvent} style={{ fontSize: 12 }}>{label}</Text>
						</div>
						<div className="surface-export-timeline-track">
							{isEvent ? (
								<span
									className="surface-export-timeline-marker"
									style={{ left: `${markerPct}%`, background: color }}
									title={`${label} @ ${formatMsLabel(endMs)}`}
								/>
							) : (
								<span
									className="surface-export-timeline-bar"
									style={{ left: `${startPct}%`, width: `${Math.max(widthPct, 0.6)}%`, background: color }}
									title={`${label}${timeLabel ? ` — ${timeLabel}` : ""}`}
								/>
							)}
						</div>
						<div className="surface-export-timeline-time">
							<Text type="secondary" style={{ fontSize: 11 }}>{timeLabel}</Text>
						</div>
					</div>
				);
			})}
			<div className="surface-export-timeline-axis">
				<Text type="secondary" style={{ fontSize: 11 }}>0</Text>
				<Text type="secondary" style={{ fontSize: 11 }}>{formatMsLabel(totalMs)}</Text>
			</div>
		</div>
	);
}

export default function TransactionLogsTab({ plugin, state }: { plugin: SurfaceExportPlugin; state: SurfaceExportState }) {
	const [selectedTransferId, setSelectedTransferId] = useState<string | null>(null);
	const [downloadingTransferId, setDownloadingTransferId] = useState<string | null>(null);
	const selectedDetails = selectedTransferId ? state.logDetails[selectedTransferId] : null;
	type DetailedSummary = ReturnType<typeof buildDetailedLogSummary>;
	const detailedSummary = useMemo<DetailedSummary | null>(
		() => (selectedDetails && selectedTransferId ? buildDetailedLogSummary(selectedDetails, selectedTransferId) : null),
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
						const response = await plugin.getStoredExport(row.exportId) as JsonObject;
						if (!getProp(response, "success", false)) {
							throw new Error(String(getProp(response, "error", "Download failed")));
						}
						const exportData = getProp(response, "exportData", {});
						const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
						const url = URL.createObjectURL(blob);
						const link = document.createElement("a");
						link.href = url;
						const platformName = String(getProp(response, "platformName", "") || row.platformName || "platform");
						const safeName = platformName.replace(/[^\w-]+/g, "_");
						const timestamp = new Date(Number(getProp(response, "timestamp", Date.now()))).toISOString().replace(/[:.]/g, "-");
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
					<ItemIcon name={name} size={24} />
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
		const uncompressed = e ? getProp(e, "uncompressedPayloadBytes", null) : null;
		const compressed = e ? getProp(e, "compressedPayloadBytes", null) : null;
		const pct = e ? getProp(e, "compressionReductionPct", null) : null;
		const isCompressed = p ? getProp(p, "isCompressed", false) : (compressed !== null && uncompressed !== null && Number(compressed) < Number(uncompressed));
		if (uncompressed === null) return null;
		if (isCompressed && compressed !== null && pct !== null) {
			return `${formatNumeric(Number(pct), 1)}% compression: ${formatBytes(Number(compressed))} (${formatBytes(Number(uncompressed))} uncompressed)`;
		}
		return `0% compression: ${formatBytes(Number(uncompressed))} (uncompressed)`;
	}, [detailedSummary]);
	const operationRows = useMemo(
		() => buildOperationCountRows((detailedSummary?.export ?? null) as JsonObject | null, (detailedSummary?.import ?? null) as JsonObject | null),
		[detailedSummary],
	);


	const validation = (detailedSummary?.validation ?? null) as JsonObject | null;

	const expectedItems = (validation ? getProp(validation, "expectedItemCounts", null) as Record<string, number> | null : null)
		|| (detailedSummary?.sourceVerification ? getProp(detailedSummary.sourceVerification as JsonObject, "itemCounts", null) as Record<string, number> | null : null)
		|| {};
	const actualItems = (validation ? getProp(validation, "actualItemCounts", {}) as Record<string, number> : {});
	const expectedFluids = (validation ? getProp(validation, "expectedFluidCounts", null) as Record<string, number> | null : null)
		|| (detailedSummary?.sourceVerification ? getProp(detailedSummary.sourceVerification as JsonObject, "fluidCounts", null) as Record<string, number> | null : null)
		|| {};
	const actualFluids = (validation ? getProp(validation, "actualFluidCounts", {}) as Record<string, number> : {});

	const itemRows = useMemo(() => buildExpectedActualRows(expectedItems, actualItems), [expectedItems, actualItems]);
	const fluidReconciliation = validation ? getProp(validation, "fluidReconciliation", null) as JsonObject | null : null;
	const highTempThreshold = Number(fluidReconciliation ? getProp(fluidReconciliation, "highTempThreshold", 10000) : 10000);
	const highTempAggregates = fluidReconciliation ? getProp(fluidReconciliation, "highTempAggregates", {}) as JsonObject : {};
	const fluidInventoryRows = useMemo(
		() => buildFluidInventoryRows(
			expectedFluids,
			actualFluids,
			highTempThreshold,
			highTempAggregates,
		),
		[expectedFluids, actualFluids, highTempThreshold, highTempAggregates],
	);

	type InventoryOverflowEntity = {
		name?: string;
		position?: { x?: number; y?: number };
		item?: string;
		expected?: number;
		actual?: number;
		lost?: number;
	};
	const inventoryOverflowAlert = useMemo(() => {
		if (!validation) return null;
		const iol = getProp(validation, "inventoryOverflowLosses", null) as JsonObject | null;
		if (!iol || Number(getProp(iol, "total", 0)) <= 0) return null;
		const entityLines = ((iol.entities as InventoryOverflowEntity[]) || [])
			.map((e) => `${e.name} @ (${e.position?.x?.toFixed(1)}, ${e.position?.y?.toFixed(1)}): ${e.item} \u2014 wanted ${e.expected}, placed ${e.actual}, lost ${e.lost}`)
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
	}, [validation]);

	type ForceDataMismatch = {
		force?: string;
		property?: string;
		source?: number;
		destination?: number;
		synced_to?: number;
	};
	// Non-fatal notice: the destination force was under-researched relative to the source platform, so its
	// inserter-capacity bonuses were RAISED on import to preserve held items (a global, raise-only side effect).
	const forceBonusAlert = useMemo(() => {
		if (!validation) return null;
		const mismatches = (getProp(validation, "forceDataMismatches", null) as ForceDataMismatch[] | null);
		if (!mismatches || mismatches.length === 0) return null;
		const lines = mismatches
			.map((m) => `${m.force ? m.force + " " : ""}${m.property}: dest ${m.destination} → ${m.synced_to} (source ${m.source})`)
			.join("\n");
		return (
			<Tooltip title={<pre style={{ margin: 0, fontSize: 11 }}>{lines}</pre>}>
				<Alert
					type="warning"
					showIcon
					message={`Destination force under-researched: raised ${mismatches.length} inserter bonus${mismatches.length !== 1 ? "es" : ""} to preserve held items (hover for details)`}
				/>
			</Tooltip>
		);
	}, [validation]);


	const entityRows = useMemo(
		() => Object.entries((validation ? getProp(validation, "entityTypeBreakdown", {}) : {}) as Record<string, number>)
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
			render: (value: string) => (
				<Space size={6}>
					<EntityIcon name={value} size={24} />
					<Text code>{value}</Text>
				</Space>
			),
		},
		{
			title: "Count",
			dataIndex: "count",
			key: "count",
			render: (value: number) => formatNumeric(value, 0),
		},
	];

	const fluidColumns: ColumnsType<FluidInventoryRow> = [
		{
			title: "Fluid / Bucket",
			key: "fluid",
			width: "32%",
			render: (_: unknown, row: FluidInventoryRow) => (
				row.isGroup
					? (
						<Space size={6} align="center">
							<FluidIcon name={row.name} size={32} />
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

			{detailLoaded && detailedSummary ? (
				<>
					<Card title="Transfer Summary">
						<Alert
							type={summaryAlertType}
							showIcon
							message={(
								<span className="surface-export-summary-platform-title">
									{(detailedSummary.platform ? getProp(detailedSummary.platform as JsonObject, "name", "") : "") || selectedTransferId}
									{detailedSummary.platform && getProp(detailedSummary.platform as JsonObject, "index", null) != null ? (
										<Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
											#{String(getProp(detailedSummary.platform as JsonObject, "index", ""))}
										</Text>
									) : null}
								</span>
							)}
							description={(
								<Space direction="vertical" size={2}>
									<span>{summaryOutcomeText} {`(${detailedSummary.totalDurationStr}):`}</span>
									{detailedSummary.error ? <span>{String(detailedSummary.error)}</span> : null}
								</Space>
							)}
						/>
						<Space direction="vertical" style={{ width: "100%", marginTop: 12 }}>
							<Space size="small">
								<Text strong>Transfer Flow</Text>
								<Tooltip title="Timeline of all transfer phases and events, with timing in milliseconds.">
									<InfoCircleOutlined />
								</Tooltip>
							</Space>
							<PhaseTimeline rows={flowTimeline?.rows || []} totalMs={flowTimeline?.totalMs || 0} />
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
									label: detailedSummary?.export
										? `Entities (${Number(getProp(detailedSummary.export as JsonObject, "exportedEntityCount", 0)).toLocaleString()})`
										: "Entities",
									children: hasValidation ? (
										<Space direction="vertical" style={{ width: "100%" }} size="small">
											{(() => {
												// Informational (display-only): live destination count (result.entityCount)
												// vs the source payload total. They legitimately differ (failed-to-place /
												// filtered / belt surplus) — no verdict; the item/fluid gate detects loss.
												const reported = getProp(validation as JsonObject, "reportedEntityCount", null) as number | null;
												const actual = getProp(validation as JsonObject, "entityCount", null) as number | null;
												if (reported == null || actual == null) {
													return null;
												}
												return (
													<Text type="secondary">
														{`Entities: ${actual.toLocaleString()} on destination · ${reported.toLocaleString()} in source payload`}
													</Text>
												);
											})()}
											{entityRows.length ? (
												<Table
													size="small"
													pagination={{ pageSize: 20 }}
													columns={entityColumns}
													dataSource={entityRows}
													rowKey={entry => entry.key}
												/>
											) : (
												<Empty description="No entity details available" />
											)}
										</Space>
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
											{inventoryOverflowAlert}
											{forceBonusAlert}
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
