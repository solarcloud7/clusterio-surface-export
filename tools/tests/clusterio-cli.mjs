import assert from "node:assert/strict";

// Native local reads return raw strings. Remote list values are JSON.
export function localConfigArgs(role, path, field) {
	assert.ok(["host", "controller"].includes(role));
	assert.ok(field.startsWith(`${role}.`));
	return [`/clusterio/node_modules/.bin/clusterio${role}`, "--log-level", "error", "--config", path,
		"config", "show", field];
}
export function readConfigList(raw, fields) {
	const values = {};
	for (const field of fields) {
		const lines = raw.split(/\r?\n/).filter(line => line.startsWith(`${field} `));
		assert.equal(lines.length, 1, `Expected one value for ${field}`);
		try { values[field] = JSON.parse(lines[0].slice(field.length + 1)); }
		catch (error) { throw new Error(`Invalid JSON value for ${field}; see retained command output`, { cause: error }); }
	}
	return values;
}
