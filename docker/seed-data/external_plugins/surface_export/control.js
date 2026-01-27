"use strict";

const { BaseCtlPlugin } = require("@clusterio/ctl");
const { Command, CommandTree } = require("@clusterio/lib");
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
