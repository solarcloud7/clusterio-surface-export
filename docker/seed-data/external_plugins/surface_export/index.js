/**
 * @file index.js
 * @description Clusterio plugin for exporting and importing Factorio space platforms
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

"use strict";
const lib = require("@clusterio/lib");
const PLUGIN_NAME = "surface_export";
const messages = require("./messages");
const { PERMISSIONS } = messages;

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

/**
 * Plugin declaration
 * This is the main export that Clusterio looks for to recognize the plugin
 */
module.exports.plugin = {
	// Internal plugin identifier used by Clusterio
	name: PLUGIN_NAME,
	
	// Display name shown to users
	title: "Surface Export",
	
	// Brief description
	description: "Export and import Factorio space platforms between Clusterio instances",
	
	// Path to instance plugin class (runs on hosts with Factorio servers)
	instanceEntrypoint: "instance",
	
	// Path to controller plugin class (runs on central controller)
	controllerEntrypoint: "controller",

	// Path to web plugin class (runs in Clusterio web UI)
	webEntrypoint: "./web",

	// UI routes served by controller
	routes: ["/surface-export"],
	
	// Instance configuration fields
	// These can be set per-instance using clusterioctl
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
	
	// Controller configuration fields
	// These are global controller settings
	controllerConfigFields: {
		// Example: Global platform storage limit
		[`${PLUGIN_NAME}.max_storage_size`]: {
			description: "Maximum number of platform exports to store on controller",
			type: "number",
			initialValue: 100,
		},
	},
	
	// Link messages for communication between controller/instances/ctl
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
	],

	// Optional CLI enhancements for clusterioctl
	ctlEntrypoint: "control",
};
