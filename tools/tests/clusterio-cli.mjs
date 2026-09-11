import assert from "node:assert/strict";
import configuration from "../../docker/production/configure.cjs";

export const contract = { requires: ["pinned native Clusterio CLI output"], produces: ["validated configuration values"],
	"does not": ["mutate configuration"] };
export function localConfigArgs(role, path, field) {
	assert.ok(["host", "controller"].includes(role));
	assert.ok(field.startsWith(`${role}.`));
	return [`/clusterio/node_modules/.bin/clusterio${role}`, "--log-level", "error", "--config", path,
		"config", "show", field];
}
export function readConfigList(raw, fields) {
	return configuration.readSettings(raw, fields);
}
