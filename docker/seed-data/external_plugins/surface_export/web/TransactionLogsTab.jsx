import React, { useMemo, useState } from "react";
import {
	Alert,
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
import {
	statusColor,
	humanizeMetricKey,
	formatNumeric,
	formatSigned,
	buildMetricRows,
	buildExportMetricRows,
	buildExpectedActualRows,
	buildFluidInventoryRows,
	buildDetailedLogSummary,
} from "./utils";

const { Text } = Typography;

function formatFlowDurationMs(value) {
	return typeof value === "number" ? `${formatNumeric(value, 0)} ms` : "-";
}

function buildFlowTimelineRows(rows) {
	const timelineRows = [];
	let previousElapsedMs = 0;
	let maxTimelineMs = 0;

	for (const row of rows || []) {
		const elapsedMs = typeof row.elapsedMs === "number" && row.elapsedMs >= 0 ? row.elapsedMs : null;
		const deltaMs = typeof row.deltaMs === "number" && row.deltaMs >= 0 ? row.deltaMs : null;
		const durationMs = typeof row.durationMs === "number" && row.durationMs >= 0 ? row.durationMs : null;

		let startMs = previousElapsedMs;
		let endMs = previousElapsedMs;
		if (elapsedMs !== null) {
			endMs = elapsedMs;
			startMs = deltaMs !== null ? Math.max(0, elapsedMs - deltaMs) : previousElapsedMs;
		} else if (deltaMs !== null) {
			endMs = previousElapsedMs + deltaMs;
		} else if (durationMs !== null) {
			endMs = previousElapsedMs + durationMs;
		}

		if (endMs < startMs) {
			endMs = startMs;
		}

		const markerMs = elapsedMs ?? endMs;
		const segmentMs = Math.max(0, endMs - startMs);
		previousElapsedMs = Math.max(previousElapsedMs, markerMs, endMs);
		maxTimelineMs = Math.max(maxTimelineMs, markerMs, endMs, durationMs || 0);

		timelineRows.push({
			...row,
			ganttStartMs: startMs,
			ganttEndMs: endMs,
			ganttSegmentMs: segmentMs,
			ganttMarkerMs: markerMs,
		});
	}

	const totalMs = maxTimelineMs > 0 ? maxTimelineMs : 1;
	return {
		totalMs,
		rows: timelineRows.map(row => {
			const startPct = Math.max(0, Math.min(100, (row.ganttStartMs / totalMs) * 100));
			let widthPct = row.ganttSegmentMs > 0
				? Math.max((row.ganttSegmentMs / totalMs) * 100, 1.2)
				: 0;
			if (startPct + widthPct > 100) {
				widthPct = Math.max(0, 100 - startPct);
			}
			const markerPct = Math.max(0, Math.min(100, (row.ganttMarkerMs / totalMs) * 100));
			const metricPoints = [];
			let phaseCursorMs = row.ganttStartMs;
			for (const metric of row.timeMetrics || []) {
				if (typeof metric?.valueMs !== "number" || Number.isNaN(metric.valueMs) || metric.valueMs < 0) {
					continue;
				}
				let metricMs = row.ganttMarkerMs;
				if (metric.kind === "absolute") {
					metricMs = metric.valueMs;
				} else if (metric.kind === "phase") {
					phaseCursorMs += metric.valueMs;
					metricMs = phaseCursorMs;
				} else {
					metricMs = row.ganttStartMs + metric.valueMs;
				}
				metricPoints.push({
					...metric,
					metricMs,
					metricPct: Math.max(0, Math.min(100, (metricMs / totalMs) * 100)),
				});
			}
			return {
				...row,
				ganttStartPct: startPct,
				ganttWidthPct: widthPct,
				ganttMarkerPct: markerPct,
				metricPoints,
			};
		}),
	};
}

export default function TransactionLogsTab({ plugin, state }) {
	const [selectedTransferId, setSelectedTransferId] = useState(null);
	const selectedDetails = selectedTransferId ? state.logDetails[selectedTransferId] : null;
	const detailedSummary = useMemo(
		() => (selectedDetails ? buildDetailedLogSummary(selectedDetails, selectedTransferId) : null),
		[selectedDetails, selectedTransferId]
	);

	const columns = [
		{
			title: "Transfer",
			dataIndex: "transferId",
			key: "transferId",
			render: transferId => <Text code>{transferId}</Text>,
		},
		{
			title: "Platform",
			dataIndex: "platformName",
			key: "platformName",
		},
		{
			title: "Source",
			key: "source",
			render: (_, row) => row.sourceInstanceName || row.sourceInstanceId,
		},
		{
			title: "Destination",
			key: "destination",
			render: (_, row) => row.targetInstanceName || row.targetInstanceId,
		},
		{
			title: "Status",
			dataIndex: "status",
			key: "status",
			render: status => <Tag color={statusColor(status)}>{status}</Tag>,
		},
		{
			title: "Started",
			dataIndex: "startedAt",
			key: "startedAt",
			render: startedAt => startedAt ? new Date(startedAt).toLocaleString() : "-",
		},
	];
	const exportMetricColumns = [
		{
			title: "Metric",
			dataIndex: "metric",
			key: "metric",
			width: "36%",
		},
		{
			title: "Value",
			dataIndex: "value",
			key: "value",
			width: "20%",
		},
		{
			title: "Details",
			dataIndex: "details",
			key: "details",
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
			render: name => <Text code>{name}</Text>,
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
			title: "At",
			key: "at",
			width: "12%",
			render: (_, row) => {
				if (row.timestamp) {
					return new Date(row.timestamp).toLocaleTimeString();
				}
				if (typeof row.timestampMs === "number") {
					return new Date(row.timestampMs).toLocaleTimeString();
				}
				return "-";
			},
		},
		{
			title: "Step",
			dataIndex: "eventType",
			key: "eventType",
			width: "14%",
			render: (eventType, row) => <Tag color={row.color}>{eventType}</Tag>,
		},
		{
			title: "Elapsed",
			dataIndex: "elapsedMs",
			key: "elapsedMs",
			width: "9%",
			render: value => formatFlowDurationMs(value),
		},
		{
			title: "\u0394 Prev",
			dataIndex: "deltaMs",
			key: "deltaMs",
			width: "9%",
			render: value => formatFlowDurationMs(value),
		},
		{
			title: "Duration",
			key: "duration",
			width: "10%",
			render: (_, row) => {
				if (typeof row.durationMs === "number") {
					return `${formatNumeric(row.durationMs, 0)} ms`;
				}
				if (row.phaseTimings?.length) {
					const totalPhaseMs = row.phaseTimings.reduce((sum, phase) => sum + (Number(phase.durationMs) || 0), 0);
					return `${formatNumeric(totalPhaseMs, 0)} ms`;
				}
				return "-";
			},
		},
		{
			title: "Timeline",
			key: "timeline",
			width: "22%",
			render: (_, row) => {
				const tone = row.color === "red"
					? "#ff4d4f"
					: row.color === "green"
						? "#52c41a"
						: "#1677ff";
				return (
					<div className="surface-export-gantt-cell">
						<div className="surface-export-gantt-track" title={`${row.eventType}: ${formatFlowDurationMs(row.ganttStartMs)} → ${formatFlowDurationMs(row.ganttMarkerMs)}`}>
							{row.ganttWidthPct > 0 ? (
								<span
									className="surface-export-gantt-bar"
									style={{
										left: `${row.ganttStartPct}%`,
										width: `${row.ganttWidthPct}%`,
										backgroundColor: tone,
									}}
								/>
							) : null}
							{(row.metricPoints || []).map(metric => (
								<span
									key={`point:${metric.key}`}
									className="surface-export-gantt-metric-marker"
									title={`${metric.label}: ${formatFlowDurationMs(metric.valueMs)}`}
									style={{ left: `${metric.metricPct}%` }}
								/>
							))}
							<span
								className="surface-export-gantt-marker"
								style={{
									left: `${row.ganttMarkerPct}%`,
									backgroundColor: tone,
								}}
							/>
						</div>
						{row.timeMetrics?.length ? (
							<div className="surface-export-gantt-metrics">
								{row.timeMetrics.map(metric => (
									<span key={`metric:${metric.key}`} className="surface-export-gantt-metric-chip">
										{metric.label}: {formatFlowDurationMs(metric.valueMs)}
									</span>
								))}
							</div>
						) : null}
					</div>
				);
			},
		},
		{
			title: "Message",
			dataIndex: "message",
			key: "message",
		},
	];

	const flowRows = useMemo(
		() => (selectedDetails?.events || []).map((event, index) => {
			const phaseTimings = [];
			if (typeof event?.transmissionMs === "number") {
				phaseTimings.push({ key: "transmission", phase: "Transmission", durationMs: event.transmissionMs, source: "transfer" });
			}
			if (typeof event?.validationMs === "number") {
				phaseTimings.push({ key: "validation", phase: "Validation", durationMs: event.validationMs, source: "transfer" });
			}
			if (event?.phases && typeof event.phases === "object") {
				for (const [phaseName, phaseDurationMs] of Object.entries(event.phases)) {
					if (typeof phaseDurationMs === "number") {
						phaseTimings.push({
							key: `phase:${phaseName}`,
							phase: humanizeMetricKey(String(phaseName).replace(/Ms$/, "")),
							durationMs: phaseDurationMs,
							source: "phase",
						});
					}
				}
			}
			if (event?.importMetrics && typeof event.importMetrics === "object") {
				const importPhaseKeys = [
					[ "tiles_ms", "Import: Tiles" ],
					[ "entities_ms", "Import: Entities" ],
					[ "fluids_ms", "Import: Fluids" ],
					[ "belts_ms", "Import: Belts" ],
					[ "state_ms", "Import: State Restore" ],
					[ "validation_ms", "Import: Validation" ],
					[ "total_ms", "Import: Total" ],
				];
				for (const [metricKey, label] of importPhaseKeys) {
					const value = event.importMetrics?.[metricKey];
					if (typeof value === "number") {
						phaseTimings.push({
							key: `import:${metricKey}`,
							phase: label,
							durationMs: value,
							source: "import",
						});
					}
				}
			}

			const primaryDurationMs = [event?.durationMs, event?.validationMs, event?.transmissionMs]
				.find(value => typeof value === "number") ?? null;
			const timeMetrics = [];
			if (typeof event?.elapsedMs === "number") {
				timeMetrics.push({ key: "elapsed", label: "Elapsed", valueMs: event.elapsedMs, kind: "absolute" });
			}
			if (typeof event?.deltaMs === "number") {
				timeMetrics.push({ key: "delta", label: "\u0394 Prev", valueMs: event.deltaMs, kind: "segment" });
			}
			if (typeof primaryDurationMs === "number") {
				timeMetrics.push({ key: "duration", label: "Duration", valueMs: primaryDurationMs, kind: "segment" });
			}
			for (const timing of phaseTimings) {
				if (typeof timing?.durationMs === "number") {
					timeMetrics.push({
						key: `timing:${timing.key}`,
						label: timing.phase,
						valueMs: timing.durationMs,
						kind: "phase",
					});
				}
			}
			const isFailure = String(event?.eventType || "").includes("failed") || String(event?.eventType || "").includes("error");
			const isSuccess = String(event?.eventType || "").includes("completed") || String(event?.eventType || "").includes("success");

			return {
				key: `flow:${event?.timestampMs || Date.now()}:${index}`,
				eventType: event?.eventType || "event",
				message: event?.message || "",
				timestamp: event?.timestamp || null,
				timestampMs: event?.timestampMs || null,
				elapsedMs: typeof event?.elapsedMs === "number" ? event.elapsedMs : null,
				deltaMs: typeof event?.deltaMs === "number" ? event.deltaMs : null,
				durationMs: primaryDurationMs,
				phaseTimings,
				timeMetrics,
				exportMetrics: event?.exportMetrics
					|| (event?.eventType === "transfer_created" ? detailedSummary?.export || null : null),
				color: isFailure ? "red" : isSuccess ? "green" : "blue",
			};
		}),
		[selectedDetails, detailedSummary]
	);
	const flowTimeline = useMemo(() => buildFlowTimelineRows(flowRows), [flowRows]);
	const payloadRows = useMemo(() => buildMetricRows(detailedSummary?.payload), [detailedSummary]);
	const exportRows = useMemo(() => buildExportMetricRows(detailedSummary?.export), [detailedSummary]);
	const importRows = useMemo(() => buildMetricRows(detailedSummary?.import), [detailedSummary]);

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
			render: value => <Text code>{value}</Text>,
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
					? <Text code>{row.name}</Text>
					: (
						<Tooltip title={row.bucketKey}>
							<Text type="secondary">{row.tempBucket === "-" ? row.bucketKey : `@${row.tempBucket}`}</Text>
						</Tooltip>
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
			render: value => formatNumeric(value, 1),
		},
		{
			title: "Actual",
			dataIndex: "actual",
			key: "actual",
			render: value => formatNumeric(value, 1),
		},
		{
			title: "\u0394",
			dataIndex: "delta",
			key: "delta",
			render: (delta, row) => {
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
			render: value => (value === null ? "-" : `${formatNumeric(value, 1)}%`),
		},
		{
			title: "Status",
			dataIndex: "status",
			key: "status",
			render: (status, row) => {
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
							message={`${selectedResult}: ${detailedSummary.platform?.name || selectedTransferId}`}
							description={`Duration: ${detailedSummary.totalDurationStr} | Status: ${selectedStatus}`}
						/>
						<Space direction="vertical" style={{ width: "100%", marginTop: 12 }}>
							{detailedSummary.error ? (
								<Alert
									type="error"
									showIcon
									message="Transfer error"
									description={detailedSummary.error}
								/>
							) : null}
							<Table
								size="small"
								pagination={false}
								columns={metricColumns}
								dataSource={[
									{
										key: "platform",
										metric: "Platform",
										value: detailedSummary.platform?.name || "-",
									},
									{
										key: "source",
										metric: "Source",
										value: detailedSummary.platform?.source?.instanceName
											|| detailedSummary.platform?.source?.instanceId
											|| "-",
									},
									{
										key: "destination",
										metric: "Destination",
										value: detailedSummary.platform?.destination?.instanceName
											|| detailedSummary.platform?.destination?.instanceId
											|| "-",
									},
								]}
							/>
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
											<Space direction="vertical" style={{ width: "100%" }} size="small">
												<Text strong>Payload Metrics</Text>
												{payloadRows.length ? (
													<Table size="small" pagination={false} columns={metricColumns} dataSource={payloadRows} />
												) : (
													<Empty description="No payload metrics available" />
												)}
											</Space>
											<Space direction="vertical" style={{ width: "100%" }} size="small">
												<Text strong>Export Metrics</Text>
												{exportRows.length ? (
													<Table
														size="small"
														pagination={false}
														columns={exportMetricColumns}
														dataSource={exportRows}
													/>
												) : (
													<Empty description="No export metrics available" />
												)}
											</Space>
											<Space direction="vertical" style={{ width: "100%" }} size="small">
												<Text strong>Import Processing Metrics</Text>
												{importRows.length ? (
													<Table size="small" pagination={false} columns={metricColumns} dataSource={importRows} />
												) : (
													<Empty description="No import metrics available" />
												)}
											</Space>
											{hasValidation && validation?.mismatchDetails ? (
												<Alert
													type="error"
													showIcon
													message="Validation mismatch details"
													description={validation.mismatchDetails}
												/>
											) : null}
										</Space>
									),
								},
								{
									key: "entities",
									label: "Entities",
									children: hasValidation ? (
										entityRows.length ? (
											<Table
												size="small"
												pagination={{ pageSize: 10 }}
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
										itemRows.length ? (
											<Table
												size="small"
												pagination={{ pageSize: 10 }}
												columns={comparisonColumns}
												dataSource={itemRows}
												rowKey={entry => entry.key}
											/>
										) : (
											<Empty description="No item details available" />
										)
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
													pagination={{ pageSize: 10 }}
													columns={fluidColumns}
													dataSource={fluidInventoryRows}
													rowKey={entry => entry.key}
												/>
											) : (
												<Empty description="No fluid details available" />
											)}
											{fluidReconciliationRows.length ? (
												<Table
													size="small"
													pagination={false}
													columns={metricColumns}
													dataSource={fluidReconciliationRows}
													rowKey={entry => entry.key}
												/>
											) : null}
										</Space>
									) : (
										<Empty description="No validation data available yet" />
									),
								},
							]}
						/>
					</Card>

					<Card
						title={(
							<Space size="small">
								<span>Transfer Flow (Timeline + Phases)</span>
								<Tooltip title="Chronological events with phase and import timing details in ms.">
									<InfoCircleOutlined />
								</Tooltip>
							</Space>
						)}
					>
						{flowRows.length ? (
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
					</Card>
				</>
			) : null}
		</div>
	);
}
