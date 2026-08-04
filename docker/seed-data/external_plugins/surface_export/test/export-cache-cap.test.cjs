"use strict";
/**
 * The export cache is BOUNDED, and the knob that bounds it actually reaches Lua.
 *
 * The defect: `storage.platform_exports` gained one entry per completed export and nothing ever
 * removed one — `clear_old_exports` was the only pruner and no caller in the Node plugin had ever
 * invoked it. Meanwhile `surface_export.max_export_cache_size` was declared in index.ts and
 * validated in instance.ts, then discarded: it never entered the configure() payload, so the field
 * described a cap that did not exist. Saves grew by one compressed platform payload per export,
 * permanently.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. The pruning INVARIANT ("at most N survive, and they are the
 * N newest") is stated and measured in Lua, by module/interfaces/remote/export-cache-selftest.lua,
 * because it needs the engine to run. This file covers the half that is checkable offline and whose
 * failure mode is textual and silent:
 *
 *   1. configure() actually EMITS the key. This is the real drop point — the Lua table is built by
 *      hand as a string in lua-interface.ts with no generic conversion, so a field absent from that
 *      string vanishes with no error anywhere. Exercised against the compiled output, not regexed.
 *   2. Every other place in the four-place wiring chain is present, and the prune is called at BOTH
 *      write sites. These are Lua/source pins: they cannot execute here, so they are pinned by text.
 *   3. The self-test is listed in the instrument that runs it. A registered-but-uninvoked self-test
 *      is the exact rot this repo has hit twice; without this pin, deleting the list entry would
 *      silently retire the invariant check while every suite stayed green.
 *
 * Zero external deps: node:test + node:assert against the COMPILED output (dist/node), so run
 * `npm run build:node` first (the `npm test` script does).
 */

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

/** Captures the RCON script configure() emits, so we assert on the real payload. */
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

	// The value, not just the key: a wiring that emits the name but interpolates the wrong variable
	// (a copy-paste of batch_size, say) would satisfy a key-only assertion.
	assert.match(script, /max_export_cache_size=7\b/,
		"the configure payload must carry the configured cap through to Lua — this string IS the " +
		"drop point; a field missing here disappears silently with no error on either side");

	// Guard the sibling fields in the same payload: adding a key by editing this concatenation is
	// exactly how an adjacent one gets dropped, and nothing else would catch it.
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

test("both export write sites prune the cache", () => {
	const exportPipeline = readModule(path.join("core", "export-pipeline.lua"));
	const serializer = readModule(path.join("core", "serializer.lua"));

	assert.match(exportPipeline, /ExportCache\.prune_to_configured_cap\s*\(\s*\)/,
		"the async/production export path must prune after storing its entry");
	assert.match(serializer, /ExportCache\.prune_to_configured_cap\s*\(\s*\)/,
		"the synchronous/clone export path must prune too — it writes an entry nothing ever reads");
});

test("the cap is floored by concurrency, so an in-flight export cannot be evicted", () => {
	const exportCache = readModule(path.join("utils", "export-cache.lua"));
	const asyncProcessor = readModule(path.join("core", "async-processor.lua"));

	assert.match(exportCache, /floor\s*=\s*floor\s*\+\s*1/,
		"the floor must be max_concurrent_jobs + 1: at most max_concurrent_jobs exports can be " +
		"completed-but-unread, plus the one that triggered this prune");
	assert.match(exportCache, /if\s+configured\s*<\s*floor\s+then[\s\S]*?return\s+floor,\s*true/,
		"a configured cap below the floor must be RAISED and reported as raised — Node validates " +
		"only >= 1, which alone would let cap=1 evict a concurrent export mid-read");

	// The floor is derived from a MIRROR of max_concurrent_jobs, so the anti-drift guarantee is that
	// the mirror updates at the single mutation point. Losing this line does not fail any Lua
	// assertion — the cache would simply keep flooring against a stale concurrency forever.
	assert.match(asyncProcessor,
		/function\s+AsyncProcessor\.set_max_concurrent_jobs\s*\(\s*value\s*\)[\s\S]*?ExportCache\.set_concurrency\s*\(\s*value\s*\)[\s\S]*?\nend/,
		"set_max_concurrent_jobs must mirror into ExportCache in the same call — that is what keeps " +
		"the derived floor from drifting when an operator raises concurrency");
	assert.match(asyncProcessor, /ExportCache\.set_concurrency\s*\(\s*config\.max_concurrent_jobs\s*\)/,
		"the mirror must also be seeded from the default at load, so there is no second literal");
});

test("export-cache never requires AsyncProcessor — Factorio forbids requires at runtime", () => {
	const exportCache = readModule(path.join("utils", "export-cache.lua"));

	// MEASURED on 2.1.11, 2026-08-04: an earlier version of this module deferred the require into the
	// function bodies to dodge the async-processor -> export-pipeline -> export-cache cycle. Every
	// offline test passed; the live engine raised "Require can't be used outside of control.lua
	// parsing" from inside export completion. Both the cycle and the workaround are hazards, so the
	// dependency is inverted (AsyncProcessor pushes in) and this pin keeps it that way.
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

// NOTE: "is the self-test actually invoked?" is pinned at the REPO ROOT, in
// tests/instruments/selftests/registration.test.mjs, not here. This package is bind-mounted into
// the host container on its own (the repo root is not), so a cross-package path resolves to `/`
// and the check would fail for a reason that has nothing to do with the invariant. The root test
// also states the stronger form: EVERY registered self-test must be invoked, derived from the
// remote interface rather than pinning this one name.
