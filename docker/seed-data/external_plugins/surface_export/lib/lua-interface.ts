/**
 * @file lib/lua-interface.ts
 * @description The typed gateway to the save-patched `surface_export` Lua module — the ONE place that
 * builds `/sc remote.call("surface_export", ...)` command strings, escapes interpolated arguments, runs the
 * chunked-JSON sends, and does the straightforward JSON.parse of RCON results. instance.ts calls these typed
 * methods instead of formatting Lua inline; it keeps the intricate result *interpretation* (export-failed
 * parsing, validation defaulting, platform mapping, SUCCESS/ERROR handling).
 *
 * Binding: this holds a reference to the RCON host (the Clusterio Instance) and calls `host.sendRcon(...)`
 * BOUND — it never extracts `sendRcon` as a bare value, which would lose `this` (the same footgun as Pitfall
 * #26 for Link methods). This mirrors how helpers.ts takes a duck-typed `{ sendRcon }`.
 */

import { escapeString } from "@clusterio/lib";
import type { ExportData } from "../messages";
import { sendChunkedJson, RCON_CHUNK_SIZE, type FactorioInstance } from "../helpers";

/**
 * The RCON host. MUST be the plugin (BaseInstancePlugin) — its `sendRcon` forwards the plugin name as the
 * `plugin` label on the RCON-size metric; the raw Instance's `sendRcon` defaults that label to "". Reuses
 * helpers.ts's `FactorioInstance` (same `{ sendRcon }` surface) rather than re-declaring it.
 */
type RconHost = FactorioInstance;

/** The subset of the plugin logger that the chunked-send path needs. */
interface ChunkLogger {
	info(message: string): void;
	verbose(message: string): void;
}

export interface LuaConfigure {
	batchSize: number;
	maxConcurrentJobs: number;
	showProgress: boolean;
	debugMode: boolean;
}

export class LuaInterface {
	constructor(private readonly host: RconHost, private readonly logger: ChunkLogger) {}

	/** Push plugin config into the Lua module (no-op if the remote interface isn't loaded yet). */
	async configure(cfg: LuaConfigure): Promise<void> {
		const script = `/sc ` +
			`if remote.interfaces["surface_export"] and remote.interfaces["surface_export"]["configure"] then ` +
			`remote.call("surface_export", "configure", {` +
			`batch_size=${cfg.batchSize}, ` +
			`max_concurrent_jobs=${cfg.maxConcurrentJobs}, ` +
			`show_progress=${cfg.showProgress}, ` +
			`debug_mode=${cfg.debugMode}` +
			`}) ` +
			`end`;
		await this.host.sendRcon(script, true);
	}

	/**
	 * Queue an async export. `targetArg` is the already-formatted Lua literal ("nil" for export-only, or a
	 * positive integer string for a transfer destination). Returns the RAW rcon result; the caller interprets
	 * the `export_id` / `EXPORT_FAILED:<reason>` contract.
	 */
	async exportPlatform(platformIndex: number, forceName: string, targetArg: string): Promise<string> {
		return this.host.sendRcon(
			`/sc local export_id, err = remote.call("surface_export", "export_platform", ${platformIndex}, "${escapeString(forceName)}", ${targetArg}); ` +
			`if export_id then rcon.print(export_id) else rcon.print("EXPORT_FAILED:" .. tostring(err or "unknown")) end`,
		);
	}

	/** Fetch a stored export as a parsed object, or null if Lua returned empty/"null"/a non-object. */
	async getExportJson(exportId: string): Promise<Record<string, unknown> | null> {
		const result = await this.host.sendRcon(
			`/sc rcon.print(remote.call("surface_export", "get_export_json", "${escapeString(exportId)}"))`,
		);
		const jsonText = String(result || "").trim();
		if (!jsonText || jsonText === "null") {
			return null;
		}
		const parsed = JSON.parse(jsonText);
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
	}

	/** List stored export IDs (parsed array). Throws on a malformed response; the caller decides the fallback. */
	async listExportsJson(): Promise<string[]> {
		const result = await this.host.sendRcon(
			"/sc rcon.print(remote.call(\"surface_export\", \"list_exports_json\"))",
		);
		return JSON.parse(result) as string[];
	}

	/** List platforms for a force (parsed array; [] if Lua returned a non-array). Caller maps to its shape. */
	async listPlatformsJson(forceName: string): Promise<Record<string, unknown>[]> {
		const result = await this.host.sendRcon(
			`/sc rcon.print(remote.call("surface_export", "list_platforms_json", "${escapeString(forceName)}"))`,
		);
		const parsed = JSON.parse(result);
		return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
	}

	/** Stream an export payload to Lua's `import_platform_chunk` in size-bounded chunks (reuses helpers). */
	async importPlatformChunked(
		targetName: string,
		forceName: string,
		exportData: ExportData | Record<string, unknown>,
	): Promise<void> {
		await sendChunkedJson(
			this.host,
			`remote.call("surface_export", "import_platform_chunk", "${escapeString(targetName)}", %CHUNK%, %INDEX%, %TOTAL%, "${escapeString(forceName)}")`,
			exportData,
			this.logger,
			RCON_CHUNK_SIZE,
		);
	}

	/** Fetch the post-import validation result as a RAW rcon string; the caller parses/defaults it. */
	async getValidationResultJson(platformName: string): Promise<string> {
		return this.host.sendRcon(
			`/sc rcon.print(remote.call("surface_export", "get_validation_result_json", "${escapeString(platformName)}"))`,
		);
	}

	/**
	 * Delete a transferred source platform. Returns RAW "SUCCESS" / "ERROR:<reason>".
	 * Uses `game.delete_surface` — `LuaSpacePlatform.destroy()` is a NO-OP at 2.0.76 (Pitfall #19).
	 */
	async deleteSourcePlatform(platformName: string, forceName: string): Promise<string> {
		const name = escapeString(platformName);
		const force = escapeString(forceName);
		return this.host.sendRcon(
			`/sc ` +
			`pcall(function() remote.call("surface_export", "unlock_platform", "${name}") end); ` +
			`local force = game.forces["${force}"]; ` +
			`local platform = nil; ` +
			`for _, p in pairs(force.platforms) do ` +
			`    if p.name == "${name}" then platform = p; break; end ` +
			`end; ` +
			`if platform then ` +
			`    local surface = platform.surface; ` +
			`    if surface and surface.valid then ` +
			`        local ok, err = pcall(function() game.delete_surface(surface) end); ` +
			`        if ok then ` +
			`            game.print("[Transfer Complete] Platform '${name}' transferred and deleted from source", {0, 1, 0}); ` +
			`            rcon.print("SUCCESS"); ` +
			`        else ` +
			`            rcon.print("ERROR:delete_surface failed: " .. tostring(err)); ` +
			`        end ` +
			`    else ` +
			`        rcon.print("ERROR:Platform surface not valid"); ` +
			`    end ` +
			`else ` +
			`    rcon.print("ERROR:Platform not found"); ` +
			`end`,
		);
	}

	/** Unlock a platform via the remote interface. Returns RAW "SUCCESS" / "ERROR:<reason>". */
	async unlockPlatform(platformName: string): Promise<string> {
		return this.host.sendRcon(
			`/sc ` +
			`local success, err = remote.call("surface_export", "unlock_platform", "${escapeString(platformName)}"); ` +
			`if success then ` +
			`    rcon.print("SUCCESS"); ` +
			`else ` +
			`    rcon.print("ERROR:" .. (err or "Unknown error")); ` +
			`end`,
		);
	}

	/** Fire-and-forget unlock via the SurfaceLock util directly (the transfer-failure rollback path). */
	async unlockViaSurfaceLock(platformName: string): Promise<void> {
		await this.host.sendRcon(
			`/sc local SurfaceLock = require("modules/surface_export/utils/surface-lock"); ` +
			`SurfaceLock.unlock_platform("${escapeString(platformName)}")`,
		);
	}

	/** Print an in-game message. `colorCode` is a pre-formatted Lua RGB literal, e.g. "{0, 1, 0}". */
	async printToGame(message: string, colorCode: string): Promise<void> {
		await this.host.sendRcon(
			`/sc game.print("${escapeString(message)}", ${colorCode})`,
			true,
		);
	}

	/** Harmless print used to confirm the Factorio Lua console (first command needs confirmation). */
	async signalReady(): Promise<void> {
		await this.host.sendRcon("/sc rcon.print(\"surface-export-ready\")");
	}
}
