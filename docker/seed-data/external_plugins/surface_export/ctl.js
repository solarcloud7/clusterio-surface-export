/**
 * @file ctl.js
 * @description CLI commands for Surface Export plugin
 */

"use strict";
const { Command } = require("@clusterio/ctl");
const messages = require("./messages");

class TransferPlatformCommand extends Command {
	static definition = {
		name: "surface-export transfer <exportId> <targetInstanceId>",
		description: "Transfer a platform export to another instance",
		arguments: [
			{
				name: "exportId",
				description: "Export ID to transfer",
			},
			{
				name: "targetInstanceId",
				description: "Destination instance ID",
				type: "integer",
			},
		],
	};

	async run(args) {
		const exportId = args.exportId;
		const targetInstanceId = args.targetInstanceId;

		this.logger.info(`Transferring platform ${exportId} to instance ${targetInstanceId}...`);

		const response = await this.sendTo(
			"controller",
			new messages.TransferPlatformRequest({
				exportId,
				targetInstanceId,
			})
		);

		if (response.success) {
			this.logger.info(`✓ Transfer initiated: ${response.transferId}`);
			this.logger.info(`Monitor logs for validation and completion`);
		} else {
			this.logger.error(`✗ Transfer failed: ${response.error}`);
		}
	}
}

class ListExportsCommand extends Command {
	static definition = {
		name: "surface-export list",
		description: "List all stored platform exports on controller",
	};

	async run() {
		this.logger.info("Listing platform exports...");

		const exports = await this.sendTo(
			"controller",
			new messages.ListExportsRequest()
		);

		if (exports.length === 0) {
			this.logger.info("No platform exports found");
			return;
		}

		this.logger.info(`Found ${exports.length} export(s):\n`);

		console.log("Export ID                              | Platform Name          | Instance | Size");
		console.log("-------------------------------------- | ---------------------- | -------- | --------");

		for (const exp of exports) {
			const exportId = exp.exportId.padEnd(38);
			const platformName = exp.platformName.substring(0, 22).padEnd(22);
			const instanceId = exp.instanceId.toString().padEnd(8);
			const sizeMB = (exp.size / 1024 / 1024).toFixed(2);
			console.log(`${exportId} | ${platformName} | ${instanceId} | ${sizeMB} MB`);
		}
	}
}

module.exports = {
	commands: [
		TransferPlatformCommand,
		ListExportsCommand,
	],
};
