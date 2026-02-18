import React, { useMemo, useState } from "react";
import {
	Alert,
	Card,
	Empty,
	Space,
	Spin,
	Table,
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
	sumValues,
	buildMetricRows,
	buildExpectedActualRows,
	buildFluidInventoryRows,
	buildDetailedLogSummary,
} from "./utils";

const { Text } = Typography;

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
			width: "16%",
			render: (_, row) => row.timestamp ? new Date(row.timestamp).toLocaleTimeString() : "-",
		},
		{
			title: "Step",
			dataIndex: "eventType",
			key: "eventType",
			width: "20%",
			render: (eventType, row) => <Tag color={row.color}>{eventType}</Tag>,
		},
		{
			title: "Elapsed",
			dataIndex: "elapsedMs",
			key: "elapsedMs",
			width: "10%",
			render: value => (typeof value === "number" ? `${formatNumeric(value, 0)} ms` : "-"),
		},
		{
			title: "\u0394 Prev",
			dataIndex: "deltaMs",
			key: "deltaMs",
			width: "10%",
			render: value => (typeof value === "number" ? `${formatNumeric(value, 0)} ms` : "-"),
		},
		{
			title: "Duration",
			key: "duration",
			width: "12%",
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
				exportMetrics: event?.exportMetrics
					|| (event?.eventType === "transfer_created" ? detailedSummary?.export || null : null),
				color: isFailure ? "red" : isSuccess ? "green" : "blue",
			};
		}),
		[selectedDetails, detailedSummary]
	);
	const payloadRows = useMemo(() => buildMetricRows(detailedSummary?.payload), [detailedSummary]);
	const exportRows = useMemo(() => buildMetricRows(detailedSummary?.export), [detailedSummary]);
	const importRows = useMemo(() => buildMetricRows(detailedSummary?.import), [detailedSummary]);

	const validation = detailedSummary?.validation || null;
	const validationRows = useMemo(() => {
		if (!validation) {
			return [];
		}
		return [
			{ key: "itemCountMatch", metric: "Item counts match", value: validation.itemCountMatch ? "Yes" : "No" },
			{ key: "fluidCountMatch", metric: "Fluid counts match", value: validation.fluidCountMatch ? "Yes" : "No" },
			{ key: "entityCount", metric: "Entity count", value: formatNumeric(validation.entityCount, 0) },
			{ key: "itemTypesExpected", metric: "Item types (expected)", value: formatNumeric(validation.itemTypesExpected, 0) },
			{ key: "itemTypesActual", metric: "Item types (actual)", value: formatNumeric(validation.itemTypesActual, 0) },
			{ key: "fluidTypesExpected", metric: "Fluid types (expected)", value: formatNumeric(validation.fluidTypesExpected, 0) },
			{ key: "fluidTypesActual", metric: "Fluid types (actual)", value: formatNumeric(validation.fluidTypesActual, 0) },
		];
	}, [validation]);

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

	const itemExpectedTotal = validation?.totalExpectedItems ?? sumValues(expectedItems);
	const itemActualTotal = validation?.totalActualItems ?? sumValues(actualItems);
	const fluidExpectedTotal = validation?.totalExpectedFluids ?? sumValues(expectedFluids);
	const fluidActualTotal = validation?.totalActualFluids ?? sumValues(actualFluids);

	const validationCategoryColumns = [
		{
			title: "Category",
			dataIndex: "category",
			key: "category",
			width: "30%",
		},
		{
			title: "Expected",
			dataIndex: "expected",
			key: "expected",
			render: value => formatNumeric(value, 0),
		},
		{
			title: "Actual",
			dataIndex: "actual",
			key: "actual",
			render: value => formatNumeric(value, 0),
		},
		{
			title: "\u0394",
			dataIndex: "delta",
			key: "delta",
			render: delta => (
				<Text type={delta === 0 ? undefined : delta > 0 ? "success" : "danger"}>
					{formatSigned(delta, 0)}
				</Text>
			),
		},
		{
			title: "Status",
			key: "status",
			render: (_, row) => (
				<Tag color={row.match ? "green" : "red"}>
					{row.match ? "Match" : "Mismatch"}
				</Tag>
			),
		},
	];

	const validationCategoryRows = useMemo(() => {
		if (!validation) {
			return [];
		}
		return [
			{
				key: "validation:entities",
				category: "Entities",
				expected: validation.entityCount || 0,
				actual: validation.entityCount || 0,
				delta: 0,
				match: true,
			},
			{
				key: "validation:items",
				category: "Items",
				expected: itemExpectedTotal,
				actual: itemActualTotal,
				delta: itemActualTotal - itemExpectedTotal,
				match: Boolean(validation.itemCountMatch),
			},
			{
				key: "validation:fluids",
				category: "Fluids",
				expected: fluidExpectedTotal,
				actual: fluidActualTotal,
				delta: fluidActualTotal - fluidExpectedTotal,
				match: Boolean(validation.fluidCountMatch),
			},
		];
	}, [validation, itemExpectedTotal, itemActualTotal, fluidExpectedTotal, fluidActualTotal]);

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


					<Card title="Payload Metrics">
						{payloadRows.length ? (
							<Table size="small" pagination={false} columns={metricColumns} dataSource={payloadRows} />
						) : (
							<Empty description="No payload metrics available" />
						)}
					</Card>
					<Card title="Export Metrics">
						{exportRows.length ? (
							<Table size="small" pagination={false} columns={metricColumns} dataSource={exportRows} />
						) : (
							<Empty description="No export timing metrics available" />
						)}
					</Card>

					<Card title="Import Processing Metrics">
						{importRows.length ? (
							<Table size="small" pagination={false} columns={metricColumns} dataSource={importRows} />
						) : (
							<Empty description="No import metrics available" />
						)}
					</Card>

					<Card title="Validation Overview">
						{hasValidation ? (
							<Space direction="vertical" style={{ width: "100%" }}>
								<Table size="small" pagination={false} columns={metricColumns} dataSource={validationRows} />
								{validation?.mismatchDetails ? (
									<Alert
										type="error"
										showIcon
										message="Validation mismatch details"
										description={validation.mismatchDetails}
									/>
								) : null}
								<Table
									size="small"
									pagination={false}
									columns={validationCategoryColumns}
									dataSource={validationCategoryRows}
									expandable={{
										expandedRowRender: row => {
											if (row.key === "validation:entities") {
												return entityRows.length ? (
													<Table
														size="small"
														pagination={{ pageSize: 10 }}
														columns={[
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
														]}
														dataSource={entityRows}
														rowKey={entry => entry.key}
													/>
												) : (
													<Empty description="No entity details available" />
												);
											}
											if (row.key === "validation:items") {
												return itemRows.length ? (
													<Table
														size="small"
														pagination={{ pageSize: 10 }}
														columns={comparisonColumns}
														dataSource={itemRows}
														rowKey={entry => entry.key}
													/>
												) : (
													<Empty description="No item details available" />
												);
											}
											if (row.key === "validation:fluids") {
												return (
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
												);
											}
											return null;
										},
										rowExpandable: row => [ "validation:entities", "validation:items", "validation:fluids" ].includes(row.key),
									}}
									rowKey={row => row.key}
								/>
							</Space>
						) : (
							<Empty description="No validation data available yet" />
						)}
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
							<Table
								size="small"
								pagination={{ pageSize: 20 }}
								columns={flowColumns}
								dataSource={flowRows}
								rowKey={row => row.key}
								expandable={{
									expandedRowRender: row => (
										<Space direction="vertical" style={{ width: "100%" }}>
											{row.phaseTimings?.length ? (
												<Table
													size="small"
													pagination={false}
													columns={[
														{ title: "Phase", dataIndex: "phase", key: "phase" },
														{
															title: "Source",
															dataIndex: "source",
															key: "source",
															render: value => <Tag>{value}</Tag>,
														},
														{
															title: "Duration",
															dataIndex: "durationMs",
															key: "durationMs",
															render: value => `${formatNumeric(value, 0)} ms`,
														},
													]}
													dataSource={row.phaseTimings}
													rowKey={entry => entry.key}
												/>
											) : (
												<Empty description="No phase timing details on this step" />
											)}
											{row.exportMetrics ? (
												<Table
													size="small"
													pagination={false}
													columns={metricColumns}
													dataSource={buildMetricRows(row.exportMetrics)}
													rowKey={entry => entry.key}
												/>
											) : null}
										</Space>
									),
									rowExpandable: row => Boolean(row.phaseTimings?.length || row.exportMetrics),
								}}
							/>
						) : (
							<Empty description="No transfer flow events available" />
						)}
					</Card>
				</>
			) : null}
		</div>
	);
}
