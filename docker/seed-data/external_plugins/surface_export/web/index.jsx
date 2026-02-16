import React, { useContext, useEffect, useMemo, useState } from "react";
import {
	Alert,
	Button,
	Card,
	Empty,
	Select,
	Space,
	Spin,
	Table,
	Tag,
	Tabs,
	Tooltip,
	Typography,
	message as antMessage,
} from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

import {
	BaseWebPlugin,
	ControlContext,
	PageHeader,
	PageLayout,
	notifyErrorHandler,
} from "@clusterio/web_ui";
import * as messageDefs from "../messages";

import "./style.css";

const {
	PERMISSIONS,
	GetPlatformTreeRequest,
	ListTransactionLogsRequest,
	GetTransactionLogRequest,
	StartPlatformTransferRequest,
	SetSurfaceExportSubscriptionRequest,
	SurfaceExportTreeUpdateEvent,
	SurfaceExportTransferUpdateEvent,
	SurfaceExportLogUpdateEvent,
} = messageDefs;

const { Text } = Typography;

function statusColor(status) {
	switch (status) {
	case "transporting":
		return "processing";
	case "awaiting_validation":
		return "gold";
	case "completed":
		return "success";
	case "failed":
	case "error":
	case "cleanup_failed":
		return "error";
	default:
		return "default";
	}
}

function summaryFromTransferInfo(transferInfo, lastEventAt = null) {
	if (!transferInfo) {
		return null;
	}

	return {
		transferId: transferInfo.transferId || transferInfo.id || null,
		platformName: transferInfo.platformName || "Unknown",
		sourceInstanceId: transferInfo.sourceInstanceId ?? -1,
		sourceInstanceName: transferInfo.sourceInstanceName ?? null,
		targetInstanceId: transferInfo.targetInstanceId ?? -1,
		targetInstanceName: transferInfo.targetInstanceName ?? null,
		status: transferInfo.status || "unknown",
		startedAt: transferInfo.startedAt || Date.now(),
		completedAt: transferInfo.completedAt || null,
		failedAt: transferInfo.failedAt || null,
		error: transferInfo.error || null,
		lastEventAt,
	};
}

function mergeTransferSummary(existing, incoming) {
	const byId = new Map((existing || []).map(summary => [summary.transferId, summary]));
	if (incoming && incoming.transferId) {
		byId.set(incoming.transferId, { ...byId.get(incoming.transferId), ...incoming });
	}

	return Array.from(byId.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function useSurfaceExportPlugin(control) {
	return control.plugins.get("surface_export");
}

function useSurfaceExportState(plugin) {
	const [state, setState] = useState(plugin.getState());

	useEffect(() => {
		function onUpdate() {
			setState(plugin.getState());
		}

		plugin.onUpdate(onUpdate);
		return () => plugin.offUpdate(onUpdate);
	}, [plugin]);

	return state;
}

function ManualTransferTab({ plugin, state }) {
	const [selectedPlatformKey, setSelectedPlatformKey] = useState(null);
	const [selectedTargetInstance, setSelectedTargetInstance] = useState(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const { tree, loadingTree, treeError } = state;
	const latestCompletedByPlatform = useMemo(() => {
		const completed = new Map();
		for (const summary of state.transferSummaries || []) {
			if (summary?.status === "completed" && summary?.platformName && !completed.has(summary.platformName)) {
				completed.set(summary.platformName, summary);
			}
		}
		return completed;
	}, [state.transferSummaries]);
	const platformLookup = useMemo(() => {
		const lookup = new Map();
		if (!tree) {
			return lookup;
		}

		const addInstancePlatforms = instance => {
			for (const platform of instance.platforms || []) {
				const key = `platform:${instance.instanceId}:${platform.platformIndex}`;
				lookup.set(key, {
					instanceId: instance.instanceId,
					instanceName: instance.instanceName,
					forceName: platform.forceName || tree.forceName || "player",
					...platform,
				});
			}
		};

		for (const host of tree.hosts || []) {
			for (const instance of host.instances || []) {
				addInstancePlatforms(instance);
			}
		}
		for (const instance of tree.unassignedInstances || []) {
			addInstancePlatforms(instance);
		}
		return lookup;
	}, [tree]);

	const instanceListData = useMemo(() => {
		if (!tree) {
			return [];
		}

		const rows = [];

		for (const host of tree.hosts || []) {
			const sortedInstances = [...(host.instances || [])].sort((a, b) =>
				a.instanceName.localeCompare(b.instanceName)
			);

			for (const instance of sortedInstances) {
				for (const platform of instance.platforms || []) {
					rows.push({
						key: `platform:${instance.instanceId}:${platform.platformIndex}`,
						hostName: host.hostName,
						hostConnected: host.connected,
						instanceId: instance.instanceId,
						instanceName: instance.instanceName,
						instanceConnected: instance.connected,
						instancePlatformError: instance.platformError,
						platform,
					});
				}
			}
		}

		if (tree.unassignedInstances?.length) {
			const sortedUnassigned = [...tree.unassignedInstances].sort((a, b) =>
				a.instanceName.localeCompare(b.instanceName)
			);

			for (const instance of sortedUnassigned) {
				for (const platform of instance.platforms || []) {
					rows.push({
						key: `platform:${instance.instanceId}:${platform.platformIndex}`,
						hostName: "Unassigned",
						hostConnected: null,
						instanceId: instance.instanceId,
						instanceName: instance.instanceName,
						instanceConnected: instance.connected,
						instancePlatformError: instance.platformError,
						platform,
					});
				}
			}
		}

		if (latestCompletedByPlatform.size) {
			const platformTargets = new Map();
			for (const [platformName, summary] of latestCompletedByPlatform.entries()) {
				const hasTarget = rows.some(row => (
					row.platform?.platformName === platformName
					&& row.instanceId === summary.targetInstanceId
				));
				if (hasTarget) {
					platformTargets.set(platformName, summary.targetInstanceId);
				}
			}

			return rows.filter(row => {
				const platformName = row.platform?.platformName;
				const targetInstanceId = platformTargets.get(platformName);
				if (!targetInstanceId) {
					return true;
				}
				return row.instanceId === targetInstanceId;
			});
		}

		return rows;
	}, [tree, latestCompletedByPlatform]);

	const selectedSource = selectedPlatformKey ? platformLookup.get(selectedPlatformKey) : null;

	const destinationOptions = useMemo(() => {
		if (!tree) {
			return [];
		}

		const instanceNodes = [];
		for (const host of tree.hosts || []) {
			for (const instance of host.instances || []) {
				instanceNodes.push(instance);
			}
		}
		for (const instance of tree.unassignedInstances || []) {
			instanceNodes.push(instance);
		}

		return instanceNodes
			.filter(instance => instance.instanceId !== selectedSource?.instanceId)
			.map(instance => ({
				label: `${instance.instanceName} (${instance.instanceId})`,
				value: instance.instanceId,
			}));
	}, [tree, selectedSource]);

	async function submitTransfer() {
		if (!selectedSource || selectedTargetInstance === null) {
			return;
		}

		setIsSubmitting(true);
		try {
			const response = await plugin.startTransfer({
				sourceInstanceId: selectedSource.instanceId,
				sourcePlatformIndex: selectedSource.platformIndex,
				targetInstanceId: Number(selectedTargetInstance),
				forceName: selectedSource.forceName || "player",
			});
			if (!response.success) {
				const errorDetails = [
					`Error: ${response.error || "Unknown error"}`,
					`Source: Instance ${selectedSource.instanceId} (${selectedSource.instanceName})`,
					`Platform: ${selectedSource.platformName} (index ${selectedSource.platformIndex})`,
					`Target: Instance ${selectedTargetInstance}`,
				].join(" | ");
				console.error("[Surface Export] Transfer failed:", errorDetails);
				throw new Error(response.error || "Transfer start failed");
			}
			console.info(`[Surface Export] Transfer started: ${response.transferId}`);
			antMessage.success(
				`Transfer started: ${response.transferId}`,
				5  // Show for 5 seconds
			);
		} catch (err) {
			console.error("[Surface Export] Transfer submission error:", err);
			antMessage.error(
				err.message || "Failed to start transfer",
				10  // Show error for 10 seconds
			);
		} finally {
			setIsSubmitting(false);
		}
	}

	const instanceColumns = [
		{
			title: "Host",
			dataIndex: "hostName",
			key: "hostName",
			width: "15%",
			render: (hostName, row) => (
				<Space>
					<Text>{hostName}</Text>
					{row.hostConnected !== null ? (
						<Tag color={row.hostConnected ? "green" : "default"}>
							{row.hostConnected ? "online" : "offline"}
						</Tag>
					) : null}
				</Space>
			),
		},
		{
			title: "Instance",
			dataIndex: "instanceName",
			key: "instanceName",
			width: "25%",
			render: (instanceName, row) => (
				<Space>
					<Text>{instanceName}</Text>
					<Tag color={row.instanceConnected ? "green" : "default"}>
						{row.instanceConnected ? "connected" : "disconnected"}
					</Tag>
					{row.instancePlatformError ? <Tag color="warning">error</Tag> : null}
				</Space>
			),
		},
		{
			title: "Platform",
			key: "platform",
			width: "40%",
			render: (_, row) => (
				<Space>
					<Text>{row.platform.platformName}</Text>
					<Tag color={statusColor(row.platform.transferStatus)}>
						{row.platform.transferStatus || "idle"}
					</Tag>
					{row.platform.hasSpaceHub === false ? (
						<Tag color="warning">no hub</Tag>
					) : null}
				</Space>
			),
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
			title: "Δ Prev",
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
	const entityExpectedTotal = Number(validation?.entityCount ?? entityRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0));
	const entityActualTotal = entityRows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
	const validationCategoryRows = useMemo(() => {
		if (!validation) {
			return [];
		}
		return [
			{
				key: "validation:entities",
				category: "Entities",
				expected: entityExpectedTotal,
				actual: entityActualTotal,
				delta: entityActualTotal - entityExpectedTotal,
				preservedPct: entityExpectedTotal > 0 ? (entityActualTotal / entityExpectedTotal) * 100 : null,
				status: Math.abs(entityActualTotal - entityExpectedTotal) <= 0.0001 ? "Match" : "Mismatch",
				detailCount: entityRows.length,
			},
			{
				key: "validation:items",
				category: "Items",
				expected: itemExpectedTotal,
				actual: itemActualTotal,
				delta: itemActualTotal - itemExpectedTotal,
				preservedPct: itemExpectedTotal > 0 ? (itemActualTotal / itemExpectedTotal) * 100 : null,
				status: validation.itemCountMatch ? "Match" : "Mismatch",
				detailCount: itemRows.length,
			},
			{
				key: "validation:fluids",
				category: "Fluids",
				expected: fluidExpectedTotal,
				actual: fluidActualTotal,
				delta: fluidActualTotal - fluidExpectedTotal,
				preservedPct: fluidExpectedTotal > 0 ? (fluidActualTotal / fluidExpectedTotal) * 100 : null,
				status: validation.fluidCountMatch ? "Match" : "Mismatch",
				detailCount: fluidInventoryRows.length,
			},
		];
	}, [
		validation,
		entityExpectedTotal,
		entityActualTotal,
		entityRows,
		itemExpectedTotal,
		itemActualTotal,
		itemRows,
		fluidExpectedTotal,
		fluidActualTotal,
		fluidInventoryRows,
	]);
	const validationCategoryColumns = [
		{
			title: "Category",
			dataIndex: "category",
			key: "category",
			render: value => <Text strong>{value}</Text>,
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
			title: "Δ",
			dataIndex: "delta",
			key: "delta",
			render: value => (
				<Text type={value === 0 ? undefined : value > 0 ? "success" : "danger"}>
					{formatSigned(value, 1)}
				</Text>
			),
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
			render: status => (
				<Tag color={status === "Match" ? "green" : "warning"}>
					{status}
				</Tag>
			),
		},
		{
			title: "Details",
			dataIndex: "detailCount",
			key: "detailCount",
			render: value => `${formatNumeric(value, 0)} rows`,
		},
	];

	return (
		<div className="surface-export-tab-body">
			<div className="surface-export-tree-panel">
				<Card title="Available Platforms">
					{loadingTree ? <Spin /> : null}
					{treeError ? <Alert type="error" showIcon message={treeError} /> : null}
					{!loadingTree && !instanceListData.length ? <Empty description="No platforms found" /> : null}
					{instanceListData.length ? (
						<Table
							size="small"
							columns={instanceColumns}
							dataSource={instanceListData}
							rowKey={row => row.key}
							pagination={{ pageSize: 15 }}
							rowClassName={row => row.key === selectedPlatformKey ? "surface-export-log-row-selected" : "surface-export-log-row"}
							onRow={row => ({
								onClick: () => {
									if (row.platform?.hasSpaceHub === false) {
										antMessage.warning("This platform does not have a space hub yet.");
										return;
									}
									setSelectedPlatformKey(row.key);
								},
							})}
						/>
					) : null}
				</Card>
			</div>

			<div className="surface-export-action-panel">
				<Card title="Manual Transfer">
					<Space direction="vertical" size="middle" style={{ width: "100%" }}>
						{selectedSource ? (
							<Alert
								type="info"
								showIcon
								message={`Source: ${selectedSource.platformName}`}
								description={`Instance ${selectedSource.instanceName} (${selectedSource.instanceId})`}
							/>
						) : (
							<Alert type="warning" showIcon message="Select a source platform in the tree" />
						)}

						<Select
							placeholder="Select destination instance"
							options={destinationOptions}
							value={selectedTargetInstance}
							onChange={setSelectedTargetInstance}
							disabled={!selectedSource}
						/>

						<Button
							type="primary"
							onClick={submitTransfer}
							disabled={!selectedSource || selectedTargetInstance === null}
							loading={isSubmitting}
						>
							Start Transfer
						</Button>
					</Space>
				</Card>
			</div>
		</div>
	);
}

function humanizeMetricKey(key) {
	return String(key || "")
		.replace(/_/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, text => text.toUpperCase());
}

function formatDuration(durationMs) {
	if (typeof durationMs !== "number" || Number.isNaN(durationMs)) {
		return "-";
	}
	if (durationMs >= 1000) {
		return `${(durationMs / 1000).toFixed(1)}s (${Math.round(durationMs).toLocaleString()}ms)`;
	}
	return `${Math.round(durationMs).toLocaleString()}ms`;
}

function formatNumeric(value, maxFractionDigits = 1) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return "-";
	}
	return value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

function formatSigned(value, maxFractionDigits = 1) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return "-";
	}
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits })}`;
}

function sumValues(map) {
	return Object.values(map || {}).reduce((total, value) => {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? total + numeric : total;
	}, 0);
}

function buildMetricRows(data) {
	if (!data || typeof data !== "object") {
		return [];
	}

	return Object.entries(data).map(([key, value]) => {
		let formattedValue = "-";
		if (typeof value === "boolean") {
			formattedValue = value ? "Yes" : "No";
		} else if (typeof value === "number") {
			const lowered = key.toLowerCase();
			if (lowered.endsWith("ms")) {
				formattedValue = `${formatNumeric(value, 0)} ms`;
			} else if (lowered.endsWith("ticks")) {
				formattedValue = `${formatNumeric(value, 0)} ticks`;
			} else if (lowered.endsWith("kb")) {
				formattedValue = `${formatNumeric(value, 1)} KB`;
			} else {
				formattedValue = formatNumeric(value, Number.isInteger(value) ? 0 : 1);
			}
		} else if (value !== null && value !== undefined) {
			formattedValue = String(value);
		}

		return {
			key,
			metric: humanizeMetricKey(key),
			value: formattedValue,
		};
	});
}

function buildExpectedActualRows(expectedMap, actualMap) {
	const expected = expectedMap || {};
	const actual = actualMap || {};
	const keys = new Set([ ...Object.keys(expected), ...Object.keys(actual) ]);
	const rows = [];
	for (const name of keys) {
		const expectedValue = Number(expected[name] || 0);
		const actualValue = Number(actual[name] || 0);
		const delta = actualValue - expectedValue;
		rows.push({
			key: name,
			name,
			expected: expectedValue,
			actual: actualValue,
			delta,
			preservedPct: expectedValue > 0 ? (actualValue / expectedValue) * 100 : null,
		});
	}
	rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
	return rows;
}

function parseFluidTemperatureKey(fluidKey) {
	const key = String(fluidKey || "");
	const match = key.match(/^(.*)@(-?\d+(?:\.\d+)?)C$/i);
	if (!match) {
		return {
			baseName: key,
			temperatureC: null,
			rawKey: key,
		};
	}
	return {
		baseName: match[1] || key,
		temperatureC: Number(match[2]),
		rawKey: key,
	};
}

function buildFluidInventoryRows(expectedMap, actualMap, highTempThreshold = 10000, highTempAggregates = {}) {
	const expected = expectedMap || {};
	const actual = actualMap || {};
	const aggregates = highTempAggregates || {};
	const threshold = Number.isFinite(Number(highTempThreshold)) ? Number(highTempThreshold) : 10000;
	const keys = new Set([ ...Object.keys(expected), ...Object.keys(actual) ]);
	const groups = new Map();

	for (const fluidKey of keys) {
		const expectedValue = Number(expected[fluidKey] || 0);
		const actualValue = Number(actual[fluidKey] || 0);
		const delta = actualValue - expectedValue;
		const parsed = parseFluidTemperatureKey(fluidKey);
		const isHighTemp = parsed.temperatureC !== null && parsed.temperatureC >= threshold;
		const baseName = parsed.baseName || fluidKey;

		if (!groups.has(baseName)) {
			groups.set(baseName, {
				baseName,
				expected: 0,
				actual: 0,
				hasHighTempBucket: false,
				children: [],
			});
		}

		const group = groups.get(baseName);
		group.expected += expectedValue;
		group.actual += actualValue;
		group.hasHighTempBucket = group.hasHighTempBucket || isHighTemp;
		group.children.push({
			key: `fluid:bucket:${fluidKey}`,
			name: baseName,
			bucketKey: fluidKey,
			tempBucket: parsed.temperatureC === null ? "-" : `${formatNumeric(parsed.temperatureC, 1)}°C`,
			category: isHighTemp ? "High-temp" : "Normal",
			expected: expectedValue,
			actual: actualValue,
			delta,
			preservedPct: expectedValue > 0 ? (actualValue / expectedValue) * 100 : null,
			isGroup: false,
			status: "Match",
			reconciled: false,
		});
	}

	const rows = [];
	for (const group of groups.values()) {
		const delta = group.actual - group.expected;
		const category = group.hasHighTempBucket ? "High-temp" : "Normal";
		const aggregate = aggregates[group.baseName];
		const reconciledHighTemp = category === "High-temp"
			? Boolean(aggregate?.reconciled ?? Math.abs(delta) <= 1)
			: false;

		const children = group.children
			.map(child => {
				const absDelta = Math.abs(child.delta);
				let status = "Match";
				if (child.category === "High-temp" && reconciledHighTemp) {
					status = absDelta > 0.0001 ? "Bucket drift (reconciled)" : "Match";
				} else if (absDelta > 0.0001) {
					status = "Mismatch";
				}
				return {
					...child,
					status,
					reconciled: child.category === "High-temp" ? reconciledHighTemp : absDelta <= 0.0001,
				};
			})
			.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.bucketKey.localeCompare(b.bucketKey));

		rows.push({
			key: `fluid:group:${group.baseName}`,
			name: group.baseName,
			category,
			expected: group.expected,
			actual: group.actual,
			delta,
			preservedPct: group.expected > 0 ? (group.actual / group.expected) * 100 : null,
			isGroup: true,
			status: category === "High-temp"
				? (reconciledHighTemp ? "Reconciled aggregate" : (Math.abs(delta) <= 0.0001 ? "Match" : "Mismatch"))
				: (Math.abs(delta) <= 0.0001 ? "Match" : "Mismatch"),
			reconciled: category === "High-temp" ? reconciledHighTemp : Math.abs(delta) <= 0.0001,
			children,
		});
	}

	rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
	return rows;
}

function findLatestEvent(events, predicate) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (predicate(events[index])) {
			return events[index];
		}
	}
	return null;
}

function buildDetailedLogSummary(detail, transferId) {
	const transferInfo = detail?.transferInfo || null;
	const events = Array.isArray(detail?.events) ? detail.events : [];
	const summary = detail?.summary && typeof detail.summary === "object" ? detail.summary : {};

	const transferCreatedEvent = findLatestEvent(events, event => event?.eventType === "transfer_created");
	const validationEvent = findLatestEvent(events, event => (
		event?.eventType === "validation_received"
		|| event?.eventType === "validation_failed"
		|| event?.validation
	));
	const completionEvent = findLatestEvent(events, event => (
		event?.eventType === "transfer_completed"
		|| event?.eventType === "transfer_failed"
	));
	const latestEvent = events.length ? events[events.length - 1] : null;

	const status = transferInfo?.status || summary.status || "unknown";
	let result = summary.result;
	if (!result) {
		if (status === "completed") {
			result = "SUCCESS";
		} else if ([ "failed", "error", "cleanup_failed" ].includes(status)) {
			result = "FAILED";
		} else {
			result = "IN_PROGRESS";
		}
	}

	const startedAt = transferInfo?.startedAt || summary.startedAt || transferCreatedEvent?.timestampMs || null;
	const completedAt = transferInfo?.completedAt || summary.completedAt || null;
	const failedAt = transferInfo?.failedAt || summary.failedAt || null;
	const lastEventAt = summary.lastEventAt || latestEvent?.timestampMs || null;
	const finishedAt = completedAt || failedAt || completionEvent?.timestampMs || lastEventAt;
	let totalDurationMs = typeof summary.totalDurationMs === "number" ? summary.totalDurationMs : null;
	if (totalDurationMs === null && startedAt && finishedAt) {
		totalDurationMs = Math.max(0, finishedAt - startedAt);
	}
	if (totalDurationMs === null && typeof completionEvent?.durationMs === "number") {
		totalDurationMs = completionEvent.durationMs;
	}

	const validation = summary.validation || validationEvent?.validation || null;
	let sourceVerification = summary.sourceVerification || transferCreatedEvent?.sourceVerification || null;
	if (!sourceVerification && validation) {
		sourceVerification = {
			itemCounts: validation.expectedItemCounts || {},
			fluidCounts: validation.expectedFluidCounts || {},
		};
	}

	return {
		transferId,
		result,
		status,
		totalDurationMs,
		totalDurationStr: summary.totalDurationStr || formatDuration(totalDurationMs),
		phases: summary.phases || completionEvent?.phases || {},
		platform: summary.platform || {
			name: transferInfo?.platformName || "Unknown",
			source: {
				instanceId: transferInfo?.sourceInstanceId ?? -1,
				instanceName: transferInfo?.sourceInstanceName ?? null,
			},
			destination: {
				instanceId: transferInfo?.targetInstanceId ?? -1,
				instanceName: transferInfo?.targetInstanceName ?? null,
			},
		},
		export: summary.export || transferCreatedEvent?.exportMetrics || null,
		payload: summary.payload || completionEvent?.payloadMetrics || transferCreatedEvent?.payloadMetrics || null,
		import: summary.import || completionEvent?.importMetrics || validationEvent?.importMetrics || null,
		validation,
		sourceVerification,
		startedAt,
		completedAt,
		failedAt,
		lastEventAt,
		error: summary.error || transferInfo?.error || null,
	};
}

function TransactionLogsTab({ plugin, state }) {
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
			title: "Δ",
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
			title: "Δ",
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

function SurfaceExportPage() {
	const control = useContext(ControlContext);
	const plugin = useSurfaceExportPlugin(control);
	const state = useSurfaceExportState(plugin);
	const pluginVersion = state?.pluginVersion || null;
	const tabItems = [
		{
			key: "manual",
			label: "Manual Transfer",
			children: <ManualTransferTab plugin={plugin} state={state} />,
		},
	];
	if (state.canViewLogs !== false) {
		tabItems.push({
			key: "logs",
			label: "Transaction Logs",
			children: <TransactionLogsTab plugin={plugin} state={state} />,
		});
	}

	return (
		<PageLayout nav={[{ name: "Surface Export" }]}>
			<PageHeader title="Surface Export" />
			{pluginVersion ? (
				<Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
					v{pluginVersion}
				</Text>
			) : null}
			<Tabs
				defaultActiveKey="manual"
				items={tabItems}
			/>
		</PageLayout>
	);
}

export class WebPlugin extends BaseWebPlugin {
	constructor(container, packageData, info, control, logger) {
		super(container, packageData, info, control, logger);
		this.callbacks = [];
		this.liveUpdatesEnabled = false;
		this.state = {
			tree: null,
			loadingTree: false,
			treeError: null,
			transferSummaries: [],
			logDetails: {},
			lastTreeRevision: 0,
			lastTransferRevision: 0,
			lastLogRevision: 0,
			canViewLogs: true,
			pluginVersion: packageData?.version || null,
		};
	}

	async init() {
		this.pages = [
			{
				path: "/surface-export",
				sidebarName: "Surface Export",
				permission: PERMISSIONS.UI_VIEW,
				content: <SurfaceExportPage />,
			},
		];

		this.control.handle(SurfaceExportTreeUpdateEvent, this.handleTreeUpdate.bind(this));
		this.control.handle(SurfaceExportTransferUpdateEvent, this.handleTransferUpdate.bind(this));
		this.control.handle(SurfaceExportLogUpdateEvent, this.handleLogUpdate.bind(this));
	}

	onControllerConnectionEvent(event) {
		if (event === "connect" || event === "resume") {
			this.syncLiveState().catch(notifyErrorHandler("Failed to resubscribe Surface Export live updates"));
		}
	}

	getState() {
		return this.state;
	}

	setState(partial) {
		this.state = { ...this.state, ...partial };
		for (const callback of this.callbacks) {
			callback();
		}
	}

	onUpdate(callback) {
		this.callbacks.push(callback);
		this.syncLiveState().catch(notifyErrorHandler("Failed to start Surface Export live updates"));
	}

	offUpdate(callback) {
		const index = this.callbacks.lastIndexOf(callback);
		if (index !== -1) {
			this.callbacks.splice(index, 1);
		}
		this.syncLiveState().catch(notifyErrorHandler("Failed to update Surface Export subscription"));
	}

	async syncLiveState() {
		const shouldEnable = this.callbacks.length > 0;
		if (!this.control.connector.connected) {
			this.liveUpdatesEnabled = shouldEnable;
			return;
		}
		const trySubscribe = logs => this.control.send(new SetSurfaceExportSubscriptionRequest({
			tree: shouldEnable,
			transfers: shouldEnable,
			logs,
			transferId: null,
		}));
		let logsEnabled = shouldEnable && this.state.canViewLogs !== false;
		try {
			await trySubscribe(logsEnabled);
		} catch (err) {
			if (logsEnabled && /permission denied/i.test(err?.message || "")) {
				logsEnabled = false;
				this.setState({ canViewLogs: false });
				await trySubscribe(false);
			} else {
				throw err;
			}
		}

		this.liveUpdatesEnabled = shouldEnable;
		if (shouldEnable) {
			await this.refreshSnapshots();
		}
	}

	async refreshSnapshots() {
		this.setState({ loadingTree: true, treeError: null });
		try {
			const treeResponse = await this.control.send(new GetPlatformTreeRequest({ forceName: "player" }));
			let transferSummaries = this.state.transferSummaries;
			if (this.state.canViewLogs !== false) {
				try {
					const logSummaries = await this.control.send(new ListTransactionLogsRequest({ limit: 100 }));
					transferSummaries = Array.isArray(logSummaries)
						? [...logSummaries].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
						: [];
				} catch (err) {
					if (/permission denied/i.test(err?.message || "")) {
						this.setState({ canViewLogs: false });
						transferSummaries = [];
					} else {
						throw err;
					}
				}
			}

			this.setState({
				tree: {
					forceName: treeResponse.forceName,
					hosts: treeResponse.hosts || [],
					unassignedInstances: treeResponse.unassignedInstances || [],
					revision: treeResponse.revision,
					generatedAt: treeResponse.generatedAt,
				},
				transferSummaries,
				loadingTree: false,
				treeError: null,
			});
		} catch (err) {
			this.setState({
				loadingTree: false,
				treeError: err.message || "Failed to refresh Surface Export state",
			});
		}
	}

	async startTransfer(payload) {
		return this.control.send(new StartPlatformTransferRequest(payload));
	}

	async loadTransactionLog(transferId) {
		const response = await this.control.send(new GetTransactionLogRequest({ transferId }));
		if (!response.success) {
			throw new Error(response.error || "Failed to load transaction log");
		}

		const existing = this.state.logDetails[transferId] || {};
		const transferInfo = response.transferInfo || existing.transferInfo || null;
		const events = Array.isArray(response.events) ? response.events : existing.events || [];
		const detail = {
			transferInfo,
			summary: response.summary || existing.summary || null,
			events,
		};

		const transferSummary = summaryFromTransferInfo(transferInfo, events.length ? events[events.length - 1].timestampMs : null);
		if (transferSummary) {
			transferSummary.transferId = transferId;
		}

		this.setState({
			logDetails: {
				...this.state.logDetails,
				[transferId]: detail,
			},
			transferSummaries: transferSummary
				? mergeTransferSummary(this.state.transferSummaries, transferSummary)
				: this.state.transferSummaries,
		});
	}

	async handleTreeUpdate(event) {
		if (event.revision <= this.state.lastTreeRevision) {
			return;
		}

		this.setState({
			tree: {
				forceName: event.forceName,
				hosts: event.tree?.hosts || [],
				unassignedInstances: event.tree?.unassignedInstances || [],
				revision: event.revision,
				generatedAt: event.generatedAt,
			},
			loadingTree: false,
			treeError: null,
			lastTreeRevision: event.revision,
		});
	}

	async handleTransferUpdate(event) {
		if (event.revision <= this.state.lastTransferRevision) {
			return;
		}

		this.setState({
			transferSummaries: mergeTransferSummary(this.state.transferSummaries, event.transfer),
			lastTransferRevision: event.revision,
		});
	}

	async handleLogUpdate(event) {
		if (event.revision <= this.state.lastLogRevision) {
			return;
		}

		const existing = this.state.logDetails[event.transferId] || { events: [] };
		const events = [...existing.events];
		const incoming = event.event || {};
		const lastEvent = events.length ? events[events.length - 1] : null;
		const isDuplicate = lastEvent
			&& lastEvent.timestampMs === incoming.timestampMs
			&& lastEvent.eventType === incoming.eventType
			&& lastEvent.message === incoming.message;
		if (!isDuplicate) {
			events.push(incoming);
		}

		const detail = {
			transferInfo: event.transferInfo || existing.transferInfo || null,
			summary: event.summary || existing.summary || null,
			events,
		};

		let transferSummary = null;
		if (event.transferInfo) {
			transferSummary = summaryFromTransferInfo(event.transferInfo, incoming.timestampMs || null);
			transferSummary.transferId = event.transferId;
		}

		this.setState({
			logDetails: {
				...this.state.logDetails,
				[event.transferId]: detail,
			},
			transferSummaries: transferSummary
				? mergeTransferSummary(this.state.transferSummaries, transferSummary)
				: this.state.transferSummaries,
			lastLogRevision: event.revision,
		});
	}
}
