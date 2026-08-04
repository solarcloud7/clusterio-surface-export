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

/**
 * Source pins must not match their own explanatory comments. Commenting out a call site left the
 * "does this file call prune?" assertion GREEN, because the surrounding comment names the function
 * it describes — verified by mutation, and the reason this helper exists rather than matching raw
 * source.
 *
 * Deliberately naive: it strips from the first `--` on each line, so it also truncates at a `--`
 * that appears INSIDE a Lua string literal, and it does not handle long-bracket comments. No module
 * pinned here contains either. For assert.match that only risks a false failure; the two
 * assert.doesNotMatch pins below would be the ones to re-check if a pinned module ever grows a
 * string containing `--`.
 */
function code(rel) {
	return readModule(rel).split("\n").map(line => line.replace(/--.*$/, "")).join("\n");
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
	const exportPipeline = code(path.join("core", "export-pipeline.lua"));
	const serializer = code(path.join("core", "serializer.lua"));

	assert.match(exportPipeline, /ExportCache\.prune_to_configured_cap\s*\(\s*\)/,
		"the async/production export path must prune after storing its entry");
	assert.match(serializer, /ExportCache\.prune_to_configured_cap\s*\(\s*\)/,
		"the synchronous/clone export path must prune too — it writes an entry nothing ever reads");
});

test("every write site goes through record(), so the ordering stamp cannot be forgotten", () => {
	const exportPipeline = code(path.join("core", "export-pipeline.lua"));
	const serializer = code(path.join("core", "serializer.lua"));

	// A bare `storage.platform_exports[id] = {...}` stores an entry with no cache_seq. It would then
	// sort as legacy/oldest and be the first thing deleted — at the moment it was written.
	assert.doesNotMatch(exportPipeline, /storage\.platform_exports\s*\[[^\]]+\]\s*=/,
		"export-pipeline must not assign into storage.platform_exports directly — use ExportCache.record");
	assert.doesNotMatch(serializer, /storage\.platform_exports\s*\[[^\]]+\]\s*=/,
		"serializer must not assign into storage.platform_exports directly — use ExportCache.record");
	assert.match(exportPipeline, /ExportCache\.record\s*\(/, "export-pipeline must store via record()");
	assert.match(serializer, /ExportCache\.record\s*\(/, "serializer must store via record()");
});

test("ordering is by insertion, never by the queue-time tick", () => {
	const clearOld = code(path.join("interfaces", "remote", "clear-old-exports.lua"));
	const exportCache = code(path.join("utils", "export-cache.lua"));

	// tick is stamped when an export is QUEUED (export-pipeline builds export_data in `queue`), so a
	// platform that scans for many ticks completes carrying the OLDEST tick in the table. Sorting by
	// it means the largest export is deleted by the prune its own completion triggers.
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

	// This is the real protection. The count-based floor is only a sanity clamp — see the retraction
	// in export-cache.lua: max_concurrent_jobs is a per-tick limiter, not an admission cap, so it
	// bounds nothing about how many exports can be in flight.
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

	// The original defect was a knob read, validated, then never enforced. Without this pin the same
	// break reappears one hop later: configure.lua calls set_max_export_cache_size, which forwards to
	// nothing.
	assert.match(asyncProcessor,
		/function\s+AsyncProcessor\.set_max_export_cache_size\s*\(\s*value\s*\)\s*\n\s*ExportCache\.set_cap\s*\(\s*value\s*\)/,
		"set_max_export_cache_size must forward to ExportCache.set_cap");

	// Persisted, unlike the other configure() values: this one governs DELETION. A cap that silently
	// reverts from an operator's 100 to the default 10 on save load deletes 90 exports on the next
	// completion, and the configure() push that would restore it is swallowed into a warn.
	assert.match(exportCache, /function\s+ExportCache\.set_cap[\s\S]*?storage\.surface_export_config\.max_export_cache_size\s*=\s*value/,
		"the cap must be written to storage, not held only in a module local");
	assert.match(exportCache, /function\s+ExportCache\.get_cap[\s\S]*?storage\.surface_export_config\s+and\s+storage\.surface_export_config\.max_export_cache_size/,
		"the cap must be read back from storage");
});

test("the sanity floor is applied, and is not described as a survival guarantee", () => {
	const exportCache = code(path.join("utils", "export-cache.lua"));
	const asyncProcessor = code(path.join("core", "async-processor.lua"));
	const exportCacheWithComments = readModule(path.join("utils", "export-cache.lua"));

	assert.match(exportCache, /floor\s*=\s*floor\s*\+\s*1/, "the floor is max_concurrent_jobs + 1");
	assert.match(exportCache, /if\s+configured\s*<\s*floor\s+then[\s\S]*?return\s+floor,\s*true/,
		"a configured cap below the floor must be RAISED and reported as raised — Node validates " +
		"only >= 1, which is too permissive to be useful on its own");

	// The floor reads a MIRROR of max_concurrent_jobs, so it must update at the single mutation
	// point. Losing this line fails no Lua assertion; the cache would floor against a stale value.
	assert.match(asyncProcessor,
		/function\s+AsyncProcessor\.set_max_concurrent_jobs\s*\(\s*value\s*\)[\s\S]*?ExportCache\.set_concurrency\s*\(\s*value\s*\)[\s\S]*?\nend/,
		"set_max_concurrent_jobs must mirror into ExportCache in the same call");
	assert.match(asyncProcessor, /ExportCache\.set_concurrency\s*\(\s*config\.max_concurrent_jobs\s*\)/,
		"the mirror must also be seeded from the default at load, so there is no second literal");

	// The retraction, pinned. An earlier version of this PR justified the floor by claiming
	// max_concurrent_jobs bounds how many exports can be in flight — false: ExportPipeline.queue has
	// no admission control at all, and the setting is a per-tick throughput limiter whose own comment
	// says "remaining jobs wait until next tick". The claim survived offline tests and a live probe;
	// only reading the emitter killed it. Keep the correction where the next reader will hit it.
	assert.match(exportCacheWithComments, /per-tick|PER-TICK/,
		"the floor's comment must describe max_concurrent_jobs as the per-tick limiter it is");
	assert.doesNotMatch(exportCacheWithComments, /bounds how many exports can be in flight at once/,
		"the retracted claim must not reappear");
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
