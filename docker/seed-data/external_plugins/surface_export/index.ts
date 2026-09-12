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
			description: "Maximum entities processed per job batch. Several jobs may run in one tick; this does not limit time spent in other stages.",
			type: "number",
			initialValue: 50,
			optional: true,
		},
		[`${PLUGIN_NAME}.max_concurrent_jobs`]: {
			description: "Maximum import and export jobs advanced in one tick, combined. Runnable jobs take turns. Keep this at 1 to avoid stacking job steps in the same tick.",
			type: "number",
			initialValue: 1,
			optional: true,
		},
		[`${PLUGIN_NAME}.belt_batch_size`]: {
			description: "Target stacks or belt lines restored per batch. Each captured lane group is restored and checked together, so a large group may exceed this target.",
			type: "number", initialValue: 500,
		},
		[`${PLUGIN_NAME}.belt_trace`]: {
			description: "Record belt item positions after successful restoration. Failed restores retain this evidence even when tracing is off.",
			type: "boolean", initialValue: false,
		},
		[`${PLUGIN_NAME}.show_progress`]: {
			description: "Show in-game progress notifications for batched imports and exports.",
			type: "boolean",
			initialValue: true,
			optional: true,
		},
		[`${PLUGIN_NAME}.sectioned_codec`]: { description: "Experimental: encode and decode transfer payload sections across ticks. Leave off outside acceptance tests until rollout is verified.", type: "boolean", initialValue: false },
		[`${PLUGIN_NAME}.profile_batches`]: { description: "Save timings for up to 2,000 batches per job. Stage totals are always recorded.", type: "boolean", initialValue: false },
		[`${PLUGIN_NAME}.debug_mode`]: {
			description: "Enable debug mode - exports JSON comparison files for transfer validation",
			type: "boolean",
			initialValue: true,
			optional: true,
		},
		[`${PLUGIN_NAME}.debug_destination_snapshot`]: {
			title: "Capture full destination snapshots",
			description: "Save a full platform snapshot after successful validation. Requires debug mode and adds a scan that can pause the game. Transfer logs and failure diagnostics remain available when this is off.",
			type: "boolean", initialValue: false,
		},
	},
	controllerConfigFields: {
		[`${PLUGIN_NAME}.max_inflight_transfers_per_instance`]: { description: "Experimental: admitted transfers per instance (1–4). Default 1 retains serial transfers. Lua jobs share the instance tick budget; recovery blocks new admissions.", type: "number", initialValue: 1 },
		[`${PLUGIN_NAME}.gateway_mode`]: {
			title: "Gateway mode",
			description: "Which gateway layout the cluster uses. \"one_gate\" (the default, \"1 Gate "
				+ "Cluster\") gives every instance a SINGLE gateway that can link to any number of other "
				+ "instances; a platform parked there is offered every destination to choose from. "
				+ "\"multi\" (\"Multi Cluster\", advanced) gives every instance FOUR colour-coded gateways, "
				+ "each carrying exactly one destination and no two pointing at the same instance — so the "
				+ "gateway a platform flies to decides where it lands, with nothing to choose on arrival. "
				+ "Only the active mode's gateways are unlocked in game. Set the mod pack's startup setting "
				+ "surfexp-gateway-layout to the same value to hide the other layout on the space map. "
				+ "Configured instance destinations are retained for each mode. Map layout changes remove "
				+ "inactive travel routes, which can strand parked platforms or reset travel progress; "
				+ "return all platforms to a planet before switching. Instances and clients must be restarted to pick up the "
				+ "change, because the unlock happens at startup. Unrecognised values fall back to "
				+ "\"one_gate\" and are logged.",
			type: "string",
			initialValue: messages.DEFAULT_GATEWAY_MODE,
		},
		[`${PLUGIN_NAME}.max_storage_size`]: {
			title: "Stored Payload Downloads",
			description: "Number of platform payload files retained for download. The oldest file is removed when the limit is reached. "
				+ "Removing a file does not remove its transfer log.",
			type: "number",
			initialValue: 20,
		},
		[`${PLUGIN_NAME}.platform_source_of_truth`]: {
			title: "Platform source of truth",
			description: "plugin_history protects restored source copies that already transferred away. save_game accepts restored copies with a warning. Applies when each instance restarts; active transfers remain protected.",
			type: "string",
			initialValue: "plugin_history",
		},
		[`${PLUGIN_NAME}.transaction_log_detail_entries`]: {
			title: "Saved Detailed Transfer Logs",
			description: "Number of transfers retaining step timings and audit evidence. Failed transfers take priority, followed by recent successes; "
				+ "availability of the payload download also affects retention. Other transfers keep their summary and outcome. Range: 10–5,000.",
			type: "number",
			initialValue: 100,
		},
		[`${PLUGIN_NAME}.transfer_validation_timeout_seconds`]: {
			title: "Check delayed job status after (seconds)",
			description: "After this wait, verify the Lua job state and progress. Queue waits and unavailable status do not cancel work or release platforms. "
				+ "Range: 5–120 seconds. Applies to the next transfer without a restart.",
			type: "number",
			initialValue: 30,
			optional: true,
		},
	},
	messages: [
		messages.OperationTimingEvent,
		messages.ExportPlatformRequest,
		messages.PlatformExportEvent,
		messages.ImportPlatformRequest,
		messages.JobsStatusRequest,
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
		messages.DestinationTransferGateRequest,
		messages.UnlockSourcePlatformRequest,
		messages.GetSourceTransferLockStateRequest,
		messages.TransferStatusUpdate,
		messages.GetPlatformTreeRequest,
		messages.ListTransactionLogsRequest,
		messages.GetTransactionLogRequest,
		messages.ReadEntityEvidenceRequest,
		messages.SetSurfaceExportSubscriptionRequest,
		messages.SurfaceExportTreeUpdateEvent,
		messages.SurfaceExportTransferUpdateEvent,
		messages.SurfaceExportLogUpdateEvent,
		messages.PlatformStateChangedEvent,
		messages.GetGatewaysRequest,
		messages.SetGatewayLinkRequest,
		messages.GetGatewayConfigRequest,
		messages.RecoveryPolicyRequest,
		messages.GetInstanceRosterRequest,
		messages.PushGatewayConfigRequest,
	],
	ctlEntrypoint: "dist/node/control",
};
