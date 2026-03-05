import React, { useMemo, useState } from "react";
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
import { InfoCircleOutlined } from "@ant-design/icons";
import { DownloadOutlined } from "@ant-design/icons";
import {
	statusColor,
	humanizeMetricKey,
	formatNumeric,
	formatSigned,
	formatCompactEnergy,
	buildOperationCountRows,
	buildExpectedActualRows,
	buildFluidInventoryRows,
	buildDetailedLogSummary,
} from "./utils";

const { Text } = Typography;

function formatFlowDurationMs(value) {
	return typeof value === "number" ? `${formatNumeric(value, 0)} ms` : "-";
}

function formatBytes(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) {
		return "-";
	}
	if (numeric < 1024) {
		return `${numeric.toLocaleString()} B`;
	}
	if (numeric < 1024 * 1024) {
		return `${(numeric / 1024).toFixed(1)} KB`;
	}
	return `${(numeric / (1024 * 1024)).toFixed(2)} MB`;
}

function buildGanttRows(events, detailedSummary) {
	// Produce one row per named phase across all events.
	// Each row: { key, label, isEvent, indent, startMs, endMs, durationMs, color }
	// All times are absolute ms from transfer start (elapsedMs of first event = 0).
	const rows = [];
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
		const exportMetrics = event?.exportMetrics
			|| (event?.eventType === "transfer_created" ? detailedSummary?.export || null : null);
		if (exportMetrics && typeof exportMetrics === "object") {
			const eventStart = elapsedMs ?? 0;
			const lockMs = Number(exportMetrics.requestExportAndLockMs ?? 0);
			const storeMs = Number(exportMetrics.waitForControllerStoreMs ?? 0);
			const asyncMs = Number(exportMetrics.instanceAsyncExportMs ?? 0);
			const ticks = Number(exportMetrics.instanceAsyncExportTicks ?? 0);
			// requestExportAndLockMs and waitForControllerStoreMs are sequential sub-phases.
			// controllerExportPrepTotalMs = lockMs + storeMs (derived, skip).
			// instanceAsyncExportMs starts after prep.
			let cursor = eventStart;
			if (lockMs > 0) {
				rows.push({ key: `export:lock:${eventStart}`, label: "Queue + lock",
					isEvent: false, indent: 1, startMs: cursor, endMs: cursor + lockMs,
					durationMs: lockMs, color: "blue" });
				totalMs = Math.max(totalMs, cursor + lockMs);
				cursor += lockMs;
			}
			if (storeMs > 0) {
				rows.push({ key: `export:store:${eventStart}`, label: "Wait for store",
					isEvent: false, indent: 1, startMs: cursor, endMs: cursor + storeMs,
					durationMs: storeMs, color: "blue" });
				totalMs = Math.max(totalMs, cursor + storeMs);
				cursor += storeMs;
			}
			if (asyncMs > 0) {
				const asyncLabel = ticks > 0 ? `Async export (${ticks.toLocaleString()} ticks)` : "Async export";
				rows.push({ key: `export:async:${eventStart}`, label: asyncLabel,
					isEvent: false, indent: 1, startMs: cursor, endMs: cursor + asyncMs,
					durationMs: asyncMs, color: "blue" });
				totalMs = Math.max(totalMs, cursor + asyncMs);
			}
		}

		// Import sub-phases
		if (event?.importMetrics && typeof event.importMetrics === "object") {
			const m = event.importMetrics;
			const eventStart = elapsedMs ?? 0;
			let cursor = eventStart;
			const tilesMs = Number(m.tiles_ms ?? 0);
			const tilesCount = Number(m.tiles_placed ?? 0);
			const entitiesMs = Number(m.entities_ms ?? 0);
			const entitiesCount = Number(m.entities_created ?? 0);
			const totalImportMs = Number(m.total_ms ?? 0);
			if (tilesMs > 0 || tilesCount > 0) {
				const label = tilesCount > 0 ? `Tiles (${tilesCount.toLocaleString()})` : "Tiles";
				rows.push({ key: `import:tiles:${eventStart}`, label,
					isEvent: false, indent: 1, startMs: cursor, endMs: cursor + (tilesMs || 0),
					durationMs: tilesMs || null, color: "blue" });
				totalMs = Math.max(totalMs, cursor + (tilesMs || 0));
				cursor += tilesMs;
			}
			if (entitiesMs > 0 || entitiesCount > 0) {
				const label = entitiesCount > 0 ? `Entities (${entitiesCount.toLocaleString()})` : "Entities";
				rows.push({ key: `import:entities:${eventStart}`, label,
					isEvent: false, indent: 1, startMs: cursor, endMs: cursor + (entitiesMs || 0),
					durationMs: entitiesMs || null, color: "blue" });
				totalMs = Math.max(totalMs, cursor + (entitiesMs || 0));
				cursor += entitiesMs;
			}
			if (totalImportMs > 0) {
				// Import total spans from event start
				rows.push({ key: `import:total:${eventStart}`, label: "Import total",
					isEvent: false, indent: 1, startMs: eventStart, endMs: eventStart + totalImportMs,
					durationMs: totalImportMs, color: "blue" });
				totalMs = Math.max(totalMs, eventStart + totalImportMs);
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
			for (const [k, v] of Object.entries(event.phases)) {
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


export default function TransactionLogsTab({ plugin, state }) {
	const entityMetadata = useEntityMetadata();
	const [selectedTransferId, setSelectedTransferId] = useState(null);
	const [downloadingTransferId, setDownloadingTransferId] = useState(null);
	const selectedDetails = selectedTransferId ? state.logDetails[selectedTransferId] : null;
	const detailedSummary = useMemo(
		() => (selectedDetails ? buildDetailedLogSummary(selectedDetails, selectedTransferId) : null),
		[selectedDetails, selectedTransferId]
	);

	const columns = [
		{
			title: "Type",
			dataIndex: "operationType",
			key: "operationType",
			render: operationType => (
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
			render: status => <Tag color={statusColor(status)}>{status}</Tag>,
		},
		{
			title: "Timestamp",
			dataIndex: "startedAt",
			key: "startedAt",
			render: startedAt => startedAt ? new Date(startedAt).toLocaleString() : "-",
		},
		{
			title: "Size",
			dataIndex: "artifactSizeBytes",
			key: "artifactSizeBytes",
			render: value => formatBytes(value),
		},
		{
			title: "Actions",
			key: "actions",
			render: (_, row) => (
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
						} catch (err) {
							antMessage.error(err.message || "Failed to download export");
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
			render: name => (
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
			render: value => formatNumeric(value, Number.isInteger(value) ? 0 : 1),
		},
		{
			title: "Actual",
			dataIndex: "actual",
			key: "actual",
			render: value => formatNumeric(value, Number.isInteger(value) ? 0 : 1),
		},
		{
			title: "\u0394",
			dataIndex: "delta",
			key: "delta",
			render: delta => (
				<Text type={delta === 0 ? undefined : delta > 0 ? "success" : "danger"}>
					{formatSigned(delta, Number.isInteger(delta) ? 0 : 1)}
				</Text>
			),
		},
		{
			title: "Preserved",
			dataIndex: "preservedPct",
			key: "preservedPct",
			render: value => (value === null ? "-" : `${formatNumeric(value, 1)}%`),
		},
	];
	const flowColumns = [
		{
			title: "Phase",
			dataIndex: "label",
			key: "label",
			width: "22%",
			render: (label, row) => row.isEvent
				? <Tag color={row.color}>{label}</Tag>
				: <span style={{ paddingLeft: row.indent * 16, color: "rgba(0,0,0,0.65)", fontSize: 12 }}>{label}</span>,
		},
		{
			title: "ms",
			dataIndex: "durationMs",
			key: "durationMs",
			width: "10%",
			render: value => value !== null && value !== undefined ? formatFlowDurationMs(value) : "",
		},
		{
			title: "Timeline",
			key: "timeline",
			render: (_, row) => {
				const tone = row.color === "red" ? "#ff4d4f" : row.color === "green" ? "#52c41a" : "#1677ff";
				return (
					<div className="surface-export-gantt-track" title={row.durationMs !== null ? formatFlowDurationMs(row.durationMs) : row.label}>
						{row.ganttWidthPct > 0 && (
							<span className="surface-export-gantt-bar" style={{
								left: `${row.ganttStartPct}%`,
								width: `${row.ganttWidthPct}%`,
								backgroundColor: tone,
								opacity: row.isEvent ? 0 : 0.75,
							}} />
						)}
						<span className="surface-export-gantt-marker" style={{
							left: `${row.ganttMarkerPct}%`,
							backgroundColor: tone,
							opacity: row.isEvent ? 1 : 0.4,
						}} />
					</div>
				);
			},
		},
	]

	const flowTimeline = useMemo(
		() => buildGanttRows(selectedDetails?.events || [], detailedSummary),
		[selectedDetails, detailedSummary]
	)
	const compressionSummary = useMemo(() => {
		const p = detailedSummary?.payload;
		const e = detailedSummary?.export;
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
		() => buildOperationCountRows(detailedSummary?.export, detailedSummary?.import),
		[detailedSummary]
	);


	const validation = detailedSummary?.validation || null;

	const expectedItems = validation?.expectedItemCounts
		|| detailedSummary?.sourceVerification?.itemCounts
		|| {};
	const actualItems = validation?.actualItemCounts || {};
	const expectedFluids = validation?.expectedFluidCounts
		|| detailedSummary?.sourceVerification?.fluidCounts
		|| {};
	const actualFluids = validation?.actualFluidCounts || {};

	const itemRows = useMemo(() => buildExpectedActualRows(expectedItems, actualItems), [expectedItems, actualItems]);
	const highTempThreshold = Number(validation?.fluidReconciliation?.highTempThreshold ?? 10000);
	const fluidInventoryRows = useMemo(
		() => buildFluidInventoryRows(
			expectedFluids,
			actualFluids,
			highTempThreshold,
			validation?.fluidReconciliation?.highTempAggregates || {}
		),
		[expectedFluids, actualFluids, highTempThreshold, validation]
	);


	const entityRows = useMemo(
		() => Object.entries(validation?.entityTypeBreakdown || {})
			.map(([type, count]) => ({
				key: type,
				entityType: type,
				count: Number(count) || 0,
			}))
			.sort((a, b) => b.count - a.count),
		[validation]
	);
	const entityColumns = [
		{
			title: "Entity Type",
			dataIndex: "entityType",
			key: "entityType",
			render: value => {
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
			render: value => formatNumeric(value, 0),
		},
	];

	const fluidReconciliationRows = useMemo(() => {
		const recon = validation?.fluidReconciliation;
		if (!recon) {
			return [];
		}
		return [
			{ key: "rawFluidDelta", metric: "Raw fluid delta", value: formatSigned(recon.rawFluidDelta, 1) },
			{ key: "reconciledFluidLoss", metric: "Reconciled fluid loss", value: formatNumeric(recon.reconciledFluidLoss, 1) },
			{ key: "lowTempLoss", metric: "Low-temp loss", value: formatNumeric(recon.lowTempLoss, 1) },
			{ key: "highTempReconciledLoss", metric: "High-temp reconciled loss", value: formatNumeric(recon.highTempReconciledLoss, 1) },
			{ key: "fluidPreservedPct", metric: "Fluid preserved", value: `${formatNumeric(recon.fluidPreservedPct, 1)}%` },
			{ key: "highTempThreshold", metric: "High-temp threshold", value: formatNumeric(recon.highTempThreshold, 0) },
		];
	}, [validation]);

	const fluidColumns = [
		{
			title: "Fluid / Bucket",
			key: "fluid",
			width: "32%",
			render: (_, row) => (
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
			render: value => (
				<Tag color={value === "High-temp" ? "gold" : "default"}>
					{value}
				</Tag>
			),
		},
		{
			title: "Expected",
			dataIndex: "expected",
			key: "expected",
			render: (value, row) => row.isThermalSummary ? formatCompactEnergy(value) : formatNumeric(value, 1),
		},
		{
			title: "Actual",
			dataIndex: "actual",
			key: "actual",
			render: (value, row) => row.isThermalSummary ? formatCompactEnergy(value) : formatNumeric(value, 1),
		},
		{
			title: "\u0394",
			dataIndex: "delta",
			key: "delta",
			render: (delta, row) => {
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
			render: (value, row) => {
				if (value === null) return "-";
				if (row.isThermalSummary) return `${formatNumeric(value, 2)}%`;
				return `${formatNumeric(value, 1)}%`;
			},
		},
		{
			title: "Status",
			dataIndex: "status",
			key: "status",
			render: (status, row) => {
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
							} catch (err) {
								antMessage.error(err.message || "Failed to load transaction log");
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
								<Text strong>Transfer Flow (Timeline + Phases)</Text>
								<Tooltip title="Chronological events with phase and import timing details in ms.">
									<InfoCircleOutlined />
								</Tooltip>
							</Space>
							{(flowTimeline?.rows?.length) ? (
								<Space direction="vertical" style={{ width: "100%" }} size="small">
									<Text type="secondary" className="surface-export-gantt-scale">
										Timeline scale: 0 ms to {formatNumeric(flowTimeline.totalMs, 0)} ms
									</Text>
									<Table
										size="small"
										pagination={{ pageSize: 20 }}
										columns={flowColumns}
										dataSource={flowTimeline.rows}
										rowKey={row => row.key}
									/>
								</Space>
							) : (
								<Empty description="No transfer flow events available" />
							)}
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
										? `Entities (${Number(detailedSummary.export.exportedEntityCount).toLocaleString()})`
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
												const iol = validation.inventoryOverflowLosses;
												const entityLines = (iol.entities || [])
													.map(e => `${e.name} @ (${e.position?.x?.toFixed(1)}, ${e.position?.y?.toFixed(1)}): ${e.item} — wanted ${e.expected}, placed ${e.actual}, lost ${e.lost}`)
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
