// we-set.test — the committed WE-SET still describes the module source it was read from
//
// requires: we-set.json committed beside derive-we-set.mjs, and the module Lua it was read from
// produces: re-extraction against live module source (so a source edit that changes the WE-SET
//           fails here rather than drifting), floors, known-member controls, and mutation-kill
//           evidence that a desynced lexer is caught
// does not: contact the cluster or claim any WE-SET property survives a transfer

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	COMMON_CATEGORY, assemble, checkControls, extractDirectWrites, extractHandlerCaptures,
	extractRestoreRules, matchedBlock,
} from "./derive-we-set.mjs";
import { loadWeSet, weSetRow, writesProperty, capturesFor } from "./we-set.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(here, "..", "..", "..",
	"docker", "seed-data", "external_plugins", "surface_export", "module");
const deserializerSource = readFileSync(path.join(MODULE_ROOT, "core", "deserializer.lua"), "utf8");
const handlerSource = readFileSync(path.join(MODULE_ROOT, "export_scanners", "entity-handlers.lua"), "utf8");
const phaseFiles = readdirSync(path.join(MODULE_ROOT, "import_phases")).filter(n => n.endsWith(".lua"))
	.map(name => ({
		rel: `import_phases/${name}`,
		source: readFileSync(path.join(MODULE_ROOT, "import_phases", name), "utf8"),
	}));

const artifact = loadWeSet();

test("the committed artifact still matches what the module source says today", () => {
	const fresh = assemble({ deserializerSource, handlerSource, phaseFiles });
	assert.deepEqual(fresh.counts, artifact.counts,
		"module source moved without regenerating we-set.json — run derive-we-set.mjs");
	assert.deepEqual(fresh.we_set, artifact.we_set);
	assert.deepEqual(fresh.restore_rules, artifact.restore_rules);
	assert.deepEqual(fresh.handler_captures, artifact.handler_captures);
	assert.deepEqual(fresh.direct_writes, artifact.direct_writes);
});

test("the extraction is non-vacuous and passes its own controls", () => {
	assert.deepEqual(checkControls(artifact), []);
	assert.ok(artifact.counts.restore_rules >= 20);
	assert.ok(artifact.counts.types_gated_rules >= 10);
	assert.ok(artifact.counts.handler_categories >= 25);
	assert.ok(artifact.counts.handler_fields >= 80);
	assert.ok(artifact.counts.direct_writes >= 20);
	assert.ok(artifact.counts.we_set >= 50);
});

test("a restore rule's prop overrides its payload field name", () => {
	const rules = new Map(artifact.restore_rules.map(rule => [rule.field, rule]));
	assert.equal(rules.get("switch_state").property, "power_switch_state");
	assert.equal(rules.get("input_priority").property, "splitter_input_priority");
	assert.equal(rules.get("link_id").property, "link_id");
	assert.deepEqual(rules.get("link_id").types, ["linked-container"]);
	assert.equal(rules.get("link_id").safecall, true);
});

test("link_id is in the WE-SET, gated to linked-container", () => {
	const row = weSetRow("link_id");
	assert.notEqual(row, null, "the pipeline writes link_id (deserializer.lua:103) — the WE-SET must say so");
	assert.deepEqual(row.types, ["linked-container"]);
	assert.equal(writesProperty("link_id", "linked-container"), true);
	assert.equal(writesProperty("link_id", "container"), false);
	assert.equal(writesProperty("zzz_not_written_zzz", "container"), false);
});

test("an ungated restore rule applies to every type", () => {
	assert.equal(weSetRow("color").types, null);
	assert.equal(writesProperty("color", "container"), true);
	assert.equal(writesProperty("color", "locomotive"), true);
});

test("direct entity writes join the WE-SET even with no restore rule", () => {
	for (const property of ["last_user", "health", "orientation", "tick_grown"]) {
		const row = weSetRow(property);
		assert.notEqual(row, null, `${property} is written directly in deserializer.lua`);
		assert.ok(row.origins.includes("direct_write"), property);
	}
	assert.ok(weSetRow("color").origins.includes("restore_rule"));
	assert.ok(weSetRow("color").origins.includes("direct_write"));
});

test("handler captures cover the aliased category and the common-state block", () => {
	assert.deepEqual(capturesFor("loader-1x1"), capturesFor("loader"),
		"loader-1x1 is an alias assignment, not a function body — an unresolved alias captures nothing");
	assert.ok(capturesFor("loader").length > 0);
	assert.ok(capturesFor(COMMON_CATEGORY).includes("burner"));
	assert.ok(capturesFor("assembling-machine").includes("recipe"));
	assert.ok(capturesFor("inserter").includes("held_item"));
	assert.equal(capturesFor("not-a-category"), null);
});

test("MUTATION KILL: a desynced restore-rule lexer is caught by the floor, not by silence", () => {
	const truncated = deserializerSource.replace(
		/{ field = "rocket_parts" },/,
		"{ field = \"rocket_parts\" },\n}\nlocal DEAD = {\n");
	const rules = extractRestoreRules(truncated);
	assert.ok(rules.length < artifact.restore_rules.length,
		"the mutation must actually shorten the extraction, or this test proves nothing");
	const broken = { ...artifact, restore_rules: rules, counts: { ...artifact.counts, restore_rules: rules.length } };
	const failures = checkControls(broken);
	assert.ok(failures.length > 0, `a short extraction must be caught, got: ${JSON.stringify(failures)}`);
});

test("MUTATION KILL: losing the handler alias turns the alias control red", () => {
	const broken = JSON.parse(JSON.stringify(artifact));
	broken.handler_captures = broken.handler_captures.filter(row => row.category !== "loader-1x1");
	assert.ok(checkControls(broken).some(f => f.includes("loader-1x1 = loader alias did not resolve")));
});

test("MUTATION KILL: dropping a known restore rule turns its control red", () => {
	const broken = JSON.parse(JSON.stringify(artifact));
	broken.restore_rules = broken.restore_rules.filter(rule => rule.field !== "link_id");
	assert.ok(checkControls(broken).some(f => f.includes('restore rule "link_id" went missing')));
});

test("MUTATION KILL: dropping a known direct write turns its control red", () => {
	const broken = JSON.parse(JSON.stringify(artifact));
	broken.direct_writes = broken.direct_writes.filter(row => row.property !== "last_user");
	assert.ok(checkControls(broken).some(f => f.includes('direct write "last_user" went missing')));
});

test("unbalanced Lua braces desync loudly rather than returning a short read", () => {
	assert.throws(() => matchedBlock("{ a = 1, b = { c = 2 }", 0), /unbalanced braces/);
	assert.equal(matchedBlock("{ a = 1, b = { c = 2 } } tail", 0), "{ a = 1, b = { c = 2 } }");
});

test("a restore rule row with no field name is refused, not skipped", () => {
	const source = 'local SIMPLE_RESTORE_RULES = {\n  { safecall = true },\n}\n';
	assert.throws(() => extractRestoreRules(source), /carries no field/);
});

test("an empty types gate is refused — it would read as gated-to-nothing", () => {
	const source = 'local SIMPLE_RESTORE_RULES = {\n  { field = "x", types = { } },\n}\n';
	assert.throws(() => extractRestoreRules(source), /empty types gate/);
});

test("a handler alias pointing at nothing is refused", () => {
	const source = 'EntityHandlers["a"] = EntityHandlers["missing"]\n';
	assert.throws(() => extractHandlerCaptures(source), /points at missing, which has no block/);
});

test("direct-write extraction ignores comparisons and unrelated identifiers", () => {
	const rows = extractDirectWrites([{
		rel: "synthetic.lua",
		source: [
			"entity.health = 10",
			"if entity.health == 10 then end",
			"entity_data.specific_data = {}",
			"local other = entity.color",
		].join("\n"),
	}]);
	assert.deepEqual(rows.map(row => row.property), ["health"]);
});
