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
		plugin.readTickPaused = async () => ({ paused: false, clusterPause: false });
		plugin.appliedAutoPause = applied;
		assert.equal((await plugin.handleInstanceListPlatformsRequest({})).autoPause, applied);
	}
});

test("an instance reads whether its game is paused and whether cluster_pause is loaded", async () => {
	const warnings = [];
	const plugin = Object.create(InstancePlugin.prototype);
	plugin.logger = { warn: message => warnings.push(message) };
	let reply;
	const commands = [];
	plugin.instance = { sendRcon: async command => { commands.push(command); if (reply instanceof Error) throw reply; return reply; } };
	for (const [raw, expected] of [
		["paused\n", { paused: true, clusterPause: false }],
		["running", { paused: false, clusterPause: false }],
		["paused cluster_pause", { paused: true, clusterPause: true }],
		["running cluster_pause\n", { paused: false, clusterPause: true }],
		["Cannot execute command", null],
		["", null],
		[new Error("RCON closed"), null],
	]) {
		reply = raw;
		assert.deepEqual(await plugin.readTickPaused(), expected, String(raw));
	}
	assert.match(commands[0], /game\.tick_paused/);
	assert.match(commands[0], /remote\.interfaces\["cluster_pause"\]/);
	assert.match(warnings.at(-1), /Could not read whether the game is paused: RCON closed/);
});

test("the platform list reply carries whether the game is paused, or null when unreadable", async () => {
	for (const [state, expected] of [[{ paused: true, clusterPause: false }, true], [{ paused: false, clusterPause: true }, false], [null, null]]) {
		const plugin = Object.create(InstancePlugin.prototype);
		plugin.instance = { id: 7, config: { get: () => "fact7" } };
		plugin.listPlatforms = async () => [];
		plugin.readTickPaused = async () => state;
		plugin.appliedAutoPause = false;
		assert.equal((await plugin.handleInstanceListPlatformsRequest({})).tickPaused, expected);
	}
});

test("a save that loads paused without cluster_pause logs how to resume it", async () => {
	for (const [state, warned] of [
		[{ paused: true, clusterPause: false }, true],
		[{ paused: true, clusterPause: true }, false],
		[{ paused: false, clusterPause: false }, false],
		[null, false],
	]) {
		const warnings = [];
		const plugin = Object.create(InstancePlugin.prototype);
		plugin.logger = { warn: message => warnings.push(message) };
		plugin.readTickPaused = async () => state;
		assert.equal(await plugin.warnIfFrozen(), warned, JSON.stringify(state));
		assert.equal(warnings.length, warned ? 1 : 0);
		if (warned) assert.match(warnings[0], /game\.tick_paused = false/);
	}
});
