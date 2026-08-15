"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const moduleRoot = path.join(__dirname, "..", "module");
const read = (...parts) => fs.readFileSync(path.join(moduleRoot, ...parts), "utf8");

test("belt item state is captured against a MEASURED fresh default, not an assumed one", () => {
	const scanner = read("export_scanners", "inventory-scanner.lua");
	assert.match(scanner, /function InventoryScanner\.new_item_state_cache\(\)[\s\S]{0,200}?game\.create_inventory\(1\)/,
		"the fresh-default reference needs a scratch inventory to build a pristine stack in");
	assert.match(scanner, /function InventoryScanner\.release_item_state_cache\(cache\)[\s\S]{0,200}?cache\.inventory\.destroy\(\)/,
		"the scratch inventory must be destroyed — a leaked script inventory outlives the export");
	assert.match(scanner, /local function default_properties\(cache, name, quality\)[\s\S]{0,600}?slot\.set_stack\(\{ name = name, quality = quality, count = 1 \}\)/,
		"the default must come from a fresh stack of the SAME name and quality");
	assert.match(scanner, /function InventoryScanner\.capture_item_state\(stack, cache\)[\s\S]{0,600}?not values_equal\(value, defaults and defaults\[key\]\)/,
		"a field is carried only when it differs from that measured default; health reads 1 and spoil_percent "
		+ "reads 0 on every plain stack, and both are truthy in Lua, so an emit-if-present rule would attach a "
		+ "state record to every item on every belt");
	assert.match(scanner, /local IDENTITY_FIELDS = \{ name = true, count = true, quality = true \}/,
		"name/count/quality are the census dimensions and already ride in the slot — they must never enter the "
		+ "state record, whose writes must not be able to move a count");
	assert.match(scanner, /InventoryScanner\.extract_item_properties = extract_item_properties/,
		"belt capture must reuse the inventory path's serializer, not a second hand-copied field list");
});

test("belt slots carry item state sparsely, and every captured field has a belt restore path", () => {
	const restoration = read("import_phases", "belt_restoration.lua");
	assert.doesNotMatch(restoration, /STATE_FIELDS_WITHOUT_BELT_RESTORE/,
		"export_string is the field this exclusion existed for and it now has a preflighted restore path; an "
		+ "empty exclusion set that still strips is a mechanism nothing can reach");
	assert.match(restoration, /local function belt_item_state\(stack, cache\)[\s\S]{0,600}?\n    return state\nend/,
		"capture returns the shared serializer's sparse record whole — a second field list here is how a "
		+ "captured field goes silently unshipped");
	assert.match(restoration, /st = belt_item_state\(it\.stack, cache\)/,
		"the slot's state field must come from the shared capture, so a plain stack keeps the compact form");
	assert.match(restoration, /Util\.pcall_warn\("\[BeltRestoration\] item-state cache release"[\s\S]{0,200}?InventoryScanner\.release_item_state_cache\(cache\)[\s\S]{0,200}?if not ok then error\(result, 0\) end/,
		"capture_side_groups owns the scratch inventory's lifetime, including when the scan throws: the release "
		+ "runs BEFORE the re-raise, and is itself guarded and logged — an unguarded throw out of destroy() would "
		+ "escape to export-pipeline's pcall, leave belt_side_groups nil, and make the import REFUSE a "
		+ "belt-bearing payload, the same outcome the cache-create guard exists to prevent");
});

test("a failure in the state machinery degrades to stateless capture, never to a refused platform", () => {
	const restoration = read("import_phases", "belt_restoration.lua");
	assert.match(restoration, /local cache_ok, cache = pcall\(InventoryScanner\.new_item_state_cache\)[\s\S]{0,400}?cache = nil/,
		"a throw here would reach export-pipeline's pcall, leave belt_side_groups nil, and make the import "
		+ "REFUSE a belt-bearing payload outright — the state feature must never cost a platform its transfer");
	assert.match(restoration, /local function belt_item_state\(stack, cache\)\s*\n\s*if not cache then return nil end/,
		"a missing cache means stateless capture, which is exactly today's behaviour");
	assert.match(restoration, /local capture_ok, state = pcall\(InventoryScanner\.capture_item_state, stack, cache\)[\s\S]{0,400}?ships stateless/,
		"one unreadable stack must cost that stack its state, not the whole scan");
});

test("the belt-side state write is guarded on the on_tick import path", () => {
	const restoration = read("import_phases", "belt_restoration.lua");
	assert.match(restoration, /pcall\(Deserializer\.restore_item_properties, landed_stack, scalars\)/,
		"the state write must be pcall-wrapped: belt restore runs on the on_tick import path and the "
		+ "upload-import ingress accepts arbitrary JSON, so an st field naming a property this item does not "
		+ "have (durability on an iron plate) would otherwise throw and stop the instance");
	assert.match(restoration, /refused = true[\s\S]{0,300}?STATE WRITE FAILED/,
		"a refused write must be counted and named, never swallowed");
	assert.match(restoration, /if refused then\s*\n\s*state_stats\.failed = state_stats\.failed \+ 1\s*\n\s*elseif wrote then\s*\n\s*state_stats\.applied = state_stats\.applied \+ 1/,
		"one stack is one tally: a stack whose export_string and scalars are both written counts once, and a "
		+ "stack where either write threw counts as failed rather than applied");
	assert.match(restoration, /if arrivals ~= 1 or not readable or landed_stack\.count ~= count then/,
		"the landed stack is identified by unique_id difference across the write; anything but exactly one "
		+ "arrival is ambiguous, and an arrival whose count is not the count just written is a stack the "
		+ "insert coalesced into — both must decline rather than write state onto a guessed or shared stack");
	assert.match(restoration, /local before_ids = st and line_ids\(line\) or nil/,
		"the id snapshot must be skipped for stateless slots — belt items are the payload bulk");
});

test("a payload without per-stack state stays importable, and a malformed one is refused", () => {
	const restoration = read("import_phases", "belt_restoration.lua");
	assert.match(restoration, /or \(slot\.st ~= nil and type\(slot\.st\) ~= "table"\)/,
		"slot.st is OPTIONAL (older payloads carry none) but type-gated when present");
	const compat = read("utils", "version-compat.lua");
	assert.match(compat, /VersionCompat\.PAYLOAD_SCHEMA_VERSION = "2\.0\.0"/,
		"per-stack belt state is an additive optional field: bumping the schema constant would refuse every "
		+ "payload in flight, which is the opposite of backward compatibility");
});

test("export_string reaches the live belt stack only after a scratch stack proved identity survives", () => {
	const restoration = read("import_phases", "belt_restoration.lua");
	assert.match(restoration, /function BeltRestoration\.export_string_keeps_identity\(scratch, name, quality, count, export_string\)/,
		"the preflight is a named module member so a test can drive it with a real cross-type string");
	assert.match(restoration, /slot\.set_stack\(\{ name = name, quality = wanted_quality, count = count \}\)[\s\S]{0,400}?slot\.import_stack\(export_string\)/,
		"the dry run must happen on a scratch stack of the SAME name, quality and count — that is what makes it "
		+ "an oracle for the write about to hit the belt");
	assert.match(restoration, /keeps = slot\.name == name and seen_quality == wanted_quality and slot\.count == count/,
		"the verdict is a MEASURED identity comparison; import_stack returns 0 for a type change and 1 for an "
		+ "unparseable string, so its return code cannot gate this");
	assert.match(restoration, /if keeps then[\s\S]{0,300}?pcall\(function\(\) return landed_stack\.import_stack\(st\.export_string\) end\)/,
		"the live write is reachable only from the true branch of the preflight");
	assert.match(restoration, /else\s*\n\s*state_stats\.declined = state_stats\.declined \+ 1[\s\S]{0,600}?STATE DECLINED export_string/,
		"a failed preflight must count and name the decline, never fall through to the write");
	assert.match(restoration, /if not \(scratch and scratch\.inventory and scratch\.inventory\.valid\) then\s*\n\s*return false, "no scratch inventory"/,
		"a missing scratch inventory declines — an absent oracle must never be read as a pass");
	assert.match(restoration, /local function needs_scratch\(side_groups\)[\s\S]{0,300}?slot\.st and slot\.st\.export_string/,
		"the scratch inventory is created only when a payload actually carries an export_string");
	assert.match(restoration, /Util\.pcall_warn\("\[BeltRestoration\] item-state scratch release"[\s\S]{0,200}?release_item_state_cache\(scratch\)[\s\S]{0,120}?if not ok then error\(placed, 0\) end/,
		"restore owns the scratch inventory's lifetime the way capture does: release BEFORE the re-raise, and "
		+ "the release itself guarded");
});

test("the declined counter reaches the log line and the import-complete metrics", () => {
	const restoration = read("import_phases", "belt_restoration.lua");
	assert.match(restoration, /local state_stats = \{ applied = 0, unmatched = 0, failed = 0, merge_discarded = 0, declined = 0 \}/,
		"declined joins the run-bound counter family, not a private variable");
	assert.match(restoration, /ITEM STATE %s: applied %d \| unmatched %d \| failed %d \| merge-discarded %d "\s*\n\s*\.\. "\| declined %d/,
		"declined is APPENDED to the ITEM STATE line: readers key off the existing four fields by position");
	assert.match(restoration, /state_stats\.merge_discarded\s*\n\s*\+ state_stats\.declined > 0 then/,
		"a run whose only item-state event is a decline must still emit the line — the emit condition is the "
		+ "only reason the line exists");
	const completion = read("core", "import-completion.lua");
	assert.match(completion, /job\.metrics\.belt_state_declined = r_state\.declined/,
		"the restore's declined count must reach job.metrics");
	assert.match(completion, /belt_state_declined = job\.metrics\.belt_state_declined or 0,/,
		"and the import-complete event's metrics whitelist, or nothing off-instance can see a decline");
});

test("the over-compression merge declares which of two merged states survives", () => {
	const restoration = read("import_phases", "belt_restoration.lua");
	assert.match(restoration, /partner\.slot = \{ n = slot\.n, q = slot\.q, ct = merged_ct, src = partner\.slot\.src, st = merged_st \}/,
		"the rebuilt ledger slot must carry the partner's state forward — a fresh four-key table silently drops it");
	assert.match(restoration, /landed_k = scan_place\(merged_ct, merged_st\)/,
		"the merge removes the partner and re-places it, so the state must be re-applied to the merged stack");
	assert.match(restoration, /state_stats\.merge_discarded = state_stats\.merge_discarded \+ 1[\s\S]{0,300}?MERGE DISCARDED/,
		"one physical stack carries one state: the incoming slot's state is lost by construction and must be "
		+ "counted and logged, not dropped in silence");
});
