"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {ControllerConfig} = require("@clusterio/lib");
const {plugin} = require("../dist/node/index.js");

test("Clusterio rejects an invalid recovery policy when written, before restart", () => {
	class Config extends ControllerConfig {
		static fieldDefinitions = {...ControllerConfig.fieldDefinitions, ...plugin.controllerConfigFields};
	}
	const config = new Config("controller");
	const field = "surface_export.platform_source_of_truth";
	assert.equal(config.get(field), "plugin_history");
	assert.throws(() => config.set(field, "save-game"), /Expected one of/);
	assert.equal(config.get(field), "plugin_history", "invalid write changed the applied configuration");
	for (const mode of ["save_game", "plugin_history"]) {
		config.set(field, mode);
		assert.equal(config.get(field), mode);
	}
});
