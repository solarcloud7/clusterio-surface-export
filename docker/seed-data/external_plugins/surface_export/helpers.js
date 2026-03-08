/**
 * @file helpers.ts
 * @description Helper functions for chunked RCON data transfer with hybrid escaping
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TICKS_TO_MS = void 0;
exports.getErrorMessage = getErrorMessage;
exports.toFiniteNumber = toFiniteNumber;
exports.normalizeExportMetrics = normalizeExportMetrics;
exports.sendJsonToFactorio = sendJsonToFactorio;
exports.chunkify = chunkify;
exports.sendChunkedJson = sendChunkedJson;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require("@clusterio/lib");
exports.TICKS_TO_MS = 16.67;
function getErrorMessage(err, fallback = "Unknown error") {
    if (err instanceof Error) {
        return err.message || fallback;
    }
    if (typeof err === "string") {
        return err || fallback;
    }
    if (err && typeof err === "object" && "message" in err) {
        const message = err.message;
        if (typeof message === "string" && message) {
            return message;
        }
    }
    return fallback;
}
/**
 * Convert a value to a finite number, returning null for non-finite values.
 */
function toFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}
/**
 * Normalize raw export metrics from Lua (which may use old or new field names)
 * to the canonical camelCase schema expected by the controller and web UI.
 */
function normalizeExportMetrics(raw) {
    if (!raw || typeof raw !== "object") {
        return {};
    }
    const normalized = {};
    const mappings = [
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
        if (raw[fromKey] !== undefined && raw[fromKey] !== null) {
            normalized[toKey] = raw[fromKey];
        }
    }
    const ticks = toFiniteNumber(normalized.instanceAsyncExportTicks);
    if (ticks !== null && normalized.instanceAsyncExportMs === undefined) {
        normalized.instanceAsyncExportMs = Math.round(ticks * exports.TICKS_TO_MS);
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
        const numeric = toFiniteNumber(normalized[key]);
        if (numeric !== null) {
            normalized[key] = numeric;
        }
    }
    return normalized;
}
/**
 * Send JSON data to Factorio using optimal escaping method.
 * Automatically chooses between [[...]] (fast) and '...' (safe) based on content.
 */
async function sendJsonToFactorio(instance, luaFunction, data, logger) {
    const json = JSON.stringify(data);
    if (json.includes("]]")) {
        logger.verbose(`Data contains ]], using escaped string (${json.length} bytes)`);
        const escaped = lib.escapeString(json);
        await instance.sendRcon(`/sc ${luaFunction}('${escaped}')`, true);
    }
    else {
        await instance.sendRcon(`/sc ${luaFunction}([[${json}]])`, true);
    }
}
/**
 * Split data into chunks for RCON transfer.
 */
function chunkify(chunkSize, data) {
    const chunks = [];
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
async function sendChunkedJson(instance, luaTemplate, data, logger, chunkSize = 100000) {
    const json = JSON.stringify(data);
    const needsEscaping = json.includes("]]");
    logger.info(`Sending ${json.length} bytes in ${chunkSize} byte chunks ` +
        `(escaping: ${needsEscaping ? "yes" : "no"})`);
    const chunks = chunkify(chunkSize, json);
    const startTime = Date.now();
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const index = i + 1;
        const total = chunks.length;
        let chunkString;
        if (needsEscaping) {
            const escaped = lib.escapeString(chunk);
            chunkString = `'${escaped}'`;
        }
        else {
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
    logger.info(`All ${chunks.length} chunks sent successfully ` +
        `(${duration}ms, ${throughput} KB/s)`);
}
//# sourceMappingURL=helpers.js.map