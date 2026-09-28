import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { deflateSync, inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.resolve(ROOT, process.env.SE_PLUGIN_DIST || "docker/seed-data/external_plugins/surface_export/dist/node");
const LINEAGE = "lineage:source-boot:17";

function loadPlugin() {
	const require = createRequire(import.meta.url);
	const Module = require("node:module");
	const originalLoad = Module._load;
	Module._load = function(request, parent, main) {
		if (request === "@clusterio/lib") return { escapeString: String, wait: async () => {} };
		if (request === "@clusterio/host") return { BaseInstancePlugin: class {} };
		return originalLoad.call(this, request, parent, main);
	};
	try {
		return { ...require(path.join(DIST, "instance.js")), ...require(path.join(DIST, "lib", "lua-interface.js")) };
	} finally { Module._load = originalLoad; }
}

async function transportFor(exportData, sectioned) {
	const { InstancePlugin, LuaInterface } = loadPlugin();
	const plugin = Object.create(InstancePlugin.prototype);
	plugin.logger = { info() {}, warn() {}, error() {}, verbose() {} };
	plugin.lua = new LuaInterface({ sendRcon: async () => { throw new Error("no RCON in this test"); } }, plugin.logger);
	plugin.lua.sectionedCodec = sectioned;
	let sent;
	plugin.lua.uploads = { send: async (_operation, _name, _force, data) => { sent = data; return { jobId: "import_1", epoch: "e", attemptId: "a" }; } };
	const result = await plugin.handleImportPlatformRequestMeasured({ exportData, forceName: "player" });
	assert.equal(result.success, true);
	return JSON.parse(JSON.stringify(sent));
}

function luaCarry(binary, transport) {
	const decoded = {};
	for (const value of [transport.payload, ...(transport.sections || [])]) {
		if (typeof value === "string") decoded[value] = inflateSync(Buffer.from(value, "base64")).toString("utf8");
	}
	const run = spawnSync(binary, ["tests/lua/lineage-carry.lua"], { cwd: ROOT, input: JSON.stringify({ transport, decoded }),
		encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
	assert.equal(run.status, 0, run.stderr || run.stdout);
	const [, lineage, generation, holdLineage, holdGeneration, error] = run.stdout.trim().split(/\s+/);
	return { lineage, generation, holdLineage, holdGeneration, error };
}

test("lineage carry: a controller transfer delivers its lineage from the instance import request to the Lua destination hold", async t => {
	const binary = process.env.SE_TEST_LUA;
	if (!binary) return t.skip("set SE_TEST_LUA (CI runs this on Lua 5.2 after building the plugin)");
	const inner = { schema_version: 1, platform_name: "ship", platform: { force: "player", schedule: { records: [] } },
		entities: [{ name: "space-platform-hub", position: { x: 0, y: 0 } }], tiles: [], lineage: LINEAGE, generation: 1 };
	const envelopes = {
		plain: inner,
		compressed: { compressed: true, compression: "deflate", payload: deflateSync(JSON.stringify(inner)).toString("base64"),
			platform_name: "ship", lineage: LINEAGE, generation: 1 },
	};
	for (const [codec, envelope] of Object.entries(envelopes)) {
		for (const sectioned of [false, true]) {
			const label = `${codec}${sectioned ? " sectioned" : ""}`;
			const transfer = { ...envelope, _transferId: "7:job-carry", _sourceInstanceId: 7, _lineage: LINEAGE, _lineageGeneration: 1 };
			const transport = await transportFor(transfer, sectioned);
			if (sectioned) assert.equal(transport.section_codec, 1, `${label} did not use the section codec`);
			const carried = luaCarry(binary, transport);
			assert.deepEqual([carried.lineage, carried.generation, carried.holdLineage, carried.holdGeneration, carried.error],
				[LINEAGE, "1", LINEAGE, "2", "nil"], `${label} lost the lineage between the instance and the Lua hold`);
			const standalone = await transportFor({ ...transfer, _transferId: "restore:x", _standaloneImport: true }, sectioned);
			const refused = luaCarry(binary, standalone);
			assert.equal(refused.holdLineage, "nil", `${label} standalone import adopted the payload lineage`);
		}
	}
});
