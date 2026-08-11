"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			escapeString: (value) => String(value),
			wait: () => Promise.resolve(),
		};
	}
	if (request === "@clusterio/host") {
		return { BaseInstancePlugin: class {} };
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

test("bracketWrap picks a non-colliding level and round-trips hostile payloads", () => {
	for (const payload of ["plain", "a]]b", "a]=]b", "a]]b]=]c]==]d"]) {
		const wrapped = helpers.bracketWrap(payload);
		const m = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(wrapped);
		assert.ok(m, `wrapped form parses for ${JSON.stringify(payload)}`);
		assert.equal(m[2], payload);
		assert.ok(!payload.includes(`]${m[1]}]`), "chosen level cannot appear in the payload");
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

test("the boot pull retries exactly once and lands at error level, not warn", async () => {
	const plugin = Object.create(InstancePlugin.prototype);
	const warns = [];
	const errors = [];
	let attempts = 0;
	plugin.logger = { ...noopLogger, warn: (m) => warns.push(m), error: (m) => errors.push(m) };
	plugin.link = { async sendTo() { attempts++; throw new Error("controller unreachable"); } };
	plugin.i = { id: 42 };
	await plugin.sendGatewayConfigToLua();
	assert.equal(attempts, 2, "one retry, no more");
	assert.equal(warns.length, 1);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /running NO gateway config/);
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
