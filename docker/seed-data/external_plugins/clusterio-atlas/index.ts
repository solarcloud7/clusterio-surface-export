/**
 * @file index.ts
 * @description Clusterio Atlas plugin — ingests Factorio map data (entities) into
 * the atlas database. Phase 0: data ingestion only (no rendering / tiles).
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

const PLUGIN_NAME = "clusterio-atlas";

export const plugin = {
	name: PLUGIN_NAME,
	title: "Clusterio Atlas",
	description: "Ingests Factorio map data (entities) into the atlas database",
	instanceEntrypoint: "dist/node/instance",
	// alpha.25 (#884): plugins that save-patch a Lua module must declare this so the
	// host validates the instance has SavePatching enabled before loading the plugin.
	features: ["SavePatching"],
	instanceConfigFields: {
		[`${PLUGIN_NAME}.atlas_pg_dsn`]: {
			description: "Postgres DSN for the atlas database (falls back to ATLAS_PG_DSN env)",
			type: "string",
			initialValue: "",
			optional: true,
		},
	},
	messages: [],
};
