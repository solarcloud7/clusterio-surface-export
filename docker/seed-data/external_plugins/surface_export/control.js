"use strict";
function requireClusterioModule(moduleName) {
  if (require.main && typeof require.main.require === "function") {
    try {
      return require.main.require(moduleName);
    } catch (err) {
      // Fallback to local resolution below.
    }
  }
  return require(moduleName);
}

const { BaseCtlPlugin } = requireClusterioModule("@clusterio/ctl");
const { Command, CommandTree } = requireClusterioModule("@clusterio/lib");
const fs = require("fs");
const messages = require("./messages");

const surfaceExportCommands = new CommandTree({
  name: "surface-export",
  description: "Surface Export plugin commands",
});

surfaceExportCommands.add(new Command({
  definition: ["list", "List stored platform exports"],
  handler: async function(args, control) {
    const entries = await control.sendTo("controller", new messages.ListExportsRequest());
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
		(yargs) => {
			yargs.positional("exportId", { describe: "Stored export identifier", type: "string" });
			yargs.positional("outputFile", { describe: "Output file path (default: stdout)", type: "string" });
		},
	],
	handler: async function(args, control) {
		const response = await control.sendTo("controller", new messages.GetStoredExportRequest({
			exportId: args.exportId,
		}));
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
		(yargs) => {
			yargs.positional("file", { describe: "Path to JSON export file", type: "string" });
			yargs.positional("targetInstanceId", { describe: "Target instance ID", type: "number" });
			yargs.positional("forceName", { describe: "Force name", type: "string", default: "player" });
			yargs.positional("platformName", { describe: "Optional platform name override", type: "string" });
		},
	],
	handler: async function(args, control) {
		const targetInstanceId = Number(args.targetInstanceId);
		if (Number.isNaN(targetInstanceId)) {
			throw new Error("targetInstanceId must be a number");
		}
		const raw = fs.readFileSync(args.file, "utf8");
		let exportData;
		try {
			exportData = JSON.parse(raw);
		} catch (err) {
			throw new Error(`Invalid JSON in ${args.file}: ${err.message}`);
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
		}));
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
		(yargs) => {
			yargs.positional("sourceInstanceId", { describe: "Source instance ID", type: "number" });
			yargs.positional("sourcePlatformIndex", { describe: "Source platform index", type: "number" });
			yargs.positional("targetInstanceId", { describe: "Target instance ID", type: "number" });
			yargs.positional("forceName", { describe: "Force name", type: "string", default: "player" });
		},
	],
	handler: async function(args, control) {
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
		}));
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
    (yargs) => {
      yargs.positional("exportId", { describe: "Stored export identifier", type: "string" });
      yargs.positional("instanceId", { describe: "ID of target instance", type: "number" });
    },
  ],
  handler: async function(args, control) {
    const targetInstanceId = Number(args.instanceId);
    if (Number.isNaN(targetInstanceId)) {
      throw new Error("instanceId must be a number");
    }
    const response = await control.sendTo("controller", new messages.TransferPlatformRequest({
      exportId: args.exportId,
      targetInstanceId,
    }));
    if (response.success) {
      console.log(`Transfer of ${args.exportId} to instance ${targetInstanceId} succeeded`);
      return;
    }
    throw new Error(response.error || "Unknown transfer failure");
  },
}));

class CtlPlugin extends BaseCtlPlugin {
  async addCommands(rootCommand) {
    rootCommand.add(surfaceExportCommands);
  }
}

module.exports = CtlPlugin;
module.exports.CtlPlugin = CtlPlugin;
