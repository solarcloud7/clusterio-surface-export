"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { InstancePlugin } = require(path.join(__dirname, "..", "dist", "node", "instance.js"));

test("an instance reports the auto_pause value its server started with", async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "se-auto-pause-"));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, "server-settings.json");
	const warnings = [];
	const plugin = Object.create(InstancePlugin.prototype);
	plugin.instance = { server: { writePath: name => path.join(directory, name) } };
	plugin.logger = { warn: message => warnings.push(message) };
	for (const [contents, expected] of [
		[{ auto_pause: true }, true],
		[{ auto_pause: false }, false],
		[{ name: "no auto_pause key" }, null],
	]) {
		fs.writeFileSync(file, JSON.stringify(contents));
		assert.equal(await plugin.readAppliedAutoPause(), expected, JSON.stringify(contents));
	}
	fs.rmSync(file);
	assert.equal(await plugin.readAppliedAutoPause(), null);
	assert.match(warnings.at(-1), /auto_pause setting this server started with/);
});

test("the platform list reply carries the applied auto_pause value", async () => {
	for (const applied of [true, false, null]) {
		const plugin = Object.create(InstancePlugin.prototype);
		plugin.instance = { id: 7, config: { get: () => "fact7" } };
		plugin.listPlatforms = async () => [];
		plugin.appliedAutoPause = applied;
		assert.equal((await plugin.handleInstanceListPlatformsRequest({})).autoPause, applied);
	}
});
