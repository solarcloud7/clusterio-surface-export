"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Module = require("node:module");
const originalLoad = Module._load;
let waitGate = () => Promise.resolve();
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			escapeString: (value) => String(value),
			wait: (...args) => waitGate(...args),
		};
	}
	if (request === "@clusterio/host") {
		return { BaseInstancePlugin: class { onExit() {} } };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const pluginDir = path.join(__dirname, "..");
const distNode = path.join(pluginDir, "dist", "node");
const helpers = require(path.join(distNode, "helpers.js"));
const { LuaInterface } = require(path.join(distNode, "lib", "lua-interface.js"));
const { InstancePlugin } = require(path.join(distNode, "instance.js"));

const noopLogger = { info() {}, verbose() {}, warn() {}, error() {} };

function makeHost(reply) {
	const commands = [];
	return {
		commands,
		host: {
			async sendRcon(script) {
				commands.push(script);
				return reply(script, commands.length);
			},
		},
	};
}

function happyReply(json) {
	const ascii = helpers.toAsciiJson(json);
	const gateways = Object.keys(JSON.parse(json)).length;
	return (script) => {
		if (script.includes("configure_gateways_begin")) { return '{"ok":true}'; }
		if (script.includes("configure_gateways_chunk")) { return '{"ok":true,"received":1}'; }
		return JSON.stringify({ ok: true, gateways, bytes: ascii.length });
	};
}

function smallConfig() {
	return JSON.stringify({ surfexp_gateway_1: { targets: [] } });
}

function bigConfig() {
	const keyed = {};
	for (let g = 1; g <= 4; g++) {
		const targets = [];
		for (let t = 0; t < 60; t++) {
			targets.push({
				instanceId: 1000 + t,
				instanceName: `instance-${g}-${t}-${"x".repeat(300)}`,
				targetGateway: `surfexp_gateway_${g}`,
				online: true,
			});
		}
		keyed[`surfexp_gateway_${g}`] = { targets };
	}
	return JSON.stringify(keyed);
}

test("a small config goes as ONE command through configure_gateways", async () => {
	const json = smallConfig();
	const { commands, host } = makeHost(happyReply(json));
	const lua = new LuaInterface(host, noopLogger);
	const result = await lua.configureGateways(json);
	assert.equal(result.gateways, 1);
	assert.equal(commands.length, 1);
	assert.match(commands[0], /configure_gateways", \[=*\[/);
	assert.doesNotMatch(commands[0], /_begin|_chunk|_commit/);
});

test("an oversized config flips to the staged begin/chunk/commit sequence", async () => {
	const json = bigConfig();
	const { commands, host } = makeHost(happyReply(json));
	const lua = new LuaInterface(host, noopLogger);
	const result = await lua.configureGateways(json);
	assert.equal(result.gateways, 4);

	const ascii = helpers.toAsciiJson(json);
	const expectedChunks = Math.ceil(ascii.length / helpers.GATEWAY_CONFIG_CHUNK_SIZE);
	assert.equal(commands.length, 1 + expectedChunks + 1,
		"begin + N chunks + commit, nothing else");
	assert.match(commands[0], /configure_gateways_begin", "(gwcfg_[a-z0-9_]+)", \d+, "[0-9a-f]{8}"/);
	const token = /configure_gateways_begin", "(gwcfg_[a-z0-9_]+)"/.exec(commands[0])[1];
	const beginTotal = Number(/configure_gateways_begin", "[^"]+", (\d+),/.exec(commands[0])[1]);
	assert.equal(beginTotal, expectedChunks, "begin declares the true chunk count");
	const beginChecksum = /configure_gateways_begin", "[^"]+", \d+, "([0-9a-f]{8})"/.exec(commands[0])[1];
	assert.equal(beginChecksum, helpers.simpleChecksum(ascii));
	for (let i = 1; i <= expectedChunks; i++) {
		assert.match(commands[i], new RegExp(`configure_gateways_chunk", "${token}", ${i}, \\[`),
			"chunks carry the same token with ascending 1-based indices");
		assert.ok(Buffer.byteLength(commands[i], "utf8") < 41_500,
			`chunk command ${i} stays under the wire budget`);
	}
	assert.match(commands[commands.length - 1], new RegExp(`configure_gateways_commit", "${token}"`));
});

test("reassembling the captured chunk payloads reproduces the ASCII JSON byte-for-byte", async () => {
	const json = bigConfig();
	const { commands, host } = makeHost(happyReply(json));
	const lua = new LuaInterface(host, noopLogger);
	await lua.configureGateways(json);
	const parts = [];
	for (const script of commands) {
		const m = /configure_gateways_chunk", "[^"]+", (\d+), \[(=*)\[([\s\S]*)\]\2\]\)/.exec(script);
		if (m) { parts[Number(m[1]) - 1] = m[3]; }
	}
	assert.equal(parts.filter(p => p !== undefined).length, parts.length, "no index gaps");
	assert.equal(parts.join(""), helpers.toAsciiJson(json),
		"this concat IS the seam between the Node driver and the Lua accumulator");
});

test("toAsciiJson output is pure ASCII and decodes identically", () => {
	const json = JSON.stringify({ "surfexp_gateway_1": { targets: [{ instanceName: "hübsch-工場-\"quoted\"-🚀" }] } });
	const ascii = helpers.toAsciiJson(json);
	for (let i = 0; i < ascii.length; i++) {
		assert.ok(ascii.charCodeAt(i) <= 0x7e, `code unit ${i} is not ASCII`);
	}
	assert.equal(Buffer.byteLength(ascii, "utf8"), ascii.length, "JS length == UTF-8 bytes");
	assert.deepEqual(JSON.parse(ascii), JSON.parse(json));
});

test("simpleChecksum matches known vectors and the Lua source still implements the same algorithm", () => {
	assert.equal(helpers.simpleChecksum(""), "00000000");
	assert.equal(helpers.simpleChecksum("a"), (97).toString(16).padStart(8, "0"));
	let expected = 0;
	for (const ch of "abc") { expected = (expected * 31 + ch.charCodeAt(0)) % 4294967296; }
	assert.equal(helpers.simpleChecksum("abc"), expected.toString(16).padStart(8, "0"));

	const luaSource = fs.readFileSync(path.join(pluginDir, "module", "utils", "string-utils.lua"), "utf8");
	assert.match(luaSource, /hash \* 31 \+ char_code\) % 4294967296/,
		"the JS mirror silently diverging from string-utils.lua is the failure mode this pin exists for");
	assert.match(luaSource, /"%08x"/, "the Lua side formats as %08x");
});

test("bracketWrap picks a level whose FIRST closing delimiter is the real end (the Lua lexer does not backtrack)", () => {
	for (const payload of ["plain", "a]]b", "a]=]b", "a]]b]=]c]==]d", "a]=", "a]==", "]=", "a]", "]"]) {
		const wrapped = helpers.bracketWrap(payload);
		const level = /^\[(=*)\[/.exec(wrapped)[1];
		const closer = `]${level}]`;
		assert.equal(wrapped.indexOf(closer), `[${level}[`.length + payload.length,
			`for ${JSON.stringify(payload)} the first ${closer} must be the terminator — an earlier one `
			+ "closes the Lua long string early and the remainder is a parse error");
		assert.equal(wrapped.slice(`[${level}[`.length, -closer.length), payload, "payload survives verbatim");
	}
});

test("a begin refusal stops the sequence before any chunk is sent", async () => {
	const json = bigConfig();
	const { commands, host } = makeHost((script) => {
		if (script.includes("configure_gateways_begin")) { return '{"ok":false,"error":"staging refused"}'; }
		return '{"ok":true}';
	});
	const lua = new LuaInterface(host, noopLogger);
	await assert.rejects(() => lua.configureGateways(json), /begin failed: staging refused/);
	assert.equal(commands.length, 1, "no chunk may follow a refused begin");
});

test("an echo-verify mismatch throws even when the instance reports ok", async () => {
	const json = smallConfig();
	const { host } = makeHost(() => '{"ok":true,"gateways":7,"bytes":1}');
	const lua = new LuaInterface(host, noopLogger);
	await assert.rejects(() => lua.configureGateways(json), /echo-verify failed/);
});

test("a non-JSON reply names the phase instead of parsing garbage", async () => {
	const json = smallConfig();
	const { host } = makeHost(() => "Unknown command");
	const lua = new LuaInterface(host, noopLogger);
	await assert.rejects(() => lua.configureGateways(json), /apply: non-JSON reply/);
});

test("handlePushGatewayConfig maps an apply failure to {success:false} and success logs the count", async () => {
	const plugin = Object.create(InstancePlugin.prototype);
	const infos = [];
	plugin.logger = { ...noopLogger, info: (m) => infos.push(m) };
	plugin.applyGatewaysToLua = async () => { throw new Error("boom"); };
	const failure = await plugin.handlePushGatewayConfig({ gateways: [] });
	assert.deepEqual(failure, { success: false, error: "boom" });

	plugin.applyGatewaysToLua = async () => ({ gateways: 3 });
	const success = await plugin.handlePushGatewayConfig({ gateways: [] });
	assert.deepEqual(success, { success: true });
	assert.ok(infos.some(m => /applied: 3 gateway/.test(m)));
});

test("the boot pull warns fast, retries once OFF the onStart hook, then lands at error level", async () => {
	const plugin = Object.create(InstancePlugin.prototype);
	const warns = [];
	const errors = [];
	let attempts = 0;
	plugin.logger = { ...noopLogger, warn: (m) => warns.push(m), error: (m) => errors.push(m) };
	Object.defineProperty(plugin, "link", {
		value: { async sendTo() { attempts++; throw new Error("controller unreachable"); } },
	});
	Object.defineProperty(plugin, "i", { value: { id: 42 } });
	let releaseRetry;
	waitGate = () => new Promise((resolve) => { releaseRetry = resolve; });
	try {
		await plugin.sendGatewayConfigToLua();
		assert.equal(attempts, 1,
			"onStart's await must see only the first attempt — Clusterio hard-caps the hook at 15s, "
			+ "and a 10s in-hook wait would consume two-thirds of every plugin's shared budget");
		assert.equal(warns.length, 1);
		releaseRetry();
		for (let i = 0; i < 4; i++) { await new Promise((resolve) => setImmediate(resolve)); }
		assert.equal(attempts, 2, "one detached retry, no more");
		assert.equal(errors.length, 1);
		assert.match(errors[0], /running NO gateway config/);
	} finally {
		waitGate = () => Promise.resolve();
	}
});

test("Lua source grounding: staging refusals, registration, prune placement, no debug gate", () => {
	const readModule = (rel) => fs.readFileSync(path.join(pluginDir, "module", rel), "utf8");
	const staging = readModule(path.join("core", "gateway-config-staging.lua"));
	assert.match(staging, /already received/, "duplicate index refusal");
	assert.match(staging, /superseded by a newer begin/, "token supersede refusal");
	assert.match(staging, /checksum mismatch/, "commit integrity check");
	assert.match(staging, /storage\.surface_export_gateway_staging = nil\s*\n\s*if staging\.received_count/,
		"the slot clears BEFORE the completeness check so no failure path leaves residue");
	assert.doesNotMatch(staging, /debug_mode/, "gateway config staging must NOT be debug-gated");

	const registration = readModule(path.join("interfaces", "remote-interface.lua"));
	for (const name of ["configure_gateways", "configure_gateways_begin",
		"configure_gateways_chunk", "configure_gateways_commit"]) {
		assert.match(registration, new RegExp(`\\n    ${name} = `),
			`${name} registered on the remote interface`);
	}

	const asyncProcessor = readModule(path.join("core", "async-processor.lua"));
	const pruneAt = asyncProcessor.indexOf("GatewayConfigStaging.prune()");
	const earlyReturnAt = asyncProcessor.indexOf("if not storage.async_jobs then return end");
	assert.ok(pruneAt !== -1 && earlyReturnAt !== -1 && pruneAt < earlyReturnAt,
		"the staging prune must run BEFORE the async_jobs early-return or an idle instance never prunes");
});

test("startup hook returns while recovery waits; stop prevents stale finish and configuration", async () => {
	for (const stopHook of ["onStop", "onExit"]) {
	const plugin = Object.create(InstancePlugin.prototype);
	plugin.logger = noopLogger;
	Object.defineProperty(plugin, "i", { value: { id: 42, sendTo: async () => ({ mode: "plugin_history", allowAdoption: true }) } });
	plugin.ensureLuaConsoleUnlocked = async () => {};
	plugin.retirementJournal = { snapshot: () => ({ id: "journal", retirements: [] }) };
	const calls = [];
	let release;
	plugin.lua = { uploads: {initialize: async () => {}, stop() {}}, sourceRecovery: async action => {
		calls.push(action);
		if (action === "begin") return new Promise(resolve => { release = resolve; });
		return '{"success":true}';
	} };
	plugin.sendConfigurationToLua = async () => calls.push("config");
	plugin.sendGatewayConfigToLua = async () => calls.push("gateways");
	let hookReturned = false;
	const hook = plugin.onStart().then(() => { hookReturned = true; });
	for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
	assert.equal(hookReturned, true, "startup hook must not wait for the roster RCON reply");
	assert.deepEqual(calls, ["begin"]);
	await plugin[stopHook]();
	release('{"success":true,"platforms":[{"platformIndex":3,"platformUid":"u"}]}');
	await hook;
	for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(calls, ["begin"], "stopped runtime issued reconciliation/configuration");
	}
});

test("source identity parse failures include bounded raw evidence and cannot authorize deletion", async () => {
	const plugin = Object.create(InstancePlugin.prototype);
	plugin.logger = noopLogger;
	plugin.lua = { sourceRecovery: async () => 'RCON truncated: <bad reply>',
		deleteSourcePlatform: async () => { assert.fail("invalid reply authorized deletion"); } };
	const response = await plugin.handleDeleteSourcePlatformMeasured({ platformIndex: 3, platformName: "p", exportId: "job" });
	assert.equal(response.success, false);
	assert.match(response.error, /Source recovery identity returned invalid JSON: RCON truncated/);
});

test("background recovery visits all 500 identities before finish and reports a refused roster", async () => {
	for (const refuse of [false, true]) {
		const plugin = Object.create(InstancePlugin.prototype);
		const errors = [], calls = [];
		plugin.logger = { ...noopLogger, error: message => errors.push(message) };
		plugin.instance = { id: 42, config: { get: key => key === "instance.name" ? "Instance 42" : undefined },
			sendTo: async () => ({ mode: "plugin_history", allowAdoption: true }) };
		plugin.ensureLuaConsoleUnlocked = async () => {};
		plugin.retirementJournal = { snapshot: () => ({ id: "journal", retirements: [{ platformUid: "u499", exportId: "retired" }] }) };
		plugin.lua = { uploads: {initialize: async () => {}, stop() {}}, configurePlanetPolicy: async () => calls.push(["planets"]), sourceRecovery: async (action, ...args) => {
			calls.push([action, ...args]);
			await new Promise(resolve => setImmediate(resolve));
			if (action === "begin") return JSON.stringify(refuse ? { success: false, error: "wrong journal" }
				: { success: true, platforms: Array.from({ length: 500 }, (_, i) => ({ platformIndex: i, platformUid: `u${i}` })) });
			return '{"success":true}';
		} };
		let done = false;
		plugin.sendConfigurationToLua = async () => calls.push(["config"]);
		plugin.sendGatewayConfigToLua = async () => { done = true; };
		await plugin.onStart();
		assert.equal(done, false);
		for (let i = 0; i < 550 && !done && !errors.length; i++) await new Promise(resolve => setImmediate(resolve));
		if (refuse) {
			assert.match(errors[0], /platforms remain protected.*wrong journal/);
			assert.deepEqual(calls.map(call => call[0]), ["begin"]);
		} else {
			assert.equal(done, true);
			assert.equal(calls.filter(call => call[0] === "reconcile").length, 500);
		assert.deepEqual(calls[500], ["reconcile", 499, "u499", "retired", false]);
			assert.deepEqual(calls.slice(-3), [["planets"], ["finish"], ["config"]]);
		}
	}
});

test("debug configuration requires an applied Lua acknowledgement", async () => {
	const cfg = {batchSize: 10, maxConcurrentJobs: 1, showProgress: false, debugMode: true, maxExportCacheSize: 5};
	for (const reply of ["", "script error", "null", "{}", '{"configured":false,"debugMode":true}', '{"configured":true,"debugMode":false}']) {
		const lua = new LuaInterface({sendRcon: async () => reply});
		await assert.rejects(lua.configure(cfg));
	}
	await new LuaInterface({sendRcon: async () => '{"configured":true,"debugMode":true}'}).configure(cfg);
});

test("platform status retains applied debug mode until successful reconfiguration", async () => {
	const plugin = Object.create(InstancePlugin.prototype);
	let configured = true;
	plugin.cfg = key => key === "surface_export.debug_mode" ? configured : 10;
	plugin.lua = {configure: async () => {}};
	plugin.instance = {id: 1, config: {get: () => "fact1"}};
	plugin.listPlatforms = async () => [];
	plugin.logger = noopLogger;
	assert.equal((await plugin.handleInstanceListPlatformsRequest({})).debugMode, false);
	await plugin.sendConfigurationToLua();
	configured = false;
	assert.equal((await plugin.handleInstanceListPlatformsRequest({})).debugMode, true);
	plugin.lua.configure = async () => {throw Error("not applied");};
	await plugin.sendConfigurationToLua();
	assert.equal((await plugin.handleInstanceListPlatformsRequest({})).debugMode, true);
	plugin.lua.configure = async () => {};
	await plugin.sendConfigurationToLua();
	assert.equal((await plugin.handleInstanceListPlatformsRequest({})).debugMode, false);
});

function unwrapBracket(text) {
	const match = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(text);
	assert.ok(match, `not a long-bracket string: ${text.slice(0, 40)}`);
	return match[2];
}

test("go_live stages a large passenger manifest in complete 1-based chunks before activation", async () => {
	const passengers = Array.from({ length: 30 }, (_, i) => ({
		name: `player-${i}-é`,
		items: Array.from({ length: 20 }, (_, j) => ({ name: `item-${j}-${"x".repeat(60)}`, count: j + 1 })),
	}));
	const expected = helpers.toAsciiJson(JSON.stringify(passengers));
	assert.ok(expected.length > helpers.GATEWAY_CONFIG_CHUNK_SIZE, "fixture must need several chunks");
	const { commands, host } = makeHost(script => script.includes("passenger_manifest_stage")
		? '{"ok":true,"received":1}' : '{"success":true}');
	const lua = new LuaInterface(host, noopLogger);
	const reply = await lua.destinationTransferGate("1:job", "go_live", passengers);
	assert.equal(reply, '{"success":true}');
	const stages = commands.slice(0, -1);
	const total = Math.ceil(expected.length / helpers.GATEWAY_CONFIG_CHUNK_SIZE);
	assert.equal(stages.length, total);
	let joined = "";
	stages.forEach((command, i) => {
		const match = /^\/sc rcon\.print\(remote\.call\("surface_export", "passenger_manifest_stage", "1:job", (\d+), (\d+), ([\s\S]*)\)\)$/.exec(command);
		assert.ok(match, command.slice(0, 120));
		assert.equal(Number(match[1]), i + 1);
		assert.equal(Number(match[2]), total);
		joined += unwrapBracket(match[3]);
	});
	assert.equal(joined, expected);
	assert.equal(commands.at(-1), '/sc rcon.print(remote.call("surface_export", "destination_hold_json", "go_live", "1:job"))');
});

test("go_live without passengers and verify with passengers send no staging", async () => {
	for (const [action, passengers] of [["go_live", undefined], ["go_live", []], ["verify", [{ name: "alice", items: [] }]]]) {
		const { commands, host } = makeHost(() => '{"success":true}');
		const lua = new LuaInterface(host, noopLogger);
		await lua.destinationTransferGate("1:job", action, passengers);
		assert.equal(commands.length, 1);
		assert.match(commands[0], new RegExp(`destination_hold_json", "${action}", "1:job"`));
	}
});

test("a refused passenger stage prevents activation", async () => {
	const { commands, host } = makeHost(() => '{"ok":false,"error":"stale transfer"}');
	const lua = new LuaInterface(host, noopLogger);
	await assert.rejects(() => lua.destinationTransferGate("1:job", "go_live", [{ name: "alice", items: [] }]),
		/stage 1\/1 failed: stale transfer/);
	assert.equal(commands.some(command => command.includes("destination_hold_json")), false);
});

test("passengerManifest normalizes empty Lua tables and rejects refusals", async () => {
	const replies = [
		'{"success":true,"passengers":{}}',
		'{"success":true,"passengers":[{"name":"alice","items":{}},{"name":"bob"},{"name":"carol","items":[{"name":"power-armor","count":1}]}]}',
		'{"success":false,"error":"no receipt"}',
		'{"success":true,"passengers":[{"items":[]}]}',
	];
	const { commands, host } = makeHost((_script, n) => replies[n - 1]);
	const lua = new LuaInterface(host, noopLogger);
	assert.deepEqual(await lua.passengerManifest("job_1"), []);
	assert.equal(commands[0], '/sc rcon.print(remote.call("surface_export", "passenger_manifest", "job_1"))');
	assert.deepEqual(await lua.passengerManifest("job_1"), [
		{ name: "alice", items: [] }, { name: "bob", items: [] }, { name: "carol", items: [{ name: "power-armor", count: 1 }] },
	]);
	await assert.rejects(() => lua.passengerManifest("job_1"), /refused: no receipt/);
	await assert.rejects(() => lua.passengerManifest("job_1"), /no player name/);
});

test("configurePassengerCarry sends both settings and verifies the echo", async () => {
	const { commands, host } = makeHost(() => '{"armor":false,"inventory":true}');
	const lua = new LuaInterface(host, noopLogger);
	await lua.configurePassengerCarry({ armor: false, inventory: true });
	assert.match(commands[0], /passenger_carry_armor=false, passenger_carry_inventory=true/);
	await assert.rejects(() => lua.configurePassengerCarry({ armor: true, inventory: true }), /acknowledgement does not match/);
	const empty = makeHost(() => "");
	await assert.rejects(() => new LuaInterface(empty.host, noopLogger).configurePassengerCarry({ armor: true, inventory: false }), /non-JSON reply/);
});

test("gateway pushes apply passenger carry after the gateways only when present", async () => {
	const plugin = Object.create(InstancePlugin.prototype);
	const calls = [];
	plugin.logger = noopLogger;
	plugin.lua = {
		configureGateways: async () => { calls.push("gateways"); return { gateways: 0 }; },
		configurePassengerCarry: async carry => { calls.push(carry); },
	};
	assert.deepEqual(await plugin.handlePushGatewayConfig({ gateways: [], passengerCarry: { armor: true, inventory: false } }), { success: true });
	assert.deepEqual(await plugin.handlePushGatewayConfig({ gateways: [] }), { success: true });
	assert.deepEqual(calls, ["gateways", { armor: true, inventory: false }, "gateways"]);
	plugin.lua.configurePassengerCarry = async () => { throw new Error("carry echo mismatch"); };
	assert.deepEqual(await plugin.handlePushGatewayConfig({ gateways: [], passengerCarry: { armor: true, inventory: false } }),
		{ success: false, error: "carry echo mismatch" });
});

test("source deletion returns the passenger manifest and fails closed without it", async () => {
	const passengers = [{ name: "alice", items: [{ name: "power-armor", count: 1 }] }];
	const makePlugin = manifest => {
		const plugin = Object.create(InstancePlugin.prototype);
		plugin.logger = noopLogger;
		plugin.retirementJournal = { retire: async () => {}, snapshot: () => ({ retirements: [] }) };
		plugin.lua = {
			sourceRecovery: async () => '{"success":true,"platformUid":"u","surfaceIndex":5}',
			deleteSourcePlatform: async () => "SUCCESS",
			passengerManifest: manifest,
		};
		return plugin;
	};
	const request = { platformIndex: 3, platformName: "p", exportId: "job" };
	let requestedJob;
	const ok = makePlugin(async jobId => { requestedJob = jobId; return passengers; });
	assert.deepEqual(await ok.handleDeleteSourcePlatformMeasured(request), { success: true, passengers });
	assert.equal(requestedJob, "job");
	const lost = makePlugin(async () => { throw new Error("rcon timeout"); });
	assert.deepEqual(await lost.handleDeleteSourcePlatformMeasured(request),
		{ success: false, error: "Source deleted; passenger manifest unavailable: rcon timeout" });
});

test("the destination gate handler forwards passengers to Lua", async () => {
	const plugin = Object.create(InstancePlugin.prototype);
	const seen = [];
	plugin.withTiming = (_id, _job, _label, fn) => fn();
	plugin.lua = { destinationTransferGate: async (...args) => { seen.push(args); return '{"success":true}'; } };
	const passengers = [{ name: "alice", items: [] }];
	assert.deepEqual(await plugin.handleDestinationTransferGate({ transferId: "1:job", action: "go_live", passengers }), { success: true });
	assert.deepEqual(seen, [["1:job", "go_live", passengers]]);
});
