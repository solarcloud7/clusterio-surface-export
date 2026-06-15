
import type { JsonObject, LogEvent, TransferSummary } from "./view-models";
import type { GanttRowInput, GanttRow } from "./view-models";

// Type-safe helpers for accessing JsonObject properties
function getString(obj: JsonObject, key: string, fallback: string): string;
function getString(obj: JsonObject, key: string, fallback?: null): string | null;
function getString(obj: JsonObject, key: string, fallback: string | null = null): string | null {
	const val = obj[key];
	return typeof val === "string" ? val : fallback;
}

function getNumber(obj: JsonObject, key: string, fallback: number): number;
function getNumber(obj: JsonObject, key: string, fallback?: null): number | null;
function getNumber(obj: JsonObject, key: string, fallback: number | null = null): number | null {
	const val = obj[key];
	return typeof val === "number" ? val : fallback;
}

function getBool(obj: JsonObject, key: string, fallback = false): boolean {
	const val = obj[key];
	return typeof val === "boolean" ? val : fallback;
}

export function getProp<T>(obj: object | null | undefined, key: string, fallback: T): T {
	if (!obj || typeof obj !== "object") {
		return fallback;
	}
	const val = (obj as Record<string, unknown>)[key];
	return val !== undefined && val !== null ? (val as T) : fallback;
}

export function getErrorMessage(err: unknown, fallback = "Unknown error") {
	if (err instanceof Error) {
		return err.message || fallback;
	}
	if (typeof err === "string") {
		return err || fallback;
	}
	if (err && typeof err === "object" && "message" in err) {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && message) {
			return message;
		}
	}
	return fallback;
}

export function statusColor(status: string) {
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

export function summaryFromTransferInfo(transferInfo: JsonObject | null, lastEventAt: number | null = null): TransferSummary | null {
	if (!transferInfo) {
		return null;
	}

	return {
		transferId: getString(transferInfo, "transferId", null) || getString(transferInfo, "id", null) || "",
		operationType: getString(transferInfo, "operationType", "transfer") as TransferSummary["operationType"],
		exportId: getString(transferInfo, "exportId", null),
		artifactSizeBytes: getNumber(transferInfo, "artifactSizeBytes", null),
		downloadable: false,
		platformName: getString(transferInfo, "platformName", "Unknown"),
		sourceInstanceId: getNumber(transferInfo, "sourceInstanceId", -1),
		sourceInstanceName: getString(transferInfo, "sourceInstanceName", null),
		targetInstanceId: getNumber(transferInfo, "targetInstanceId", -1),
		targetInstanceName: getString(transferInfo, "targetInstanceName", null),
		status: getString(transferInfo, "status", "unknown"),
		startedAt: getNumber(transferInfo, "startedAt", Date.now()),
		completedAt: getNumber(transferInfo, "completedAt", null),
		failedAt: getNumber(transferInfo, "failedAt", null),
		error: getString(transferInfo, "error", null),
		lastEventAt,
	};
}

export function mergeTransferSummary(existing: TransferSummary[], incoming: TransferSummary | null) {
	const byId = new Map((existing || []).map(summary => [summary.transferId, summary]));
	if (incoming && incoming.transferId) {
		byId.set(incoming.transferId, { ...byId.get(incoming.transferId), ...incoming });
	}

	return Array.from(byId.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export function humanizeMetricKey(key: string) {
	return String(key || "")
		.replace(/_/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^./, text => text.toUpperCase());
}

export function formatDuration(durationMs: number | null) {
	if (typeof durationMs !== "number" || Number.isNaN(durationMs)) {
		return "-";
	}
	if (durationMs >= 1000) {
		return `${(durationMs / 1000).toFixed(1)}s (${Math.round(durationMs).toLocaleString()}ms)`;
	}
	return `${Math.round(durationMs).toLocaleString()}ms`;
}

export function formatNumeric(value: number | null, maxFractionDigits = 1) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return "-";
	}
	return value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits });
}

export function formatCompactEnergy(value: number | null) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return "-";
	}
	const abs = Math.abs(value);
	if (abs >= 1e9) {
		return `${(value / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })}B`;
	}
	if (abs >= 1e6) {
		return `${(value / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
	}
	if (abs >= 1e3) {
		return `${(value / 1e3).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
	}
	return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function formatSigned(value: number | null, maxFractionDigits = 1) {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return "-";
	}
	const sign = value > 0 ? "+" : "";
	return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: maxFractionDigits })}`;
}

// Ordered operation count definitions — merged export+import, displayed in combined table.
// "source" indicates which data object the field comes from: "export" or "import".
export const OPERATION_COUNT_DEFINITIONS = [
	{ key: "exportedEntityCount",        source: "export", label: "Entities" },
	{ key: "exportedTileCount",          source: "export", label: "Tiles" },
	{ key: "belt_items_restored",        source: "import", label: "Belt items restored" },
	{ key: "fluids_restored",            source: "import", label: "Fluid segments restored" },
	{ key: "circuits_connected",         source: "import", label: "Circuits connected" },
	{ key: "scheduleRecordCount",        source: "export", label: "Schedule records" },
	{ key: "scheduleInterruptCount",     source: "export", label: "Schedule interrupts" },
	{ key: "atomicBeltEntitiesScanned",  source: "export", label: "Belt entities scanned" },
	{ key: "atomicBeltItemStacksCaptured", source: "export", label: "Belt item stacks captured" },
];

export function buildOperationCountRows(exportData: JsonObject | null | undefined, importData: JsonObject | null | undefined) {
	const rows = [];
	for (const def of OPERATION_COUNT_DEFINITIONS) {
		const raw = def.source === "export" ? exportData?.[def.key] : importData?.[def.key];
		const value = Number(raw ?? 0);
		if (value === 0) continue;
		rows.push({ key: def.key, metric: def.label, value: value.toLocaleString() });
	}
	return rows;
}

export function buildGanttRows(events: Array<LogEvent>, detailedSummary: JsonObject | null): { totalMs: number; rows: GanttRow[] } {
	// Produce one row per named phase across all events.
	// Each row: { key, label, isEvent, indent, startMs, endMs, durationMs, color }
	// All times are absolute ms from transfer start (elapsedMs of first event = 0).
	const rows: GanttRowInput[] = [];
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
			const lockMs = Number(getProp(exportMetrics as JsonObject, "requestExportAndLockMs", 0));
			const storeMs = Number(getProp(exportMetrics as JsonObject, "waitForControllerStoreMs", 0));
			const asyncMs = Number(getProp(exportMetrics as JsonObject, "instanceAsyncExportMs", 0));
			const ticks = Number(getProp(exportMetrics as JsonObject, "instanceAsyncExportTicks", 0));
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
			const m = event.importMetrics as JsonObject;
			const eventStart = elapsedMs ?? 0;
			const tilesMs = Number(getProp(m, "tiles_ms", 0));
			const tilesCount = Number(getProp(m, "tiles_placed", 0));
			const entitiesMs = Number(getProp(m, "entities_ms", 0));
			const entitiesCount = Number(getProp(m, "entities_created", 0));
			const fluidsMs = Number(getProp(m, "fluids_ms", 0));
			const fluidsCount = Number(getProp(m, "fluids_restored", 0));
			const totalImportMs = Number(getProp(m, "total_ms", 0));
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
		rows: rows.map((row, i): GanttRow => {
			const startMs = row.startMs;
			const endMs = row.endMs;
			return {
				...row,
				key: `${row.key}#${i}`,
				ganttStartPct: Math.max(0, Math.min(100, (startMs / scale) * 100)),
				ganttWidthPct: endMs > startMs
					? Math.max(0.8, Math.min(100 - (startMs / scale) * 100, ((endMs - startMs) / scale) * 100))
					: 0,
				ganttMarkerPct: Math.max(0, Math.min(100, (endMs / scale) * 100)),
			};
		}),
	};
}

export function formatBytes(value: number | null) {
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

export function sanitizeTimestamp(timestamp: number | string | null) {
	return new Date(timestamp || Date.now()).toISOString().replace(/[:.]/g, "-");
}

export function parseJsonFile(file: File) {
	return new Promise<JsonObject>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				resolve(JSON.parse(String(reader.result || "")) as JsonObject);
			} catch (err) {
				reject(err);
			}
		};
		reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
		reader.readAsText(file);
	});
}

export function downloadJsonFile(data: Record<string, unknown>, filename: string) {
	const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}

export function buildExpectedActualRows(expectedMap: Record<string, number> | null | undefined, actualMap: Record<string, number> | null | undefined) {
	const expected = expectedMap || {};
	const actual = actualMap || {};
	const keys = new Set([ ...Object.keys(expected), ...Object.keys(actual) ]);
	const rows: ExpectedActualRow[] = [];
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

export type ExpectedActualRow = {
	key: string;
	name: string;
	expected: number;
	actual: number;
	delta: number;
	preservedPct: number | null;
};

export function parseFluidTemperatureKey(fluidKey: string) {
	const key = String(fluidKey || "");
	const match = key.match(/^(.*)@(-?\d+(?:\.\d+)?)C$/i);
	if (!match) {
		return {
			baseName: key,
			temperatureC: null as number | null,
			rawKey: key,
		};
	}
	return {
		baseName: match[1] || key,
		temperatureC: Number(match[2]),
		rawKey: key,
	};
}

export type FluidInventoryRow = {
	key: string;
	name: string;
	tempDisplay: string | null;
	category: string;
	expected: number;
	actual: number;
	delta: number;
	preservedPct: number | null;
	isGroup: boolean;
	status: string;
	reconciled: boolean;
	isThermalSummary?: boolean;
};

export function buildFluidInventoryRows(expectedMap: Record<string, number> | null | undefined, actualMap: Record<string, number> | null | undefined, highTempThreshold = 10000, highTempAggregates: JsonObject = {}) {
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
				buckets: [],
			});
		}

		const group = groups.get(baseName);
		group.expected += expectedValue;
		group.actual += actualValue;
		group.hasHighTempBucket = group.hasHighTempBucket || isHighTemp;
		group.buckets.push({
			fluidKey,
			tempBucket: parsed.temperatureC === null ? null : `${formatNumeric(parsed.temperatureC, 1)}°C`,
			category: isHighTemp ? "High-temp" : "Normal",
			expected: expectedValue,
			actual: actualValue,
			delta,
			preservedPct: expectedValue > 0 ? (actualValue / expectedValue) * 100 : null,
		});
	}

	const rows: Array<FluidInventoryRow> = [];
	for (const group of groups.values()) {
		const delta = group.actual - group.expected;
		const category = group.hasHighTempBucket ? "High-temp" : "Normal";
		const aggregate = aggregates[group.baseName];
		const aggregateRec = typeof aggregate === "object" && aggregate !== null && "reconciled" in aggregate
			? (aggregate.reconciled as boolean)
			: Math.abs(delta) <= 1;
		const reconciledHighTemp = category === "High-temp" ? Boolean(aggregateRec) : false;
		const expEnergy = typeof aggregate === "object" && aggregate !== null && "expectedEnergy" in aggregate
			? (aggregate.expectedEnergy as number)
			: 0;
		const actEnergy = typeof aggregate === "object" && aggregate !== null && "actualEnergy" in aggregate
			? (aggregate.actualEnergy as number)
			: 0;
		const hasThermalData = expEnergy > 0;

		if (category === "High-temp" && reconciledHighTemp && hasThermalData) {
			// High-temp with thermal energy: single row with icon+name + thermal energy values.
			// "High-temp (V×T)" label replaces the redundant volume aggregate row.
			const energyDelta = actEnergy - expEnergy;
			const energyPrecision = expEnergy > 0 ? (actEnergy / expEnergy) * 100 : 100;
			rows.push({
				key: `fluid:thermal:${group.baseName}`,
				name: group.baseName,
				tempDisplay: "High-temp (V×T)",
				category,
				expected: expEnergy,
				actual: actEnergy,
				delta: energyDelta,
				preservedPct: energyPrecision,
				isGroup: true,
				isThermalSummary: true,
				status: energyPrecision >= 99.0 ? "Thermal match" : "Thermal drift",
				reconciled: true,
			});
		} else if (group.buckets.length === 1) {
			// Single bucket — flat row: icon + name + temperature inline
			const bucket = group.buckets[0];
			const absDelta = Math.abs(bucket.delta);
			let status;
			if (category === "High-temp" && reconciledHighTemp) {
				status = absDelta > 0.0001 ? "Bucket drift (reconciled)" : "Match";
			} else {
				status = absDelta > 0.0001 ? "Mismatch" : "Match";
			}
			rows.push({
				key: `fluid:bucket:${bucket.fluidKey}`,
				name: group.baseName,
				tempDisplay: bucket.tempBucket,
				category,
				expected: bucket.expected,
				actual: bucket.actual,
				delta: bucket.delta,
				preservedPct: bucket.preservedPct,
				isGroup: true,
				status,
				reconciled: category === "High-temp" ? reconciledHighTemp : absDelta <= 0.0001,
			});
		} else {
			// Multiple normal-temp buckets — aggregate row + per-bucket rows
			const groupStatus = Math.abs(delta) <= 0.0001 ? "Match" : "Mismatch";
			rows.push({
				key: `fluid:group:${group.baseName}`,
				name: group.baseName,
				tempDisplay: null,
				category,
				expected: group.expected,
				actual: group.actual,
				delta,
				preservedPct: group.expected > 0 ? (group.actual / group.expected) * 100 : null,
				isGroup: true,
				status: groupStatus,
				reconciled: Math.abs(delta) <= 0.0001,
			});
			const sortedBuckets = [...group.buckets]
				.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.fluidKey.localeCompare(b.fluidKey));
			for (const bucket of sortedBuckets) {
				const absDelta = Math.abs(bucket.delta);
				rows.push({
					key: `fluid:bucket:${bucket.fluidKey}`,
					name: group.baseName,
					tempDisplay: bucket.tempBucket,
					category,
					expected: bucket.expected,
					actual: bucket.actual,
					delta: bucket.delta,
					preservedPct: bucket.preservedPct,
					isGroup: false,
					status: absDelta > 0.0001 ? "Mismatch" : "Match",
					reconciled: absDelta <= 0.0001,
				});
			}
		}
	}

	rows.sort((a, b) => {
		// Keep thermal child rows immediately after their group row
		if (a.isThermalSummary || (!a.isGroup && !a.isThermalSummary)) return 0;
		return Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name);
	});
	// Stable sort: group rows first by delta, then thermal/bucket rows follow their group
	const grouped = [];
	const seen = new Set();
	const allGroupKeys = rows.filter(r => r.isGroup).map(r => r.name);
	for (const groupRow of rows.filter(r => r.isGroup).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name))) {
		if (seen.has(groupRow.name)) continue;
		seen.add(groupRow.name);
		grouped.push(groupRow);
		for (const child of rows.filter(r => !r.isGroup && r.name === groupRow.name)) {
			grouped.push(child);
		}
	}
	return grouped;
}

export function findLatestEvent(events: Array<LogEvent>, predicate: (event: LogEvent) => boolean) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		if (predicate(events[index])) {
			return events[index];
		}
	}
	return null;
}

export function buildDetailedLogSummary(detail: JsonObject, transferId: string) {
	const transferInfoRaw = detail?.transferInfo;
	const transferInfo = transferInfoRaw && typeof transferInfoRaw === "object" && !Array.isArray(transferInfoRaw)
		? transferInfoRaw as JsonObject
		: null;
	const events = Array.isArray(detail?.events) ? detail.events as LogEvent[] : [];
	const summaryRaw = detail?.summary;
	const summary = summaryRaw && typeof summaryRaw === "object" && !Array.isArray(summaryRaw)
		? summaryRaw as JsonObject
		: {} as JsonObject;

	const transferCreatedEvent = findLatestEvent(events, event => event?.eventType === "transfer_created");
	const validationEvent = findLatestEvent(events, event => {
		const hasValidation = event && typeof event === "object" && "validation" in event;
		return event?.eventType === "validation_received"
			|| event?.eventType === "validation_failed"
			|| hasValidation;
	});
	const completionEvent = findLatestEvent(events, event => (
		event?.eventType === "transfer_completed"
		|| event?.eventType === "transfer_failed"
	));
	const latestEvent = events.length ? events[events.length - 1] : null;

	const status = (transferInfo ? getString(transferInfo, "status", null) : null)
		|| getString(summary, "status", "unknown");
	const operationType = (transferInfo ? getString(transferInfo, "operationType", null) : null)
		|| getString(summary, "operationType", "transfer");
	const resultRaw = summary.result;
	let result = typeof resultRaw === "string" ? resultRaw : null;
	if (!result) {
		if (status === "completed") {
			result = "SUCCESS";
		} else if ([ "failed", "error", "cleanup_failed" ].includes(status)) {
			result = "FAILED";
		} else {
			result = "IN_PROGRESS";
		}
	}

	const startedAt = (transferInfo ? getNumber(transferInfo, "startedAt", null) : null)
		|| getNumber(summary, "startedAt", null)
		|| (transferCreatedEvent?.timestampMs ?? null);
	const completedAt = (transferInfo ? getNumber(transferInfo, "completedAt", null) : null)
		|| getNumber(summary, "completedAt", null);
	const failedAt = (transferInfo ? getNumber(transferInfo, "failedAt", null) : null)
		|| getNumber(summary, "failedAt", null);
	const lastEventAt = getNumber(summary, "lastEventAt", null)
		|| (latestEvent?.timestampMs ?? null);
	const finishedAt = completedAt || failedAt || completionEvent?.timestampMs || lastEventAt;
	let totalDurationMs = getNumber(summary, "totalDurationMs", null);
	if (totalDurationMs === null && startedAt && finishedAt) {
		totalDurationMs = Math.max(0, finishedAt - startedAt);
	}
	if (totalDurationMs === null && typeof completionEvent?.durationMs === "number") {
		totalDurationMs = completionEvent.durationMs;
	}

	const validationFromSummary = summary.validation;
	const validation = (validationFromSummary && typeof validationFromSummary === "object" ? validationFromSummary : null)
		|| (validationEvent?.validation && typeof validationEvent.validation === "object" ? validationEvent.validation : null)
		|| null;
	const sourceVerificationFromSummary = summary.sourceVerification;
	let sourceVerification = (sourceVerificationFromSummary && typeof sourceVerificationFromSummary === "object" ? sourceVerificationFromSummary : null)
		|| (transferCreatedEvent?.sourceVerification && typeof transferCreatedEvent.sourceVerification === "object" ? transferCreatedEvent.sourceVerification : null)
		|| null;
	if (!sourceVerification && validation && typeof validation === "object") {
		const valObj = validation as Record<string, unknown>;
		sourceVerification = {
			itemCounts: (valObj.expectedItemCounts && typeof valObj.expectedItemCounts === "object" ? valObj.expectedItemCounts : {}) as Record<string, number>,
			fluidCounts: (valObj.expectedFluidCounts && typeof valObj.expectedFluidCounts === "object" ? valObj.expectedFluidCounts : {}) as Record<string, number>,
		};
	}

	const platformFromSummary = summary.platform;
	const phasesFromSummary = summary.phases;
	const exportFromSummary = summary.export;
	const payloadFromSummary = summary.payload;
	const importFromSummary = summary.import;

	return {
		transferId,
		operationType,
		result,
		status,
		totalDurationMs,
		totalDurationStr: getString(summary, "totalDurationStr", null) || formatDuration(totalDurationMs),
		phases: (phasesFromSummary && typeof phasesFromSummary === "object" ? phasesFromSummary : null)
			|| (completionEvent?.phases && typeof completionEvent.phases === "object" ? completionEvent.phases : null)
			|| {},
		platform: (platformFromSummary && typeof platformFromSummary === "object" ? platformFromSummary : null) || {
			name: transferInfo ? getString(transferInfo, "platformName", "Unknown") : "Unknown",
			source: {
				instanceId: transferInfo ? getNumber(transferInfo, "sourceInstanceId", -1) : -1,
				instanceName: transferInfo ? getString(transferInfo, "sourceInstanceName", null) : null,
			},
			destination: {
				instanceId: transferInfo ? getNumber(transferInfo, "targetInstanceId", -1) : -1,
				instanceName: transferInfo ? getString(transferInfo, "targetInstanceName", null) : null,
			},
		},
		export: (exportFromSummary && typeof exportFromSummary === "object" ? exportFromSummary : null)
			|| (transferCreatedEvent?.exportMetrics && typeof transferCreatedEvent.exportMetrics === "object" ? transferCreatedEvent.exportMetrics : null)
			|| null,
		payload: (payloadFromSummary && typeof payloadFromSummary === "object" ? payloadFromSummary : null)
			|| (completionEvent?.payloadMetrics && typeof completionEvent.payloadMetrics === "object" ? completionEvent.payloadMetrics : null)
			|| (transferCreatedEvent?.payloadMetrics && typeof transferCreatedEvent.payloadMetrics === "object" ? transferCreatedEvent.payloadMetrics : null)
			|| null,
		import: (importFromSummary && typeof importFromSummary === "object" ? importFromSummary : null)
			|| (completionEvent?.importMetrics && typeof completionEvent.importMetrics === "object" ? completionEvent.importMetrics : null)
			|| (validationEvent?.importMetrics && typeof validationEvent.importMetrics === "object" ? validationEvent.importMetrics : null)
			|| null,
		validation,
		sourceVerification,
		startedAt,
		completedAt,
		failedAt,
		lastEventAt,
		error: getString(summary, "error", null)
			|| (transferInfo ? getString(transferInfo, "error", null) : null),
	};
}
