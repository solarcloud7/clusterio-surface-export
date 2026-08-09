import { escapeString } from "@clusterio/lib";
import type { ExportData } from "../messages";
import { sendChunkedJson, RCON_CHUNK_SIZE, type FactorioInstance } from "../helpers";

type RconHost = FactorioInstance;

interface ChunkLogger {
	info(message: string): void;
	verbose(message: string): void;
}

export interface LuaConfigure {
	batchSize: number;
	maxConcurrentJobs: number;
	showProgress: boolean;
	debugMode: boolean;
	maxExportCacheSize: number;
}

export class LuaInterface {
	constructor(private readonly host: RconHost, private readonly logger: ChunkLogger) {}

	async configure(cfg: LuaConfigure): Promise<void> {
		const script = `/sc ` +
			`if remote.interfaces["surface_export"] and remote.interfaces["surface_export"]["configure"] then ` +
			`remote.call("surface_export", "configure", {` +
			`batch_size=${cfg.batchSize}, ` +
			`max_concurrent_jobs=${cfg.maxConcurrentJobs}, ` +
			`show_progress=${cfg.showProgress}, ` +
			`debug_mode=${cfg.debugMode}, ` +
			`max_export_cache_size=${cfg.maxExportCacheSize}` +
			`}) ` +
			`end`;
		await this.host.sendRcon(script, true);
	}

	async configureGateways(gatewaysJson: string, activeGatewaysJson?: string): Promise<void> {
		const activeClause = activeGatewaysJson
			? `, active_gateways_json="${escapeString(activeGatewaysJson)}"`
			: "";
		const script = `/sc ` +
			`if remote.interfaces["surface_export"] and remote.interfaces["surface_export"]["configure"] then ` +
			`remote.call("surface_export", "configure", {gateways_json="${escapeString(gatewaysJson)}"${activeClause}}) ` +
			`end`;
		const MAX_RCON_COMMAND_BYTES = 7000;
		if (Buffer.byteLength(script, "utf8") > MAX_RCON_COMMAND_BYTES) {
			throw new Error(
				`Gateway config command is ${Buffer.byteLength(script, "utf8")} bytes (> ${MAX_RCON_COMMAND_BYTES}); ` +
				`too large for a single RCON command — reduce the number of gateway targets.`,
			);
		}
		await this.host.sendRcon(script, true);
	}

	async pushTeleportRoster(rosterJson: string): Promise<void> {
		const script = `/sc ` +
			`if remote.interfaces["surface_export"] and remote.interfaces["surface_export"]["teleport_roster_update"] then ` +
			`remote.call("surface_export", "teleport_roster_update", "${escapeString(rosterJson)}") ` +
			`end`;
		const MAX_RCON_COMMAND_BYTES = 7000;
		if (Buffer.byteLength(script, "utf8") > MAX_RCON_COMMAND_BYTES) {
			throw new Error(
				`Teleport roster command is ${Buffer.byteLength(script, "utf8")} bytes (> ${MAX_RCON_COMMAND_BYTES}); ` +
				`too many instances for a single RCON push — chunk the roster (see import_platform_chunk).`,
			);
		}
		await this.host.sendRcon(script, true);
	}

	async exportPlatform(platformIndex: number, forceName: string, targetArg: string): Promise<string> {
		return this.host.sendRcon(
			`/sc local export_id, err = remote.call("surface_export", "export_platform", ${platformIndex}, "${escapeString(forceName)}", ${targetArg}); ` +
			`if export_id then rcon.print(export_id) else rcon.print("EXPORT_FAILED:" .. tostring(err or "unknown")) end`,
		);
	}

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

	async listExportsJson(): Promise<string[]> {
		const result = await this.host.sendRcon(
			"/sc rcon.print(remote.call(\"surface_export\", \"list_exports_json\"))",
		);
		return JSON.parse(result) as string[];
	}

	async listPlatformsJson(forceName: string): Promise<Record<string, unknown>[]> {
		const result = await this.host.sendRcon(
			`/sc rcon.print(remote.call("surface_export", "list_platforms_json", "${escapeString(forceName)}"))`,
		);
		const parsed = JSON.parse(result);
		return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [];
	}

	async importPlatformChunked(
		targetName: string,
		forceName: string,
		exportData: ExportData | Record<string, unknown>,
	): Promise<void> {
		await sendChunkedJson(
			this.host,
			`rcon.print(remote.call("surface_export", "import_platform_chunk", "${escapeString(targetName)}", %CHUNK%, %INDEX%, %TOTAL%, "${escapeString(forceName)}"))`,
			exportData,
			this.logger,
			RCON_CHUNK_SIZE,
		);
	}

	async deleteSourcePlatform(platformIndex: number, platformName: string, forceName: string, exportId?: string | null): Promise<string> {
		const jobArg = exportId ? `, "${escapeString(exportId)}"` : ", nil";
		return this.host.sendRcon(
			`/sc rcon.print(remote.call("surface_export", "delete_platform_for_transfer", ` +
			`${Math.trunc(platformIndex)}, "${escapeString(platformName)}", "${escapeString(forceName)}"${jobArg}))`,
		);
	}

	async getSourceTransferLockState(transferId: string, platformIndex: number, platformName: string, forceName: string): Promise<string> {
		return this.host.sendRcon(
			`/sc rcon.print(remote.call("surface_export", "get_source_transfer_lock_state_json", ` +
			`"${escapeString(transferId)}", ${Math.trunc(platformIndex)}, "${escapeString(platformName)}", "${escapeString(forceName)}"))`,
		);
	}
	async unlockPlatform(platformIndex: number, platformName?: string): Promise<string> {
		const nameArg = platformName ? `, "${escapeString(platformName)}"` : "";
		return this.host.sendRcon(
			`/sc ` +
			`local success, err = remote.call("surface_export", "unlock_platform", ${Math.trunc(platformIndex)}${nameArg}); ` +
			`if success then ` +
			`    rcon.print("SUCCESS"); ` +
			`else ` +
			`    rcon.print("ERROR:" .. (err or "Unknown error")); ` +
			`end`,
		);
	}


	async printToGame(message: string, colorCode: string): Promise<void> {
		await this.host.sendRcon(
			`/sc game.print("${escapeString(message)}", ${colorCode})`,
			true,
		);
	}

	async signalReady(): Promise<void> {
		await this.host.sendRcon("/sc rcon.print(\"surface-export-ready\")");
	}
}
