import type * as lib from "@clusterio/lib";

import * as messages from "./messages.js";
const { PERMISSIONS } = messages;

const PLUGIN_NAME = "cluster_pause";

declare module "@clusterio/lib" {
	export interface Permissions {
		"cluster_pause.view": never;
		"cluster_pause.control": never;
	}
}

export const plugin = {
	name: PLUGIN_NAME,
	title: "Cluster Pause",
	description: "Pause every server together while nobody plays on any of them",
	instanceEntrypoint: "dist/node/instance.js",
	controllerEntrypoint: "dist/node/controller.js",
	ctlEntrypoint: "dist/node/control.js",
	features: ["SavePatching", "ScriptCommands"],
	permissions: [
		{
			name: PERMISSIONS.VIEW,
			title: "View the cluster pause state",
			description: "Allows reading the cluster pause phase, online players, holds and paused instances, and watching its changes.",
		},
		{
			name: PERMISSIONS.CONTROL,
			title: "Pause and resume the cluster",
			description: "Allows pausing every server at once while nobody is playing, and resuming them.",
		},
	],
	controllerConfigFields: {
		[`${PLUGIN_NAME}.enabled`]: {
			title: "Pause the cluster while nobody plays",
			description: "Pause every running server with cluster_pause loaded once no player is online on any server and no participant holds the pause. "
				+ "Any join resumes every server. Off keeps every server running.",
			type: "boolean",
			initialValue: false,
		},
		[`${PLUGIN_NAME}.countdown_ms`]: {
			title: "Countdown (ms)",
			description: "How long the whole cluster must stay empty before participants are told to stop admitting new work.",
			type: "number",
			initialValue: 30000,
		},
		[`${PLUGIN_NAME}.hold_check_interval_ms`]: {
			title: "Hold check interval (ms)",
			description: "Backstop interval for re-reading participant holds and retrying unconfirmed resumes.",
			type: "number",
			initialValue: 5000,
		},
	},
	messages: [
		messages.ClusterPauseRequest,
		messages.ClusterPauseStateEvent,
		messages.ClusterPauseInstanceReadyEvent,
		messages.ClusterPauseStatusRequest,
		messages.ClusterPauseControlRequest,
	],
} satisfies lib.PluginDeclaration;
