"use strict";

export function statusColor(status) {
	switch (status) {
	case "transporting":
	case "in_progress":
		return "processing";
	case "awaiting_validation":
	case "awaiting_completion":
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

export function summaryFromTransferInfo(transferInfo, lastEventAt = null) {
	if (!transferInfo) {
		return null;
	}

	return {
		transferId: transferInfo.transferId || transferInfo.id || null,
		operationType: transferInfo.operationType || "transfer",
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

export function mergeTransferSummary(existing, incoming) {
	const byId = new Map((existing || []).map(summary => [summary.transferId, summary]));
	if (incoming && incoming.transferId) {
		byId.set(incoming.transferId, { ...byId.get(incoming.transferId), ...incoming });
	}

	return Array.from(byId.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function humanizeMetricKey(key) {
	return String(key || "")
		.replace(/_/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, text => text.toUpperCase());
}

export function formatDuration(durationMs) {
	if (typeof durationMs !== "number" || Number.isNaN(durationMs)) {
		return "-";
	}
	if (durationMs >= 1000) {
		return `${(durationMs / 1000).toFixed(1)}s (${Math.round(durationMs).toLocaleString()}ms)`;
	}
	return `${Math.round(durationMs).toLocaleString()}ms`;
}

export function formatNumeric(value, maxFractionDigits = 1) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return "-";
	}
	return value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

export function formatSigned(value, maxFractionDigits = 1) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return "-";
	}
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits })}`;
}

export function sumValues(map) {
	return Object.values(map || {}).reduce((total, value) => {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? total + numeric : total;
	}, 0);
}

export function buildMetricRows(data) {
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

const EXPORT_METRIC_DEFINITIONS = {
	requestExportAndLockMs: {
		order: 10,
		label: "Queue + lock request",
		description: "Controller→source request time to queue export and lock the platform.",
		format: "ms",
	},
	waitForControllerStoreMs: {
		order: 20,
		label: "Wait for controller store",
		description: "Time waiting for exported payload to arrive and be stored on the controller.",
		format: "ms",
	},
	controllerExportPrepTotalMs: {
		order: 30,
		label: "Controller prep total",
		description: "End-to-end prep window before transmit (request + controller store wait).",
		format: "ms",
	},
	instanceAsyncExportTicks: {
		order: 40,
		label: "Async export runtime (ticks)",
		description: "Source instance export runtime measured in game ticks.",
		format: "ticks",
	},
	instanceAsyncExportMs: {
		order: 50,
		label: "Async export runtime",
		description: "Source instance export runtime converted to milliseconds.",
		format: "ms",
	},
	instanceAsyncExportSeconds: {
		order: 60,
		label: "Async export runtime (seconds)",
		description: "Source instance export runtime in seconds.",
		format: "seconds",
	},
	exportedEntityCount: {
		order: 70,
		label: "Exported entities",
		description: "Entity count serialized into the export payload.",
		format: "count",
	},
	exportedTileCount: {
		order: 80,
		label: "Exported tiles",
		description: "Tile count serialized into the export payload.",
		format: "count",
	},
	scheduleRecordCount: {
		order: 90,
		label: "Schedule records exported",
		description: "Number of LuaSpacePlatform schedule stations/records exported.",
		format: "count",
	},
	scheduleInterruptCount: {
		order: 100,
		label: "Schedule interrupts exported",
		description: "Number of LuaSpacePlatform schedule interrupts exported.",
		format: "count",
	},
	atomicBeltEntitiesScanned: {
		order: 110,
		label: "Atomic belt entities scanned",
		description: "Belt entities scanned in the single-tick atomic belt pass.",
		format: "count",
	},
	atomicBeltItemStacksCaptured: {
		order: 120,
		label: "Atomic belt item stacks captured",
		description: "Belt item stacks captured during the atomic belt scan.",
		format: "count",
	},
	uncompressedPayloadBytes: {
		order: 130,
		label: "Uncompressed payload size",
		description: "Payload size before compression.",
		format: "bytes",
	},
	compressedPayloadBytes: {
		order: 140,
		label: "Compressed payload size",
		description: "Payload size after compression.",
		format: "bytes",
	},
	compressionReductionPct: {
		order: 150,
		label: "Compression reduction",
		description: "Compression size reduction percentage.",
		format: "percent",
	},
};

function formatBytes(value) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return "-";
	}
	if (numeric < 1024) {
		return `${formatNumeric(numeric, 0)} B`;
	}
	const kb = numeric / 1024;
	if (kb < 1024) {
		return `${formatNumeric(kb, 1)} KB`;
	}
	return `${formatNumeric(kb / 1024, 2)} MB`;
}

function formatExportMetricValue(value, format) {
	const numeric = Number(value);
	if (format === "ms") {
		return Number.isFinite(numeric) ? `${formatNumeric(numeric, 0)} ms` : "-";
	}
	if (format === "ticks") {
		return Number.isFinite(numeric) ? `${formatNumeric(numeric, 0)} ticks` : "-";
	}
	if (format === "seconds") {
		return Number.isFinite(numeric) ? `${formatNumeric(numeric, 2)} s` : "-";
	}
	if (format === "count") {
		return Number.isFinite(numeric) ? formatNumeric(numeric, 0) : "-";
	}
	if (format === "bytes") {
		return formatBytes(value);
	}
	if (format === "percent") {
		return Number.isFinite(numeric) ? `${formatNumeric(numeric, 1)}%` : "-";
	}
	if (typeof value === "boolean") {
		return value ? "Yes" : "No";
	}
	if (Number.isFinite(numeric)) {
		return formatNumeric(numeric, Number.isInteger(numeric) ? 0 : 2);
	}
	return value === null || value === undefined ? "-" : String(value);
}

export function buildExportMetricRows(data) {
	if (!data || typeof data !== "object") {
		return [];
	}

	const rows = Object.entries(data).map(([key, value]) => {
		const def = EXPORT_METRIC_DEFINITIONS[key] || null;
		return {
			key,
			order: def?.order ?? 10000,
			metric: def?.label || humanizeMetricKey(key),
			value: formatExportMetricValue(value, def?.format),
			details: def?.description || "Extended export metric.",
		};
	});

	rows.sort((a, b) => a.order - b.order || a.metric.localeCompare(b.metric));
	return rows;
}

export function buildExpectedActualRows(expectedMap, actualMap) {
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

export function parseFluidTemperatureKey(fluidKey) {
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

export function buildFluidInventoryRows(expectedMap, actualMap, highTempThreshold = 10000, highTempAggregates = {}) {
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
			tempBucket: parsed.temperatureC === null ? "-" : `${formatNumeric(parsed.temperatureC, 1)}\u00B0C`,
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

export function findLatestEvent(events, predicate) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (predicate(events[index])) {
			return events[index];
		}
	}
	return null;
}

export function buildDetailedLogSummary(detail, transferId) {
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
	const operationType = transferInfo?.operationType || summary.operationType || "transfer";
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
		operationType,
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
