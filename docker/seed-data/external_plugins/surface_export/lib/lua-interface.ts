import { timed, timedSync } from "./timing";
import { escapeString } from "@clusterio/lib";
import type { ExportData } from "../messages";
import {
	sendChunkedJson, chunkify, RCON_CHUNK_SIZE,
	GATEWAY_CONFIG_SINGLE_LIMIT, GATEWAY_CONFIG_CHUNK_SIZE,
	toAsciiJson, simpleChecksum, bracketWrap, getErrorMessage,
	type FactorioInstance,
} from "../helpers";

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
	profileBatches?: boolean;
	maxExportCacheSize: number;
}

export class LuaInterface {
	private readonly host: RconHost;
 constructor(host: RconHost, private readonly logger: ChunkLogger) {
  this.host = { sendRcon: (command, expectEmpty) => timed("RCON request round trip", "round-trip", () => host.sendRcon(command, expectEmpty)) };
 }

	async configure(cfg: LuaConfigure): Promise<void> {
		const script = `/sc ` +
			`if remote.interfaces["surface_export"] and remote.interfaces["surface_export"]["configure"] then ` +
			`remote.call("surface_export", "configure", {` +
			`batch_size=${cfg.batchSize}, ` +
			`max_concurrent_jobs=${cfg.maxConcurrentJobs}, ` +
			`show_progress=${cfg.showProgress}, ` +
			`debug_mode=${cfg.debugMode}, ` +
			`profile_batches=${cfg.profileBatches === true}, ` +
			`max_export_cache_size=${cfg.maxExportCacheSize}` +
			`}) ` +
			`end`;
		await this.host.sendRcon(script, true);
	}

	async configureGateways(gatewaysJson: string, activeGatewaysJson?: string): Promise<{ gateways: number }> {
		const asciiJson = toAsciiJson(gatewaysJson);
		const activeArg = activeGatewaysJson ? `, ${bracketWrap(toAsciiJson(activeGatewaysJson))}` : "";
		const expectedGateways = Object.keys(JSON.parse(gatewaysJson) as Record<string, unknown>).length;
		const expectedBytes = asciiJson.length;

		const singleScript = this.gatewayRemoteScript(
			`remote.call("surface_export", "configure_gateways", ${bracketWrap(asciiJson)}${activeArg})`);
		if (Buffer.byteLength(singleScript, "utf8") <= GATEWAY_CONFIG_SINGLE_LIMIT) {
			const reply = await this.callGatewayRemote(singleScript, "apply");
			this.verifyGatewayEcho(reply, expectedGateways, expectedBytes);
			return { gateways: expectedGateways };
		}

		const token = `gwcfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const chunks = chunkify(GATEWAY_CONFIG_CHUNK_SIZE, asciiJson);
		const checksum = simpleChecksum(asciiJson);
		await this.callGatewayRemote(this.gatewayRemoteScript(
			`remote.call("surface_export", "configure_gateways_begin", "${token}", ${chunks.length}, "${checksum}")`),
		"begin");
		for (let i = 0; i < chunks.length; i++) {
			await this.callGatewayRemote(this.gatewayRemoteScript(
				`remote.call("surface_export", "configure_gateways_chunk", "${token}", ${i + 1}, ${bracketWrap(chunks[i])})`),
			`chunk ${i + 1}/${chunks.length}`);
		}
		const commit = await this.callGatewayRemote(this.gatewayRemoteScript(
			`remote.call("surface_export", "configure_gateways_commit", "${token}"${activeArg})`), "commit");
		this.verifyGatewayEcho(commit, expectedGateways, expectedBytes);
		this.logger.info(`Gateway config pushed in ${chunks.length} chunk(s): `
			+ `${expectedGateways} gateway(s), ${expectedBytes} bytes`);
		return { gateways: expectedGateways };
	}

	private gatewayRemoteScript(remoteCallExpr: string): string {
		return `/sc if not (remote.interfaces["surface_export"] `
			+ `and remote.interfaces["surface_export"]["configure_gateways"]) then `
			+ `rcon.print('{"ok":false,"error":"surface_export configure_gateways remote missing (module not loaded)"}') `
			+ `else local ok, res = pcall(function() return ${remoteCallExpr} end) `
			+ `if ok then rcon.print(helpers.table_to_json(res)) `
			+ `else rcon.print(helpers.table_to_json({ ok = false, error = tostring(res) })) end end`;
	}

	private async callGatewayRemote(script: string, phase: string): Promise<Record<string, unknown>> {
		const raw = await this.host.sendRcon(script);
		const line = String(raw || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || "";
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch (err: unknown) {
			throw new Error(`gateway config ${phase}: non-JSON reply "${line.slice(0, 200)}" (${getErrorMessage(err)})`);
		}
		if (parsed.ok !== true) {
			throw new Error(`gateway config ${phase} failed: ${String(parsed.error ?? "unknown")}`);
		}
		return parsed;
	}

	private verifyGatewayEcho(reply: Record<string, unknown>, gateways: number, bytes: number): void {
		if (reply.gateways !== gateways || reply.bytes !== bytes) {
			throw new Error(`gateway config echo-verify failed: instance applied `
				+ `gateways=${String(reply.gateways)} bytes=${String(reply.bytes)}, `
				+ `expected gateways=${gateways} bytes=${bytes}`);
		}
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
				`too many instances for a single RCON push — chunk the roster (see configure_gateways_begin).`,
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
		const parsed = timedSync("Artifact JSON decoding", () => JSON.parse(jsonText));
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
			`rcon.print(remote.call("surface_export", "import_platform_chunk", "${escapeString(targetName)}", %CHUNK%, %INDEX%, %TOTAL%, "${escapeString(forceName)}", "${escapeString(String(exportData._operationId || exportData._transferId || ""))}"))`,
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
