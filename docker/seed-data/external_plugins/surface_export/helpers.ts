import { escapeString as libEscapeString } from "@clusterio/lib";
import type { ExportData, ExportVerification, ImportMetrics, PhaseSpan } from "./messages";

export const PLUGIN_NAME = "surface_export";

export const TICKS_TO_MS = 16.67;
export const RCON_CHUNK_SIZE = 100_000;
export const EXPORT_POLL_TIMEOUT_MS = 30_000;
export const EXPORT_POLL_INTERVAL_MS = 500;
export const DEFAULT_VALIDATION_TIMEOUT_SECONDS = 30;
export const MIN_VALIDATION_TIMEOUT_SECONDS = 5;
export const MAX_VALIDATION_TIMEOUT_SECONDS = 120;
export const STORAGE_FILENAME = "surface_export_storage.json";
export const GATEWAY_CONFIG_SINGLE_LIMIT = 7000;
export const GATEWAY_CONFIG_CHUNK_SIZE = 40_000;

export function toAsciiJson(json: string): string {
	return json.replace(/[\u007f-\uffff]/g,
		ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function simpleChecksum(ascii: string): string {
	let hash = 0;
	for (let i = 0; i < ascii.length; i++) {
		hash = (hash * 31 + ascii.charCodeAt(i)) % 4294967296;
	}
	return hash.toString(16).padStart(8, "0");
}

export function bracketWrap(text: string): string {
	for (let level = 1; level < 10; level++) {
		const eq = "=".repeat(level);
		if (!(text + "]").includes(`]${eq}]`)) {
			return `[${eq}[${text}]${eq}]`;
		}
	}
	throw new Error("no safe long-bracket level found for payload");
}

export { getErrorMessage, generateOperationId, makeCanonicalTransferId, parseCanonicalTransferId } from "./shared/utils";

export function isSessionLostError(err: unknown): boolean {
	return typeof err === "object" && err !== null
		&& (err as { code?: unknown }).code === "SessionLost";
}

export function isBenignUnlockError(text: string): boolean {
	return /platform not locked|no locked platforms/i.test(text);
}

export function toFiniteNumber(value: unknown): number | null {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

export function coercePlatformIndex(value: unknown): number | null {
	const numeric = Number(value);
	return Number.isInteger(numeric) ? numeric : null;
}

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


export function chunkify(chunkSize: number, data: string): string[] {
	const chunks: string[] = [];
	for (let i = 0; i < data.length; i += chunkSize) {
		chunks.push(data.slice(i, i + chunkSize));
	}
	return chunks;
}

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

		const response = await instance.sendRcon(`/sc ${command}`);
		const reply = typeof response === "string" ? response.trim() : "";
		if (!reply.startsWith("CHUNK_OK:") && !reply.startsWith("JOB_QUEUED:")) {
			throw new Error(`Chunked import failed at chunk ${index}/${total}: ${reply || "<empty reply>"}`);
		}

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

export function buildImportMetrics(raw: Record<string, unknown> | null | undefined, durationTicks: number | null = null): ImportMetrics | null {
	if (!raw && durationTicks === null) return null;
	const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const tickFields = ["tiles", "entities", "fluids", "belts", "state", "validation", "total"];
	const countFields = ["tiles_placed", "entities_created", "entities_failed", "entities_skipped",
		"entities_mapped", "fluids_restored",
		"belt_items_restored", "belt_state_applied", "belt_state_unmatched", "belt_state_failed",
		"belt_state_merge_discarded", "belt_state_declined",
		"inventory_state_applied", "inventory_state_declined", "inventory_state_failed",
		"circuits_connected", "copper_pruned", "proxies_linked", "total_items", "total_fluids"];
	const result: Record<string, number> = {};
	for (const f of tickFields) {
		const ticks = input[f + "_ticks"] ?? (f === "total" ? durationTicks : undefined);
		if (typeof ticks === "number" && Number.isSafeInteger(ticks) && ticks >= 0) result[f + "_ticks"] = ticks;
	}
	for (const f of countFields) result[f] = Number(input[f] || 0);
	const metrics = result as unknown as ImportMetrics;
	if (Array.isArray(input.phase_ticks)) metrics.phaseTicks = input.phase_ticks.filter(entry => entry && typeof entry.name === "string" && Number.isSafeInteger(entry.start_tick) && Number.isSafeInteger(entry.end_tick));
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
