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
	features: ["SavePatching", "ScriptCommands"],
	instanceConfigFields: {
		[`${PLUGIN_NAME}.max_export_cache_size`]: {
			description:
				"Export cache size: how many completed platform exports each instance keeps in its save. " +
				"Older exports beyond this count are discarded when a new export completes; a discarded " +
				"export can no longer be re-downloaded or re-sent and must be re-exported from the platform. " +
				"An export belonging to a transfer that is still in flight is never discarded, whatever " +
				"this is set to. Exports made for download are NOT covered by that: the platform is " +
				"unlocked as soon as the export completes, so a download waiting to be fetched is " +
				"subject to this limit like any other. Set it generously if you export large platforms " +
				"for download while transfers are running. " +
				"Each retained export costs roughly the compressed size of that platform — exports made " +
				"by the clone path cost more, being stored uncompressed — so a high value grows the save " +
				"file. Values below max_concurrent_jobs + 1 are raised to it as a sanity floor.",
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
		[`${PLUGIN_NAME}.gateway_mode`]: {
			title: "Gateway mode",
			description: "Which gateway layout the cluster uses. \"one_gate\" (the default, \"1 Gate "
				+ "Cluster\") gives every instance a SINGLE gateway that can link to any number of other "
				+ "instances; a platform parked there is offered every destination to choose from. "
				+ "\"multi\" (\"Multi Cluster\", advanced) gives every instance FOUR colour-coded gateways, "
				+ "each carrying exactly one destination and no two pointing at the same instance — so the "
				+ "gateway a platform flies to decides where it lands, with nothing to choose on arrival. "
				+ "Only the active mode's gateways are unlocked in game, so the others never appear on the "
				+ "starmap. Switching is NOT destructive: each mode's links are kept while the other is "
				+ "active and come back on switching back. Instances must be restarted to pick up the "
				+ "change, because the unlock happens at startup. Unrecognised values fall back to "
				+ "\"one_gate\" and are logged.",
			type: "string",
			initialValue: messages.DEFAULT_GATEWAY_MODE,
		},
		[`${PLUGIN_NAME}.max_storage_size`]: {
			title: "Stored export payloads to keep",
			description: "How many platform export payloads the controller keeps on disk. Once the cap is "
				+ "reached, the OLDEST export is discarded to make room — nothing is lost from a transfer "
				+ "in progress, because a transfer reads its payload long before it could be evicted. "
				+ "What eviction does end is the ability to DOWNLOAD that export again: the Transaction "
				+ "Logs tab keeps showing the transfer, but its download button goes away once the payload "
				+ "is gone. Raise this if you want players to be able to send you the payload from older "
				+ "transfers for debugging; each stored export is roughly the size of the platform it "
				+ "captured (tens to hundreds of KB).",
			type: "number",
			initialValue: 20,
		},
		[`${PLUGIN_NAME}.transaction_log_detail_entries`]: {
			title: "Transfers keeping full detail",
			description: "How many transfers keep their EXPENSIVE detail — the event timeline, phase "
				+ "timings and validation counts shown when you open a transfer. Every transfer stays "
				+ "listed for good regardless of this number: the audit ledger keeps a slim row per "
				+ "transfer permanently, so lowering this never hides a transfer, it only means older "
				+ "ones open with their status but no timeline. Detail is kept preferentially for "
				+ "failures, then recent successes, preferring transfers whose export is still "
				+ "downloadable. Range 10–5000; out-of-range values are clamped and logged. Raise it if "
				+ "you investigate old transfers often; each retained entry is roughly 10 KB.",
			type: "number",
			initialValue: 100,
		},
		[`${PLUGIN_NAME}.transfer_validation_timeout_seconds`]: {
			title: "Transfer validation timeout (seconds)",
			description: "How long the controller waits for the destination to validate a transfer. "
				+ "The clock starts AFTER the payload is delivered and accepted — it covers the "
				+ "destination's import and validation, not delivery. On expiry the transfer is rolled "
				+ "back: the source platform is unlocked and stays on its instance. If the destination "
				+ "later finishes its import anyway, the transfer is re-marked cleanup_failed — a live "
				+ "copy exists on the destination; delete the copy you don't want before retrying. "
				+ "Range 5–120 seconds (the ceiling protects the source lock's validation budget); "
				+ "out-of-range values are clamped. Applies to the next transfer, no restart needed.",
			type: "number",
			initialValue: 30,
			optional: true,
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
		messages.GetSourceTransferLockStateRequest,
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
		messages.GetInstanceRosterRequest,
		messages.PushGatewayConfigRequest,
	],
	ctlEntrypoint: "dist/node/control",
};
