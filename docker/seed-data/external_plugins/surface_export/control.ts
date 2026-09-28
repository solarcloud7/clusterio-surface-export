import fs from "fs";
import { BaseCtlPlugin } from "@clusterio/ctl";
import { Command, CommandTree } from "@clusterio/lib";
import * as messages from "./messages";
import { getErrorMessage } from "./helpers";

type ControlLike = {
	sendTo: <T = unknown>(target: string, message: unknown) => Promise<T>;
};

type YargsLike = { positional: (name: string, opts: unknown) => void };

const surfaceExportCommands = new CommandTree({
	name: "surface-export",
	description: "Surface Export plugin commands",
});

surfaceExportCommands.add(new Command({
	definition: ["restore-snapshot <exportId> <targetInstanceId> <requestId> [platformName]",
		"Explicitly create a new copy from a retained snapshot; reuse requestId when retrying the same request",
		(yargs: YargsLike) => {
			yargs.positional("exportId", { type: "string", describe: "Stored snapshot identifier" });
			yargs.positional("targetInstanceId", { type: "number", describe: "Destination instance" });
			yargs.positional("requestId", { type: "string", describe: "UUID for this restoration request" });
			yargs.positional("platformName", { type: "string", describe: "Optional new platform name" });
		}],
	handler: async (args: { exportId: string; targetInstanceId: number; requestId: string; platformName?: string }, control: ControlLike) => {
		const response = await control.sendTo("controller", new messages.ImportUploadedExportRequest({
			targetInstanceId: args.targetInstanceId, exportData: {}, restoreExportId: args.exportId,
			restoreRequestId: args.requestId, platformName: args.platformName,
		})) as messages.SimpleResponse;
		if (!response.success) throw new Error(response.error || "Snapshot restoration refused");
		console.log(JSON.stringify(response));
	},
}));

surfaceExportCommands.add(new Command({
	definition: ["conflicts [instanceId]", "List quarantined platform copies, their live verdict and the actions each allows (JSON; hints are not authority)",
		(yargs: YargsLike) => {
			yargs.positional("instanceId", { type: "number", describe: "Only this instance" });
		}],
	handler: async (args: { instanceId?: number }, control: ControlLike) => {
		const response = await control.sendTo("controller", new messages.ListLineageConflictsRequest({ instanceId: args.instanceId ?? null }));
		console.log(JSON.stringify(response, null, 2));
	},
}));

surfaceExportCommands.add(new Command({
	definition: ["resolve-platform <instanceId> <platformIndex> <platformUid> <action> <requestId>",
		"Resolve one quarantined copy; reuse requestId when retrying the same request after a lost reply",
		(yargs: YargsLike) => {
			yargs.positional("instanceId", { type: "number", describe: "Instance holding the quarantined copy" });
			yargs.positional("platformIndex", { type: "number", describe: "Platform index shown by conflicts" });
			yargs.positional("platformUid", { type: "string", describe: "Platform identity shown by conflicts" });
			yargs.positional("action", { type: "string", choices: ["keep_this", "keep_other", "adopt", "stale_copy", "new_platform", "release"],
				describe: "Action offered by conflicts for this copy" });
			yargs.positional("requestId", { type: "string", describe: "Unique ID for this resolution request" });
		}],
	handler: async (args: { instanceId: number; platformIndex: number; platformUid: string; action: string; requestId: string }, control: ControlLike) => {
		const response = await control.sendTo("controller", new messages.ResolvePlatformLineageRequest({
			instanceId: args.instanceId, platformIndex: args.platformIndex, platformUid: args.platformUid,
			action: args.action as messages.ResolvePlatformLineageRequest["action"], requestId: args.requestId,
		})) as messages.SimpleResponse;
		if (!response.success) throw new Error(response.error || "Platform resolution refused");
		console.log(JSON.stringify(response));
	},
}));

surfaceExportCommands.add(new Command({
	definition: ["list", "List stored platform exports"],
	handler: async function(_args: Record<string, unknown>, control: ControlLike) {
		const entries = await control.sendTo("controller", new messages.ListExportsRequest()) as messages.StoredExportSummaryModel[];
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
		"list-transfers [limit]",
		"List recent transfer records as JSON (machine-readable; best-effort registry view)",
		(yargs: YargsLike) => {
			yargs.positional("limit", { describe: "Maximum records to return (1-500)", type: "number", default: 50 });
		},
	],
	handler: async function(args: { limit?: number | string }, control: ControlLike) {
		const limit = Number(args.limit ?? 50);
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
			throw new Error(`limit must be an integer between 1 and 500 (got ${JSON.stringify(args.limit)})`);
		}
		const summaries = await control.sendTo("controller",
			new messages.ListTransactionLogsRequest({ limit })) as messages.TransferSummaryModel[];
		console.log(JSON.stringify(summaries));
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
		})) as ReturnType<typeof messages.GetStoredExportRequest.Response.fromJSON>;
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
		})) as ReturnType<typeof messages.ImportUploadedExportRequest.Response.fromJSON>;
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
		})) as ReturnType<typeof messages.StartPlatformTransferRequest.Response.fromJSON>;
		if (response.success) {
			console.log(`${response.message || "Transfer accepted"}: ${response.transferId || "pending"}`);
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
		})) as ReturnType<typeof messages.TransferPlatformRequest.Response.fromJSON>;
		if (response.success) {
			console.log(`Transfer of ${args.exportId} to instance ${targetInstanceId} succeeded`);
			return;
		}
		throw new Error(response.error || "Unknown transfer failure");
	},
}));

surfaceExportCommands.add(new Command({
	definition: ["gateways", "Print the coloured portal held by each server, the colours held by servers whose plugin is off, the retired colours and the servers without a colour as JSON; the Gateway reaches every other server"],
	handler: async function(_args: Record<string, unknown>, control: ControlLike) {
		const response = await control.sendTo("controller", new messages.GetGatewaysRequest());
		console.log(JSON.stringify(response));
	},
}));

const portalCommands = new CommandTree({
	name: "portal",
	description: "Assign or release the coloured portals (Blue, Green, Orange, Purple) that lead to each server",
});

portalCommands.add(new Command({
	definition: ["assign <instance> <portal>", "Make a portal colour lead to a server; a colour held by another server must be released first",
		(yargs: YargsLike) => {
			yargs.positional("instance", { type: "string", describe: "Instance name or id" });
			yargs.positional("portal", { type: "string", describe: "1-4 or blue, green, orange, purple" });
		}],
	handler: async (args: { instance: string | number; portal: string | number }, control: ControlLike) => {
		const response = await control.sendTo("controller", new messages.SetPortalRequest({
			action: "assign", portal: String(args.portal), instance: String(args.instance),
		}));
		console.log(JSON.stringify(response));
	},
}));

portalCommands.add(new Command({
	definition: ["release <portal>", "Free a portal colour; it stays locked everywhere until it is assigned again",
		(yargs: YargsLike) => {
			yargs.positional("portal", { type: "string", describe: "1-4 or blue, green, orange, purple" });
		}],
	handler: async (args: { portal: string | number }, control: ControlLike) => {
		const response = await control.sendTo("controller", new messages.SetPortalRequest({ action: "release", portal: String(args.portal) }));
		console.log(JSON.stringify(response));
	},
}));

surfaceExportCommands.add(portalCommands);

export class CtlPlugin extends BaseCtlPlugin {
	override async addCommands(rootCommand: CommandTree) {
		rootCommand.add(surfaceExportCommands);
	}
}
