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
	extractReceiverWrites, extractRestoreRules, matchedBlock, topLevelKeys,
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
	assert.deepEqual(fresh.receiver_writes, artifact.receiver_writes);
});

const rebuild = (sources = {}) => assemble({
	deserializerSource: sources.deserializerSource ?? deserializerSource,
	handlerSource: sources.handlerSource ?? handlerSource,
	phaseFiles: sources.phaseFiles ?? phaseFiles,
});

test("the extraction is non-vacuous and passes its own controls", () => {
	assert.deepEqual(checkControls(artifact), []);
	assert.deepEqual(checkControls(rebuild()), [],
		"the controls must be run against a FRESH extraction too, not only against the committed artifact: "
		+ "a parser arm that stops reading a shape leaves the committed JSON untouched, so every control "
		+ "keyed on it stays green and the only red is a drift notice telling the next reader to "
		+ "regenerate — which is the one action that would bake the loss in");
	assert.ok(artifact.counts.restore_rules >= 20);
	assert.ok(artifact.counts.types_gated_rules >= 10);
	assert.ok(artifact.counts.handler_categories >= 25);
	assert.ok(artifact.counts.handler_fields >= 80);
	assert.ok(artifact.counts.direct_writes >= 20);
	assert.ok(artifact.counts.receiver_writes >= 3);
	assert.ok(artifact.counts.we_set >= 50);
});

test("a handler's constructor literal contributes its keys, in both the local and return shapes", () => {
	assert.ok(capturesFor("entity-ghost").includes("ghost_name"),
		"entity-ghost captures ghost_name only in its `local data = { ghost_name = ... }` constructor — a "
		+ "parser reading `data.X =` alone reports the category capturing everything BUT its identity");
	assert.ok(capturesFor("transport-belt").includes("items"),
		"transport-belt's whole body is `return { items = ... }`, so the return shape is the only way its "
		+ "one field is seen at all");
	assert.ok(capturesFor("assembling-machine").includes("inventories"));
	assert.deepEqual(capturesFor("underground-belt").filter(f => ["items", "belt_to_ground_type"].includes(f)),
		["belt_to_ground_type", "items"],
		"a constructor carrying two keys contributes both, not just the first");
});

test("a constructor's NESTED keys stay out — only the top level is a capture field", () => {
	assert.deepEqual(topLevelKeys('{ a = 1, b = { c = 2, d = 3 }, e = f(g, h) }'), ["a", "b", "e"],
		"a nested table's keys are the shape of a captured VALUE, not further payload fields, and a comma "
		+ "inside a call's argument list must not split an element either");
	assert.equal(capturesFor("item-request-proxy").includes("name"), false,
		"item-request-proxy builds `data.filter`-style nested tables whose inner keys (name, quality) are "
		+ "not payload fields of the category");
});

test("a bracket-index write resolves through the ipairs literal list that binds it", () => {
	for (const property of ["providing_to_other_platforms", "request_missing_construction_materials",
		"request_from_buffers"]) {
		assert.notEqual(weSetRow(property), null,
			`the space-platform-hub branch writes entity[hub_field] for ${property}, and a parser reading `
			+ "only `entity.<name> =` sees a hub whose config the pipeline never restores");
	}
	for (const property of ["mining_progress", "bonus_mining_progress"]) {
		assert.notEqual(weSetRow(property), null,
			`the deferred mining-progress pass writes rec.entity[field] for ${property} — the receiver's `
			+ "last component is `entity`, so the leaf is an entity property");
	}
});

test("a re-bound alias resolves to the binding nearest ABOVE the write, not the last one in the file", () => {
	const source = [
		"local cb = entity.get_control_behavior()",
		"cb.parameters = data.parameters",
		"local cb = entity.get_or_create_control_behavior()",
		"cb.operation = data.operation",
	].join("\n");
	assert.deepEqual(extractReceiverWrites([{ rel: "synthetic.lua", source }]).map(row =>
		`${row.receiver}.${row.property}`),
	["entity.get_control_behavior().parameters", "entity.get_or_create_control_behavior().operation"],
	"each write belongs to the binding in scope where it sits — a whole-file map keeps only the last "
		+ "binding and mislabels every earlier write through that name");
});

test("an unresolvable bracket index contributes nothing, rather than a guessed name", () => {
	const rows = extractDirectWrites([{
		rel: "synthetic.lua",
		source: [
			"entity[prop] = value",
			"for _, known in ipairs({ \"alpha\", \"beta\" }) do entity[known] = data[known] end",
			"data[prop] = value",
		].join("\n"),
	}]);
	assert.deepEqual(rows.map(row => row.property), ["alpha", "beta"],
		"the restore-rule applier's entity[prop] is driven by a rule row, not by literals in the source — "
		+ "inventing a property name there would put a name in the WE-SET that no line ever writes, while "
		+ "the rule's own property is already carried by the restore_rule arm. A non-entity receiver's "
		+ "bracket write is not an entity write at all");
});

test("writes through a non-entity receiver are recorded, and stay OUT of the WE-SET", () => {
	const through = new Set(artifact.receiver_writes.map(row => `${row.receiver}.${row.property}`));
	for (const write of ["entity.segmented_unit.activity_mode", "entity.segmented_unit.minimum_activity_mode",
		"entity.burner.currently_burning", "entity.burner.remaining_burning_fuel", "entity.train.schedule",
		"entity.get_control_behavior().parameters"]) {
		assert.ok(through.has(write), `${write} is a write the pipeline performs — the derivation must see it`);
	}
	for (const leaf of ["activity_mode", "minimum_activity_mode", "currently_burning", "schedule"]) {
		assert.equal(weSetRow(leaf), null,
			`${leaf} is written on a LuaSegmentedUnit/LuaBurner/LuaTrain, not on the entity, so the WE-SET `
			+ "must not claim it: the differ would assert it on every entity and report it unwalked forever");
	}
	assert.equal(through.has("entity.get_or_create_control_behavior().parameters"), false,
		"deserializer.lua binds `cb` twice — get_control_behavior() at :540, which governs the parameters "
		+ "write two lines later, and get_or_create_control_behavior() at :1039. Resolving an alias to the "
		+ "LAST binding in the file rather than the nearest one preceding the write records a receiver the "
		+ "write never had, and the control above would pin that as measured fact");
	assert.equal(artifact.direct_writes.some(row => row.property === "parameters"), false,
		"cb.parameters is the sharpest case for deciding membership by RECEIVER and never by leaf name: "
		+ "LuaEntity really does have a parameters attribute, so a leaf-name rule would admit a "
		+ "LuaControlBehavior write as an entity write and look correct doing it");
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

test("MUTATION KILL: removing a constructor-literal field is seen as a loss", () => {
	const mutated = handlerSource.replace("  local data = {\n    ghost_name = entity.ghost_name\n  }",
		"  local data = {\n  }");
	assert.notEqual(mutated, handlerSource, "the mutation must apply, or this test proves nothing");
	const captures = extractHandlerCaptures(mutated);
	assert.equal(captures.find(row => row.category === "entity-ghost").fields.includes("ghost_name"), false,
		"the derivation must SEE the removed constructor field disappear");
	assert.ok(checkControls(rebuild({ handlerSource: mutated }))
		.some(failure => failure.includes("entity-ghost.ghost_name went missing")),
		"and the control must go red, so main() refuses to write the shortened artifact");
});

test("MUTATION KILL: removing a non-entity-receiver write is seen as a loss", () => {
	const mutated = deserializerSource.replace(
		"function() unit.activity_mode = wanted.activity_mode end)", "function() end)");
	assert.notEqual(mutated, deserializerSource, "the mutation must apply, or this test proves nothing");
	const writes = extractReceiverWrites([{ rel: "core/deserializer.lua", source: mutated }]);
	assert.equal(writes.some(row => row.property === "activity_mode"), false,
		"the derivation must SEE the removed alias-receiver write disappear");
	assert.ok(checkControls(rebuild({ deserializerSource: mutated }))
		.some(failure => failure.includes("entity.segmented_unit.activity_mode\" went missing")));
});

test("MUTATION KILL: removing a nested-chain write is seen as a loss", () => {
	const mutated = deserializerSource.replace("entity.burner.currently_burning = {", "local dead = {");
	assert.notEqual(mutated, deserializerSource, "the mutation must apply, or this test proves nothing");
	const writes = extractReceiverWrites([{ rel: "core/deserializer.lua", source: mutated }]);
	assert.equal(writes.some(row => row.property === "currently_burning"), false,
		"a nested `entity.a.b =` chain is the shape the direct-write scan was blind to — the arm must see "
		+ "its removal, or it is not reading that shape at all");
	assert.ok(checkControls(rebuild({ deserializerSource: mutated }))
		.some(failure => failure.includes("entity.burner.currently_burning\" went missing")));
});

test("MUTATION KILL: removing a bracket write's literal is seen as a loss", () => {
	const mutated = deserializerSource.replace("      \"providing_to_other_platforms\",\n", "");
	assert.notEqual(mutated, deserializerSource, "the mutation must apply, or this test proves nothing");
	const writes = extractDirectWrites([{ rel: "core/deserializer.lua", source: mutated }]);
	assert.equal(writes.some(row => row.property === "providing_to_other_platforms"), false,
		"the literal list IS the property list for a bracket write — dropping one must shrink the WE-SET");
	assert.ok(checkControls(rebuild({ deserializerSource: mutated }))
		.some(failure => failure.includes('direct write "providing_to_other_platforms" went missing')));
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
