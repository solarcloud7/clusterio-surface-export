/**
 * @file helpers.ts
 * @description Helper functions for chunked RCON data transfer with hybrid escaping
 */


import { escapeString as libEscapeString } from "@clusterio/lib";
import type { ExportData, ExportVerification, ImportMetrics, PhaseSpan } from "./messages";

export const TICKS_TO_MS = 16.67;
export const RCON_CHUNK_SIZE = 100_000;
export const EXPORT_POLL_TIMEOUT_MS = 30_000;
export const EXPORT_POLL_INTERVAL_MS = 500;
export const VALIDATION_TIMEOUT_MS = 120_000;
export const STORAGE_FILENAME = "surface_export_storage.json";

// getErrorMessage + generateOperationId live in the shared (Node + web) module so they aren't duplicated
// across helpers.ts and web/utils.ts (task #97). Re-export so existing `.../helpers` call sites keep working.
export { getErrorMessage, generateOperationId, makeCanonicalTransferId, parseCanonicalTransferId } from "./shared/utils";

/**
 * True when `err` is a Clusterio session-loss rejection (`@clusterio/lib` `SessionLost`, which sets
 * `code = "SessionLost"` and a "Session Lost"/"Session Closed" message). A pending request rejects with
 * this when the controller↔host link drops — see `@clusterio/lib` `link.ts` `_clearPendingRequests`.
 *
 * Duck-typed on `.code` rather than `instanceof SessionLost` on purpose: this repo can end up with a
 * second copy of `@clusterio/lib` in a plugin's node_modules (CLAUDE.md Pitfalls #12/#26), and an
 * `instanceof` against the wrong copy would silently return false. The `.code` string is stable.
 *
 * Load-bearing for the transfer two-phase commit: a SessionLost on the import send is AMBIGUOUS — the
 * destination may already have started importing — so the source must NOT be unlocked (that would leave a
 * live source coexisting with the destination copy = duplication).
 */
export function isSessionLostError(err: unknown): boolean {
	return typeof err === "object" && err !== null
		&& (err as { code?: unknown }).code === "SessionLost";
}

/**
 * Convert a value to a finite number, returning null for non-finite values.
 */
export function toFiniteNumber(value: unknown): number | null {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Coerce a value to an integer platform index, or null if it isn't a valid integer. The single
 * "is this a usable platform index?" guard shared by the index-keyed source-delete / unlock paths.
 */
export function coercePlatformIndex(value: unknown): number | null {
	const numeric = Number(value);
	return Number.isInteger(numeric) ? numeric : null;
}

/**
 * Normalize raw export metrics from Lua (which may use old or new field names)
 * to the canonical camelCase schema expected by the controller and web UI.
 */
export function normalizeExportMetrics(raw: Record<string, unknown> | null | undefined): Record<string, number> {
	if (!raw || typeof raw !== "object") {
		return {};
	}

	const normalized: Record<string, number | unknown> = {};
	const mappings: Array<[string, string]> = [
		["requestExportAndLockMs", "requestExportAndLockMs"],
		["waitForControllerStoreMs", "waitForControllerStoreMs"],
		["controllerExportPrepTotalMs", "controllerExportPrepTotalMs"],
		["exportRequestMs", "requestExportAndLockMs"],
		["waitForStoredMs", "waitForControllerStoreMs"],
		["exportPrepTotalMs", "controllerExportPrepTotalMs"],
		["async_export_ticks", "instanceAsyncExportTicks"],
		["async_export_ms", "instanceAsyncExportMs"],
		["async_export_seconds", "instanceAsyncExportSeconds"],
		["entity_count", "exportedEntityCount"],
		["tile_count", "exportedTileCount"],
		["atomic_belt_entities", "atomicBeltEntitiesScanned"],
		["atomic_belt_item_stacks", "atomicBeltItemStacksCaptured"],
		["uncompressed_bytes", "uncompressedPayloadBytes"],
		["compressed_bytes", "compressedPayloadBytes"],
		["compression_reduction_pct", "compressionReductionPct"],
		["schedule_record_count", "scheduleRecordCount"],
		["schedule_interrupt_count", "scheduleInterruptCount"],
	];

	for (const [fromKey, toKey] of mappings) {
		if ((raw as Record<string, unknown>)[fromKey] !== undefined && (raw as Record<string, unknown>)[fromKey] !== null) {
			normalized[toKey] = (raw as Record<string, unknown>)[fromKey];
		}
	}

	const ticks = toFiniteNumber(normalized.instanceAsyncExportTicks);
	if (ticks !== null && normalized.instanceAsyncExportMs === undefined) {
		normalized.instanceAsyncExportMs = Math.round(ticks * TICKS_TO_MS);
	}

	for (const key of [
		"requestExportAndLockMs",
		"waitForControllerStoreMs",
		"controllerExportPrepTotalMs",
		"instanceAsyncExportTicks",
		"instanceAsyncExportMs",
		"instanceAsyncExportSeconds",
		"exportedEntityCount",
		"exportedTileCount",
		"atomicBeltEntitiesScanned",
		"atomicBeltItemStacksCaptured",
		"uncompressedPayloadBytes",
		"compressedPayloadBytes",
		"compressionReductionPct",
		"scheduleRecordCount",
		"scheduleInterruptCount",
	]) {
		if (normalized[key] === undefined || normalized[key] === null) {
			continue;
		}
		const numeric = toFiniteNumber(normalized[key] as unknown);
		if (numeric !== null) {
			normalized[key] = numeric;
		}
	}

	return normalized as Record<string, number>;
}

export interface FactorioInstance {
	sendRcon(command: string, expectEmpty?: boolean): Promise<string>;
}

/**
 * Send JSON data to Factorio using optimal escaping method.
 * Automatically chooses between [[...]] (fast) and '...' (safe) based on content.
 */
export async function sendJsonToFactorio(
	instance: FactorioInstance,
	luaFunction: string,
	data: unknown,
	logger: { verbose(msg: string): void },
): Promise<void> {
	const json = JSON.stringify(data);

	if (json.includes("]]")) {
		logger.verbose(`Data contains ]], using escaped string (${json.length} bytes)`);
		const escaped = libEscapeString(json);
		await instance.sendRcon(`/sc ${luaFunction}('${escaped}')`, true);
	} else {
		await instance.sendRcon(`/sc ${luaFunction}([[${json}]])`, true);
	}
}

/**
 * Split data into chunks for RCON transfer.
 */
export function chunkify(chunkSize: number, data: string): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < data.length; i += chunkSize) {
		chunks.push(data.slice(i, i + chunkSize));
	}
	return chunks;
}

/**
 * Send large JSON data in chunks with progress reporting.
 *
 * Template placeholders:
 *   %CHUNK% - replaced with chunk data (escaped or raw)
 *   %INDEX% - replaced with chunk index (1-based)
 *   %TOTAL% - replaced with total chunk count
 */
export async function sendChunkedJson(
	instance: FactorioInstance,
	luaTemplate: string,
	data: unknown,
	logger: { info(msg: string): void; verbose(msg: string): void },
	chunkSize = 100000,
): Promise<void> {
	const json = JSON.stringify(data);
	const needsEscaping = json.includes("]]");

	logger.info(
		`Sending ${json.length} bytes in ${chunkSize} byte chunks ` +
		`(escaping: ${needsEscaping ? "yes" : "no"})`,
	);

	const chunks = chunkify(chunkSize, json);
	const startTime = Date.now();

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const index = i + 1;
		const total = chunks.length;

		let chunkString: string;
		if (needsEscaping) {
			const escaped = libEscapeString(chunk);
			chunkString = `'${escaped}'`;
		} else {
			chunkString = `[[${chunk}]]`;
		}

		const command = luaTemplate
			.replace(/%CHUNK%/g, chunkString)
			.replace(/%INDEX%/g, index.toString())
			.replace(/%TOTAL%/g, total.toString());

		await instance.sendRcon(`/sc ${command}`, true);

		if (i % 10 === 0 || index === total) {
			const percent = ((index / total) * 100).toFixed(1);
			logger.verbose(`Sent chunk ${index}/${total} (${percent}%)`);
		}
	}

	const duration = Date.now() - startTime;
	const throughput = (json.length / 1024 / (duration / 1000)).toFixed(2);
	logger.info(
		`All ${chunks.length} chunks sent successfully ` +
		`(${duration}ms, ${throughput} KB/s)`,
	);
}

/**
 * Compute payload metrics from stored export data.
 */
export function buildPayloadMetrics(exportData: ExportData | Record<string, unknown> | null | undefined) {
	const verification = (exportData?.verification || {}) as ExportVerification;
	const itemCounts = (verification.item_counts || {}) as Record<string, number>;
	const fluidCounts = (verification.fluid_counts || {}) as Record<string, number>;
	const payload = typeof exportData?.payload === "string" ? exportData.payload : null;
	const stats = (exportData?.stats && typeof exportData.stats === "object"
		? exportData.stats
		: {}) as { entity_count?: number; tile_count?: number };
	return {
		payloadMetrics: {
			isCompressed: Boolean(exportData?.compressed),
			compressionType: typeof exportData?.compression === "string" ? exportData.compression : "none",
			payloadSizeKB: payload ? Math.round(payload.length / 1024 * 10) / 10 : null,
			entityCount: Number(stats.entity_count || 0),
			tileCount: Number(stats.tile_count || 0),
			uniqueItemTypes: Object.keys(itemCounts).length,
			totalItemCount: Object.values(itemCounts).reduce((sum, c) => sum + c, 0),
			uniqueFluidTypes: Object.keys(fluidCounts).length,
			totalFluidVolume: Math.round(Object.values(fluidCounts).reduce((sum, c) => sum + c, 0) * 10) / 10,
		},
		itemCounts,
		fluidCounts,
	};
}

/**
 * Convert Lua tick-based import metrics to milliseconds.
 */
export function buildImportMetrics(raw: Record<string, unknown> | null | undefined, durationTicks: number | null = null): ImportMetrics | null {
	if (!raw && durationTicks === null) return null;
	const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const tickFields = ["tiles", "entities", "fluids", "belts", "state", "validation", "total"];
	const countFields = ["tiles_placed", "entities_created", "entities_failed", "fluids_restored",
		"belt_items_restored", "circuits_connected", "total_items", "total_fluids"];
	const result: Record<string, number> = { total_ticks: Number(input.total_ticks || durationTicks || 0) };
	for (const f of tickFields) {
		const ticks = Number(input[f + "_ticks"] || (f === "total" ? durationTicks || 0 : 0));
		result[f + "_ticks"] = ticks;
		result[f + "_ms"] = Math.round(ticks * TICKS_TO_MS);
	}
	for (const f of countFields) result[f] = Number(input[f] || 0);
	// Builder uses dynamic keys, so the loose Record is the one legitimate place to cast through
	// unknown. Consumers still get field-typed (typo-catching) access via the ImportMetrics interface.
	const metrics = result as unknown as ImportMetrics;
	// Waterfall trace: map Lua snake_case phase spans → camelCase. Absent on legacy logs.
	if (Array.isArray(input.phase_spans)) {
		const spans: PhaseSpan[] = [];
		for (const entry of input.phase_spans) {
			if (!entry || typeof entry !== "object") continue;
			const s = entry as Record<string, unknown>;
			const startOffsetMs = Number(s.start_offset_ms);
			const durationMs = Number(s.duration_ms);
			if (typeof s.name !== "string" || !Number.isFinite(startOffsetMs) || !Number.isFinite(durationMs)) continue;
			const span: PhaseSpan = { name: s.name, startOffsetMs, durationMs };
			if (typeof s.parent === "string") span.parent = s.parent;
			spans.push(span);
		}
		if (spans.length) metrics.phaseSpans = spans;
	}
	return metrics;
}
