/**
 * @file helpers.ts
 * @description Helper functions for chunked RCON data transfer with hybrid escaping
 */

"use strict";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require("@clusterio/lib") as { escapeString(s: string): string };

export const TICKS_TO_MS = 16.67;

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

/**
 * Convert a value to a finite number, returning null for non-finite values.
 */
export function toFiniteNumber(value: unknown): number | null {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
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

interface FactorioInstance {
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
		const escaped = lib.escapeString(json);
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
			const escaped = lib.escapeString(chunk);
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
