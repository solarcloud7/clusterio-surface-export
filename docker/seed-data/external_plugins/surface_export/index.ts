/**
 * @file index.ts
 * @description Clusterio plugin for exporting and importing Factorio space platforms
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

const lib = require("@clusterio/lib") as { definePermission(opts: { name: string; title: string; description: string }): void };

import * as messages from "./messages";
const { PERMISSIONS } = messages;

const PLUGIN_NAME = "surface_export";

lib.definePermission({
	name: PERMISSIONS.LIST_EXPORTS,
	title: "List Surface Exports",
	description: "Allows listing stored Surface Export platform snapshots on the controller.",
});

lib.definePermission({
	name: PERMISSIONS.TRANSFER_EXPORTS,
	title: "Transfer Surface Exports",
	description: "Allows pushing a stored Surface Export snapshot onto a target instance.",
});

lib.definePermission({
	name: PERMISSIONS.UI_VIEW,
	title: "View Surface Export UI",
	description: "Allows viewing Surface Export web UI pages and platform tree data.",
});

lib.definePermission({
	name: PERMISSIONS.VIEW_LOGS,
	title: "View Surface Export Transaction Logs",
	description: "Allows viewing transaction log summaries and details for Surface Export transfers.",
});

export const plugin = {
	name: PLUGIN_NAME,
	title: "Surface Export",
	description: "Export and import Factorio space platforms between Clusterio instances",
	instanceEntrypoint: "dist/node/instance",
	controllerEntrypoint: "dist/node/controller",
	webEntrypoint: "./web",
	routes: ["/surface-export"],
	// alpha.25 (#884): plugins that save-patch a Lua module and/or run /sc script commands must
	// declare these so the host validates the instance has both enabled before loading the plugin.
	features: ["SavePatching", "ScriptCommands"],
	instanceConfigFields: {
		[`${PLUGIN_NAME}.max_export_cache_size`]: {
			description: "Maximum number of platform exports to cache per instance",
			type: "number",
			initialValue: 10,
		},
		[`${PLUGIN_NAME}.batch_size`]: {
			description: "Number of entities to process per tick during async operations",
			type: "number",
			initialValue: 50,
			optional: true,
		},
		[`${PLUGIN_NAME}.max_concurrent_jobs`]: {
			description: "Maximum number of concurrent async import/export jobs",
			type: "number",
			initialValue: 3,
			optional: true,
		},
		[`${PLUGIN_NAME}.show_progress`]: {
			description: "Show progress notifications for async operations",
			type: "boolean",
			initialValue: true,
			optional: true,
		},
		[`${PLUGIN_NAME}.debug_mode`]: {
			description: "Enable debug mode - exports JSON comparison files for transfer validation",
			type: "boolean",
			initialValue: true,
			optional: true,
		},
	},
	controllerConfigFields: {
		[`${PLUGIN_NAME}.max_storage_size`]: {
			description: "Maximum number of platform exports to store on controller",
			type: "number",
			initialValue: 20,
		},
	},
	messages: [
		messages.ExportPlatformRequest,
		messages.PlatformExportEvent,
		messages.ImportPlatformRequest,
		messages.ImportPlatformFromFileRequest,
		messages.ListExportsRequest,
		messages.GetStoredExportRequest,
		messages.ImportUploadedExportRequest,
		messages.ExportPlatformForDownloadRequest,
		messages.TransferPlatformRequest,
		messages.StartPlatformTransferRequest,
		messages.InstanceListPlatformsRequest,
		messages.TransferValidationEvent,
		messages.ImportOperationCompleteEvent,
		messages.DeleteSourcePlatformRequest,
		messages.UnlockSourcePlatformRequest,
		messages.TransferStatusUpdate,
		messages.GetPlatformTreeRequest,
		messages.ListTransactionLogsRequest,
		messages.GetTransactionLogRequest,
		messages.SetSurfaceExportSubscriptionRequest,
		messages.SurfaceExportTreeUpdateEvent,
		messages.SurfaceExportTransferUpdateEvent,
		messages.SurfaceExportLogUpdateEvent,
		messages.PlatformStateChangedEvent,
		messages.GetGatewaysRequest,
		messages.SetGatewayLinkRequest,
		messages.GetGatewayConfigRequest,
		messages.PushGatewayConfigRequest,
	],
	ctlEntrypoint: "dist/node/control",
};
