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

test("belt slots carry item state sparsely, and only fields the belt restore can write", () => {
	const restoration = read("import_phases", "belt_restoration.lua");
	assert.match(restoration, /BeltRestoration\.STATE_FIELDS_WITHOUT_BELT_RESTORE = \{ export_string = true \}/,
		"export_string has no belt restore path (import_stack replaces the whole stack and can change the item "
		+ "name, which the census forbids) — carrying it would be payload weight that restores nothing");
	assert.match(restoration, /local function belt_item_state\(stack, cache\)[\s\S]{0,900}?STATE_FIELDS_WITHOUT_BELT_RESTORE\[key\]/,
		"the excluded fields must be stripped from every captured belt slot");
	assert.match(restoration, /st = belt_item_state\(it\.stack, cache\)/,
		"the slot's state field must come from the shared capture, so a plain stack keeps the compact form");
	assert.match(restoration, /InventoryScanner\.release_item_state_cache\(cache\)/,
		"capture_side_groups owns the scratch inventory's lifetime, including when the scan throws");
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
	assert.match(restoration, /pcall\(Deserializer\.restore_item_properties, landed_stack, st\)/,
		"the state write must be pcall-wrapped: belt restore runs on the on_tick import path and the "
		+ "upload-import ingress accepts arbitrary JSON, so an st field naming a property this item does not "
		+ "have (durability on an iron plate) would otherwise throw and stop the instance");
	assert.match(restoration, /state_stats\.failed = state_stats\.failed \+ 1[\s\S]{0,300}?STATE WRITE FAILED/,
		"a refused write must be counted and named, never swallowed");
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
