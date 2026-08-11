"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginDir = path.join(__dirname, "..");
const distNode = path.join(pluginDir, "dist", "node");
const { LuaInterface } = require(path.join(distNode, "lib", "lua-interface.js"));

function readModule(rel) {
	return fs.readFileSync(path.join(pluginDir, "module", rel), "utf8");
}

function code(rel) {
	return readModule(rel).split("\n").map(line => line.replace(/--.*$/, "")).join("\n");
}

function captureConfigureScript(cfg) {
	const sent = [];
	const host = { sendRcon: async (script) => { sent.push(script); return ""; } };
	const logger = { verbose: () => {} };
	const lua = new LuaInterface(host, logger);
	return lua.configure(cfg).then(() => {
		assert.equal(sent.length, 1, "configure must send exactly one RCON script");
		return sent[0];
	});
}

const BASE_CFG = {
	batchSize: 50,
	maxConcurrentJobs: 3,
	showProgress: true,
	debugMode: false,
	maxExportCacheSize: 7,
};

test("configure() carries max_export_cache_size into the Lua table it builds", async () => {
	const script = await captureConfigureScript(BASE_CFG);

	assert.match(script, /max_export_cache_size=7\b/,
		"the configure payload must carry the configured cap through to Lua — this string IS the " +
		"drop point; a field missing here disappears silently with no error on either side");

	assert.match(script, /batch_size=50\b/, "batch_size must survive the same edit");
	assert.match(script, /max_concurrent_jobs=3\b/, "max_concurrent_jobs must survive the same edit");
	assert.match(script, /show_progress=true\b/, "show_progress must survive the same edit");
	assert.match(script, /debug_mode=false\b/, "debug_mode must survive the same edit");
});

test("a distinct cap value produces a distinct payload (the emitter is not hard-coded)", async () => {
	const script = await captureConfigureScript({ ...BASE_CFG, maxExportCacheSize: 42 });
	assert.match(script, /max_export_cache_size=42\b/,
		"the emitted cap must track the configured value, not a literal");
});

test("the configure remote accepts the key (unregistered keys are dropped in silence)", () => {
	const configure = readModule(path.join("interfaces", "remote", "configure.lua"));
	assert.match(configure, /if\s+config\.max_export_cache_size\s+then/,
		"configure.lua must have a branch for the key — it silently ignores unregistered keys, so a " +
		"missing branch is a no-op feature with no error to find");
	assert.match(configure, /AsyncProcessor\.set_max_export_cache_size\s*\(\s*config\.max_export_cache_size\s*\)/,
		"the branch must apply the value it received");
});

test("the export write site prunes the cache, and the synchronous bypass stays deleted", () => {
	const exportPipeline = code(path.join("core", "export-pipeline.lua"));

	assert.match(exportPipeline, /ExportCache\.prune_to_configured_cap\s*\(\s*\)/,
		"the async/production export path must prune after storing its entry");
	assert.equal(fs.existsSync(path.join(pluginDir, "module", "core", "serializer.lua")), false,
		"core/serializer.lua was the synchronous export bypass — its payloads skipped the completion "
		+ "phase (no belt_side_groups, no force_data), which is how clones lost their belt items; "
		+ "a second export path must not come back");
});

test("every write site goes through record(), so the ordering stamp cannot be forgotten", () => {
	const exportPipeline = code(path.join("core", "export-pipeline.lua"));

	assert.doesNotMatch(exportPipeline, /storage\.platform_exports\s*\[[^\]]+\]\s*=/,
		"export-pipeline must not assign into storage.platform_exports directly — use ExportCache.record");
	assert.match(exportPipeline, /ExportCache\.record\s*\(/, "export-pipeline must store via record()");
});

test("ordering is by insertion, never by the queue-time tick", () => {
	const clearOld = code(path.join("interfaces", "remote", "clear-old-exports.lua"));
	const exportCache = code(path.join("utils", "export-cache.lua"));

	assert.match(exportCache, /cache_seq\s*=\s*storage\.platform_export_seq/,
		"record() must stamp a monotonic insertion sequence");
	assert.match(clearOld, /local\s+sa,\s*sb\s*=\s*a\.cache_seq,\s*b\.cache_seq/,
		"the comparator must order on cache_seq");
	assert.match(clearOld, /return\s+\(\s*a\.tick\s+or\s+0\s*\)\s*>\s*\(\s*b\.tick\s+or\s+0\s*\)/,
		"tick may remain only as the tiebreaker between two UNSTAMPED legacy entries, and must stay " +
		"nil-tolerant: this runs inside on_tick, where a bare `nil > number` kills the headless server");
});

test("an export still referenced by a platform lock is never pruned", () => {
	const exportCache = code(path.join("utils", "export-cache.lua"));
	const clearOld = code(path.join("interfaces", "remote", "clear-old-exports.lua"));

	assert.match(exportCache, /lock\.transfer_job_id/,
		"the protected set must be derived from live platform locks");
	assert.match(exportCache, /clear_old_exports\s*\(\s*keep_count\s*,\s*nil\s*,\s*protected_export_ids\s*\(\s*\)\s*\)/,
		"the production prune must pass the protected set — computing it and not passing it is the " +
		"same as not having it");
	assert.match(clearOld, /if\s+not\s+protected\s*\[\s*id\s*\]\s+then/,
		"the algorithm must skip protected ids when deleting");
});

test("the configured cap actually reaches the policy, and survives a save load", () => {
	const asyncProcessor = code(path.join("core", "async-processor.lua"));
	const exportCache = code(path.join("utils", "export-cache.lua"));

	assert.match(asyncProcessor,
		/function\s+AsyncProcessor\.set_max_export_cache_size\s*\(\s*value\s*\)\s*\n\s*ExportCache\.set_cap\s*\(\s*value\s*\)/,
		"set_max_export_cache_size must forward to ExportCache.set_cap");

	assert.match(exportCache, /function\s+ExportCache\.set_cap[\s\S]*?storage\.surface_export_config\.max_export_cache_size\s*=\s*value/,
		"the cap must be written to storage, not held only in a module local");
	assert.match(exportCache, /function\s+ExportCache\.get_cap[\s\S]*?storage\.surface_export_config\s+and\s+storage\.surface_export_config\.max_export_cache_size/,
		"the cap must be read back from storage");
});

test("the sanity floor is applied, and is not described as a survival guarantee", () => {
	const exportCache = code(path.join("utils", "export-cache.lua"));
	const asyncProcessor = code(path.join("core", "async-processor.lua"));

	assert.match(exportCache, /floor\s*=\s*floor\s*\+\s*1/, "the floor is max_concurrent_jobs + 1");
	assert.match(exportCache, /if\s+configured\s*<\s*floor\s+then[\s\S]*?return\s+floor,\s*true/,
		"a configured cap below the floor must be RAISED and reported as raised — Node validates " +
		"only >= 1, which is too permissive to be useful on its own");

	assert.match(asyncProcessor,
		/function\s+AsyncProcessor\.set_max_concurrent_jobs\s*\(\s*value\s*\)[\s\S]*?ExportCache\.set_concurrency\s*\(\s*value\s*\)[\s\S]*?\nend/,
		"set_max_concurrent_jobs must mirror into ExportCache in the same call");
	assert.match(asyncProcessor, /ExportCache\.set_concurrency\s*\(\s*config\.max_concurrent_jobs\s*\)/,
		"the mirror must also be seeded from the default at load, so there is no second literal");

});

test("export-cache never requires AsyncProcessor — Factorio forbids requires at runtime", () => {
	const exportCache = readModule(path.join("utils", "export-cache.lua"));

	assert.doesNotMatch(exportCache, /require\s*\(\s*"modules\/surface_export\/core\/async-processor"\s*\)/,
		"export-cache must NOT require async-processor: at module level it closes a require cycle, " +
		"and inside a function Factorio raises 'Require can't be used outside of control.lua parsing'");
	assert.match(exportCache, /function\s+ExportCache\.set_concurrency\s*\(/,
		"the inverted dependency needs a setter for AsyncProcessor to push its concurrency into");
});

test("the prune comparator tolerates a missing tick instead of raising in on_tick", () => {
	const clearOld = readModule(path.join("interfaces", "remote", "clear-old-exports.lua"));
	assert.match(clearOld, /\(\s*a\.tick\s+or\s+0\s*\)\s*>\s*\(\s*b\.tick\s+or\s+0\s*\)/,
		"the sort must coalesce a missing tick: this now runs from export completion inside on_tick, " +
		"where a bare `nil > number` is not a bad sort but a raw error, and a raw error in event " +
		"context kills the headless server (exit 255) presenting as a stall");
});

