"use strict";

// Source-contract test for the per-entity census meter (Task 2, Phase 1).
// Follows the fs.readFileSync + structural-regex style of composite-transfer-verdict.test.cjs:
// plain `node --test`, zero dependencies, asserts the SHAPE of the Lua source so the
// per-entity extraction (and its independence from EntityHandlers) cannot silently regress.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const moduleRoot = path.join(__dirname, "..", "module");
const surfaceCounter = fs.readFileSync(
	path.join(moduleRoot, "validators", "surface-counter.lua"),
	"utf8",
);

function functionBody(source, header, nextHeader) {
	const start = source.indexOf(header);
	assert.notEqual(start, -1, `${header} must exist`);
	const end = source.indexOf(nextHeader, start + header.length);
	return source.slice(start, end === -1 ? source.length : end);
}

test("surface-counter defines the per-entity item and fluid census meters", () => {
	assert.match(surfaceCounter, /function\s+SurfaceCounter\.count_entity_items\s*\(\s*entity/,
		"count_entity_items(entity) must be the extracted per-entity item meter");
	assert.match(surfaceCounter, /function\s+SurfaceCounter\.count_entity_fluids\s*\(\s*entity/,
		"count_entity_fluids(entity, ...) must be the extracted per-entity fluid meter");
});

test("count_items is a fold over the per-entity item meter (one meter, not two)", () => {
	const body = functionBody(
		surfaceCounter,
		"function SurfaceCounter.count_items(surface)",
		"function SurfaceCounter.count_fluids",
	);
	assert.match(body, /SurfaceCounter\.count_entity_items\s*\(/,
		"count_items must delegate to count_entity_items so the surface census and the per-entity census share one meter");
});

test("count_fluids is a fold over the per-entity fluid meter", () => {
	const body = functionBody(
		surfaceCounter,
		"function SurfaceCounter.count_fluids(surface",
		"function SurfaceCounter.count_all",
	);
	assert.match(body, /SurfaceCounter\.count_entity_fluids\s*\(/,
		"count_fluids must delegate to count_entity_fluids so both censuses share one fluid meter");
});

test("surface-counter never references EntityHandlers (independence is structural)", () => {
	assert.doesNotMatch(surfaceCounter, /EntityHandlers/,
		"the census meter must stay independent of the export-side EntityHandlers dispatch");
});

// -----------------------------------------------------------------------------
// Task 3 (Phase 1): paired-reads census accumulator — source-contract assertions.
// Read lazily so a missing module fails ONLY these tests (clean RED), not the
// surface-counter tests above.
// -----------------------------------------------------------------------------
function accumulatorSource() {
	return fs.readFileSync(
		path.join(moduleRoot, "export_scanners", "census-accumulator.lua"),
		"utf8",
	);
}

test("census-accumulator defines new/record/verdict", () => {
	const src = accumulatorSource();
	assert.match(src, /function\s+CensusAccumulator\.new\s*\(/,
		"CensusAccumulator.new() must create the accumulator");
	assert.match(src, /function\s+CensusAccumulator\.record\s*\(\s*acc\s*,\s*entity\s*,\s*entity_data/,
		"record(acc, entity, entity_data, ...) must take the paired reads for one entity");
	assert.match(src, /function\s+CensusAccumulator\.verdict\s*\(\s*acc/,
		"verdict(acc) must produce the census verdict");
});

test("record performs the paired PHYSICAL read via the Task-2 SurfaceCounter meters (real wiring, not a stub)", () => {
	const body = functionBody(
		accumulatorSource(),
		"function CensusAccumulator.record(",
		"function CensusAccumulator.verdict",
	);
	assert.match(body, /SurfaceCounter\.count_entity_items\s*\(\s*entity/,
		"record must call SurfaceCounter.count_entity_items(entity) — the physical item read is the paired-read wiring");
	assert.match(body, /SurfaceCounter\.count_entity_fluids\s*\(\s*entity/,
		"record must call SurfaceCounter.count_entity_fluids(entity, ...) for the physical fluid read");
});

test("record's SERIALIZED side reuses Verification's counting rules (no re-implementation)", () => {
	const body = functionBody(
		accumulatorSource(),
		"function CensusAccumulator.record(",
		"function CensusAccumulator.verdict",
	);
	assert.match(body, /Verification\.count_all_items\s*\(/,
		"the serialized item count must reuse Verification.count_all_items");
	assert.match(body, /Verification\.count_all_fluids\s*\(/,
		"the serialized fluid count must reuse Verification.count_all_fluids");
});

test("mismatch rows carry unit_number and per-key expected/actual/delta (belt-attribution row shape)", () => {
	const src = accumulatorSource();
	assert.match(src, /unit_number\s*=\s*entity\.unit_number/,
		"rows must be entity-attributed by the stable unit_number");
	assert.match(src, /entity_id\s*=/, "rows must carry the serialized entity_id");
	assert.match(src, /position\s*=\s*\{\s*x\s*=\s*entity\.position\.x/,
		"rows must carry a COPIED position (scalars only — storage-safe, never the position userdata)");
	assert.match(src, /\bexpected\s*=/, "rows must carry per-key expected");
	assert.match(src, /\bactual\s*=/, "rows must carry per-key actual");
	assert.match(src, /\bdelta\s*=/, "rows must carry per-key delta");
});

test("verdict compares items EXACTLY and fluids within the 1e-6 epsilon constant", () => {
	const src = accumulatorSource();
	assert.match(src, /(?:EXACT_EPSILON|epsilon)\s*=\s*1e-6/,
		"the fluid comparison must use the 1e-6 epsilon constant (mirrors the transfer gate)");
	assert.match(src, /math\.abs\([^)]*\)\s*>\s*EXACT_EPSILON/,
		"fluid names compare with |delta| > EXACT_EPSILON");
});

test("accumulator aggregates temp-keyed fluids to per-name totals for the verdict (mirrors the gate)", () => {
	const src = accumulatorSource();
	assert.match(src, /Util\.parse_fluid_temp_key\s*\(/,
		"fluids must be re-aggregated temp-key → name via Util.parse_fluid_temp_key, as the gate does");
});

// -----------------------------------------------------------------------------
// Task 4 (Phase 2): wire the paired reads into the export walk — source-contract
// assertions over export-pipeline.lua / configure.lua / lint-test-hooks.mjs.
// -----------------------------------------------------------------------------
function exportPipelineSource() {
	return fs.readFileSync(path.join(moduleRoot, "core", "export-pipeline.lua"), "utf8");
}
function configureSource() {
	return fs.readFileSync(path.join(moduleRoot, "interfaces", "remote", "configure.lua"), "utf8");
}

test("queue() attaches a fresh storage-safe census accumulator to the job", () => {
	const body = functionBody(
		exportPipelineSource(),
		"function ExportPipeline.queue(",
		"function ExportPipeline.process_batch(",
	);
	assert.match(body, /census\s*=\s*CensusAccumulator\.new\s*\(/,
		"queue() must attach CensusAccumulator.new() to the job (lives in storage.async_jobs across the walk)");
});

test("process_batch records paired reads in the SAME loop as serialize_entity, belts excluded", () => {
	const body = functionBody(
		exportPipelineSource(),
		"function ExportPipeline.process_batch(",
		"function ExportPipeline.complete(",
	);
	assert.match(body, /EntityScanner\.serialize_entity\s*\(\s*entity\s*\)/,
		"process_batch must serialize each entity");
	assert.match(body, /CensusAccumulator\.record\s*\(\s*job\.census\s*,\s*entity\s*,\s*entity_data/,
		"process_batch must record the paired reads for the just-serialized entity, in the same loop iteration");
	// The record must be the ELSE of the belt-deferral branch — belt-type entities are NOT recorded
	// during the async walk (their items aren't serialized until the atomic pass in complete()).
	assert.match(body, /BELT_ENTITY_TYPES\[category\][\s\S]*?\belse\b[\s\S]*?CensusAccumulator\.record\s*\(\s*job\.census/,
		"belt entities must be deferred (paired in the atomic pass); only NON-belt entities are recorded in the walk");
});

test("the atomic belt scan pairs each belt AFTER its serialized items are patched (same tick)", () => {
	const body = functionBody(
		exportPipelineSource(),
		"function ExportPipeline.complete(",
		"function ExportPipeline.abort_transfer_on_census_mismatch(",
	);
	assert.match(
		body,
		/entity_data\.specific_data\.items\s*=\s*belt_items[\s\S]*?CensusAccumulator\.record\s*\(\s*job\.census\s*,\s*live_entity\s*,\s*entity_data/,
		"the atomic belt scan must record each belt's paired reads AFTER patching its serialized items (single-tick execution)",
	);
});

test("census verdict is computed BEFORE the export is stored/sent, and the transfer abort references it", () => {
	const src = exportPipelineSource();
	const verdictIdx = src.indexOf("CensusAccumulator.verdict(job.census)");
	const storeIdx = src.indexOf("storage.platform_exports[export_id] =");
	assert.notEqual(verdictIdx, -1, "complete() must compute CensusAccumulator.verdict(job.census)");
	assert.notEqual(storeIdx, -1, "complete() must store the export somewhere");
	assert.ok(verdictIdx < storeIdx,
		"the census verdict must be computed BEFORE the export is stored/compressed/sent");
	assert.match(src, /if\s+not\s+job\.census_verdict\.ok\s+then/,
		"a failed verdict must gate the abort path");
	assert.match(src, /job\.destination_instance_id[\s\S]*?abort_transfer_on_census_mismatch/,
		"only TRANSFER exports (destination_instance_id set) abort on a failed verdict");
});

test("the census mismatch bundle is always-on (NOT debug-gated) and the abort preserves the source", () => {
	const body = functionBody(
		exportPipelineSource(),
		"function ExportPipeline.abort_transfer_on_census_mismatch(",
		"return ExportPipeline",
	);
	assert.match(body, /DebugExport\.write_failure_black_box\s*\(/,
		"the mismatch bundle must use write_failure_black_box (always-on, bypasses debug_mode)");
	assert.doesNotMatch(body, /DebugExport\.is_enabled|debug_mode/,
		"the census mismatch bundle must NOT be gated on debug_mode / is_enabled");
	assert.match(body, /SurfaceLock\.unlock_platform\s*\(\s*job\.platform_index/,
		"the abort must unlock (preserve) the source platform");
});

test("ground items are intentionally NOT census-paired (documented deviation from task item 4)", () => {
	const body = functionBody(
		exportPipelineSource(),
		"function ExportPipeline.complete(",
		"function ExportPipeline.abort_transfer_on_census_mismatch(",
	);
	assert.match(body, /table\.insert\(job\.export_data\.entities, ground_item\)/,
		"the ground-item scan must still append ground items to the payload");
	assert.doesNotMatch(body, /CensusAccumulator\.record\s*\(\s*job\.census\s*,\s*(?:live_ground|ground_live|ground_item|ground_entity)/,
		"ground items must NOT be census-paired: count_entity_items has no item-entity branch → phys=0/ser=N spurious abort");
});

test("test_force_census_omission is registered in the configure allowlist and consumed by the walk", () => {
	assert.match(configureSource(), /config\.test_force_census_omission\s*~=\s*nil/,
		"unregistered configure keys are silently dropped — the one-shot hook must be in the allowlist");
	assert.match(configureSource(), /storage\.surface_export_config\.test_force_census_omission\s*=/,
		"the hook value must be persisted into surface_export_config");
	assert.match(exportPipelineSource(), /test_force_census_omission/,
		"the export walk must consume the one-shot census-omission hook at the post-serialization point");
});

test("the census-omission hook is enumerated in lint:test-hooks FAIL_SAFE_HOOKS", () => {
	const lint = fs.readFileSync(path.join(moduleRoot, "..", "scripts", "lint-test-hooks.mjs"), "utf8");
	assert.match(lint, /FAIL_SAFE_HOOKS[\s\S]*?"test_force_census_omission"/,
		"the pre-verdict hook must be whitelisted as fail-safe (leak ⇒ next export aborts + source preserved)");
});

test("the census physical read excludes the SAME engine-owned segments the serializer excludes (shared-segment fusion case)", () => {
	// Measured live 2026-07-17 (2.0.77, workhorse platform): fusion-reactor plasma OUTPUT boxes expose
	// real segment IDs shared with fusion-generator inputs (which read seg=nil — refining Pitfall #22,
	// activatable entities expose no own segment ID). The
	// serializer drops those segments via the job's engine_owned_segments pre-pass, but a census fluid
	// state seeded with an EMPTY engine_owned_segments set counts them physically → phantom
	// fusion-plasma delta → every transfer of a fusion platform aborts. The two reads must share ONE
	// ownership source of truth: queue() hands the job's pre-passed set to CensusAccumulator.new().
	const newBody = functionBody(
		accumulatorSource(),
		"function CensusAccumulator.new(",
		"function CensusAccumulator.record(",
	);
	assert.match(newBody, /new_fluid_state\s*\(\s*engine_owned_segments\s*\)/,
		"new() must THREAD the set into new_fluid_state (an empty/unthreaded set silently disables the segment-path exclusion)");
	assert.match(newBody, /if not engine_owned_segments then\s*\n\s*error\(/,
		"new() must fail LOUD on a nil set — Lua's silent-nil default would quietly resurrect the trap for a future caller");
	const queueBody = functionBody(
		exportPipelineSource(),
		"function ExportPipeline.queue(",
		"function ExportPipeline.process_batch(",
	);
	assert.match(queueBody, /CensusAccumulator\.new\s*\(\s*engine_owned_segments\s*\)/,
		"queue() must pass its pre-passed engine_owned_segments — the serializer's OWN exclusion set — into the census");
});
