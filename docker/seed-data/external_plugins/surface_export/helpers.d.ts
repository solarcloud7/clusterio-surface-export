/**
 * @file helpers.ts
 * @description Helper functions for chunked RCON data transfer with hybrid escaping
 */
export declare const TICKS_TO_MS = 16.67;
export declare function getErrorMessage(err: unknown, fallback?: string): string;
/**
 * Convert a value to a finite number, returning null for non-finite values.
 */
export declare function toFiniteNumber(value: unknown): number | null;
/**
 * Normalize raw export metrics from Lua (which may use old or new field names)
 * to the canonical camelCase schema expected by the controller and web UI.
 */
export declare function normalizeExportMetrics(raw: Record<string, unknown> | null | undefined): Record<string, number>;
interface FactorioInstance {
    sendRcon(command: string, expectEmpty?: boolean): Promise<string>;
}
/**
 * Send JSON data to Factorio using optimal escaping method.
 * Automatically chooses between [[...]] (fast) and '...' (safe) based on content.
 */
export declare function sendJsonToFactorio(instance: FactorioInstance, luaFunction: string, data: unknown, logger: {
    verbose(msg: string): void;
}): Promise<void>;
/**
 * Split data into chunks for RCON transfer.
 */
export declare function chunkify(chunkSize: number, data: string): string[];
/**
 * Send large JSON data in chunks with progress reporting.
 *
 * Template placeholders:
 *   %CHUNK% - replaced with chunk data (escaped or raw)
 *   %INDEX% - replaced with chunk index (1-based)
 *   %TOTAL% - replaced with total chunk count
 */
export declare function sendChunkedJson(instance: FactorioInstance, luaTemplate: string, data: unknown, logger: {
    info(msg: string): void;
    verbose(msg: string): void;
}, chunkSize?: number): Promise<void>;
export {};
//# sourceMappingURL=helpers.d.ts.map