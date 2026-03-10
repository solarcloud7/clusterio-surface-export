"use strict";

function requireClusterioModule<T>(moduleName: string): T {
	if (require.main && typeof (require.main as NodeJS.Module & { require?: NodeRequire }).require === "function") {
		try {
			return ((require.main as NodeJS.Module & { require?: NodeRequire }).require as NodeRequire)(moduleName) as T;
		} catch (_err) {
			// Fallback to local resolution below.
		}
	}
	return require(moduleName) as T;
}

const { BaseCtlPlugin } = requireClusterioModule<{ BaseCtlPlugin: new (...args: unknown[]) => object }>("@clusterio/ctl");
const { Command, CommandTree } = requireClusterioModule<{ Command: new (...args: unknown[]) => unknown; CommandTree: new (...args: unknown[]) => { add: (command: unknown) => void } }>("@clusterio/lib");
import fs from "fs";
import * as messages from "./messages";
import { getErrorMessage } from "./helpers";

type ControlLike = {
	sendTo: <T = unknown>(target: string, message: unknown) => Promise<T>;
};

type YargsLike = { positional: (name: string, opts: unknown) => void };

const surfaceExportCommands = new CommandTree({
	name: "surface-export",
	description: "Surface Export plugin commands",
}) as { add: (command: unknown) => void };

surfaceExportCommands.add(new Command({
	definition: ["list", "List stored platform exports"],
	handler: async function(_args: Record<string, unknown>, control: ControlLike) {
		const entries = await control.sendTo("controller", new messages.ListExportsRequest()) as messages.StoredExportSummary[];
		if (!entries.length) {
			console.log("No stored platform exports available");
			return;
		}
		const lines = entries
			.sort((a, b) => b.timestamp - a.timestamp)
			.map(entry => `${entry.exportId}\t${entry.platformName}\tinstance ${entry.instanceId}\t${new Date(entry.timestamp).toISOString()}\t${entry.size} bytes`);
		console.log(["Export ID\tPlatform\tSource\tTimestamp\tSize"].concat(lines).join("\n"));
	},
}));

surfaceExportCommands.add(new Command({
	definition: [
		"get-export <exportId> [outputFile]",
		"Download a stored export payload as JSON",
		(yargs: YargsLike) => {
			yargs.positional("exportId", { describe: "Stored export identifier", type: "string" });
			yargs.positional("outputFile", { describe: "Output file path (default: stdout)", type: "string" });
		},
	],
	handler: async function(args: { exportId: string; outputFile?: string }, control: ControlLike) {
		const response = await control.sendTo("controller", new messages.GetStoredExportRequest({
			exportId: args.exportId,
		})) as messages.SimpleResponse & { exportData?: Record<string, unknown> };
		if (!response.success) {
			throw new Error(response.error || "Export not found");
		}
		const json = JSON.stringify(response.exportData, null, 2);
		if (args.outputFile) {
			fs.writeFileSync(args.outputFile, json, "utf8");
			console.log(`Written ${json.length} bytes to ${args.outputFile}`);
			return;
		}
		console.log(json);
	},
}));

surfaceExportCommands.add(new Command({
	definition: [
		"upload-import <file> <targetInstanceId> [forceName] [platformName]",
		"Upload a JSON export file and import it onto a target instance",
		(yargs: YargsLike) => {
			yargs.positional("file", { describe: "Path to JSON export file", type: "string" });
			yargs.positional("targetInstanceId", { describe: "Target instance ID", type: "number" });
			yargs.positional("forceName", { describe: "Force name", type: "string", default: "player" });
			yargs.positional("platformName", { describe: "Optional platform name override", type: "string" });
		},
	],
	handler: async function(args: { file: string; targetInstanceId: number | string; forceName?: string; platformName?: string }, control: ControlLike) {
		const targetInstanceId = Number(args.targetInstanceId);
		if (Number.isNaN(targetInstanceId)) {
			throw new Error("targetInstanceId must be a number");
		}
		const raw = fs.readFileSync(args.file, "utf8");
		let exportData: Record<string, unknown>;
		try {
			exportData = JSON.parse(raw);
		} catch (err: unknown) {
			throw new Error(`Invalid JSON in ${args.file}: ${getErrorMessage(err)}`);
		}
		if (!exportData || typeof exportData !== "object" || Array.isArray(exportData)) {
			throw new Error("Export file must contain a JSON object");
		}
		console.log(`Uploading ${(raw.length / 1024).toFixed(1)} KB to instance ${targetInstanceId}...`);
		const response = await control.sendTo("controller", new messages.ImportUploadedExportRequest({
			targetInstanceId,
			exportData,
			forceName: args.forceName || "player",
			platformName: args.platformName || null,
		})) as messages.SimpleResponse & { platformName?: string; targetInstanceId?: number };
		if (!response.success) {
			throw new Error(response.error || "Import failed");
		}
		console.log(`Import started: "${response.platformName || "Unknown"}" on instance ${response.targetInstanceId}`);
	},
}));

surfaceExportCommands.add(new Command({
	definition: [
		"start-transfer <sourceInstanceId> <sourcePlatformIndex> <targetInstanceId> [forceName]",
		"Start transfer through controller orchestration path (same path used by web UI)",
		(yargs: YargsLike) => {
			yargs.positional("sourceInstanceId", { describe: "Source instance ID", type: "number" });
			yargs.positional("sourcePlatformIndex", { describe: "Source platform index", type: "number" });
			yargs.positional("targetInstanceId", { describe: "Target instance ID", type: "number" });
			yargs.positional("forceName", { describe: "Force name", type: "string", default: "player" });
		},
	],
	handler: async function(args: { sourceInstanceId: number | string; sourcePlatformIndex: number | string; targetInstanceId: number | string; forceName?: string }, control: ControlLike) {
		const sourceInstanceId = Number(args.sourceInstanceId);
		const sourcePlatformIndex = Number(args.sourcePlatformIndex);
		const targetInstanceId = Number(args.targetInstanceId);
		if (Number.isNaN(sourceInstanceId) || Number.isNaN(sourcePlatformIndex) || Number.isNaN(targetInstanceId)) {
			throw new Error("sourceInstanceId, sourcePlatformIndex, and targetInstanceId must be numbers");
		}
		const response = await control.sendTo("controller", new messages.StartPlatformTransferRequest({
			sourceInstanceId,
			sourcePlatformIndex,
			targetInstanceId,
			forceName: args.forceName || "player",
		})) as messages.SimpleResponse & { transferId?: string; exportId?: string };
		if (response.success) {
			console.log(`Transfer started: ${response.transferId || "pending"} (export=${response.exportId || "n/a"})`);
			return;
		}
		throw new Error(response.error || "Unknown transfer start failure");
	},
}));

surfaceExportCommands.add(new Command({
	definition: [
		"transfer <exportId> <instanceId>",
		"Import a stored export onto the target instance",
		(yargs: YargsLike) => {
			yargs.positional("exportId", { describe: "Stored export identifier", type: "string" });
			yargs.positional("instanceId", { describe: "ID of target instance", type: "number" });
		},
	],
	handler: async function(args: { exportId: string; instanceId: number | string }, control: ControlLike) {
		const targetInstanceId = Number(args.instanceId);
		if (Number.isNaN(targetInstanceId)) {
			throw new Error("instanceId must be a number");
		}
		const response = await control.sendTo("controller", new messages.TransferPlatformRequest({
			exportId: args.exportId,
			targetInstanceId,
		})) as messages.SimpleResponse;
		if (response.success) {
			console.log(`Transfer of ${args.exportId} to instance ${targetInstanceId} succeeded`);
			return;
		}
		throw new Error(response.error || "Unknown transfer failure");
	},
}));

export class CtlPlugin extends BaseCtlPlugin {
	declare logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
	async addCommands(rootCommand: { add: (command: unknown) => void }) {
		rootCommand.add(surfaceExportCommands);
	}
}

