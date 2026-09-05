// exclusions.test — the committed exclusion artifact still says what it was derived to say
//
// requires: derived-exclusions.json committed beside derive-exclusions.mjs
// produces: pins on all three derivations, the link_id negative control, and mutation-kill
//           evidence that the inheritance-chain pin goes red when the merge is broken
// does not: re-derive from runtime-api.json (2 MB, not vendored) — the real counts are pinned
//           against the committed artifact and the predicate is exercised against a synthetic API

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	SCOPE_CLASSES, IDENTITY_DOC_RE, assemble, checkControls, deriveObjectValued,
	mentionsClass, mergedAttributes, loadManual,
} from "./derive-exclusions.mjs";
import { loadExclusions, classify, entryFor, entriesForClass } from "./exclusions.mjs";

const artifact = loadExclusions();
const idOf = entry => `${entry.class}.${entry.member}`;
const derivation = name => artifact.entries.filter(entry => entry.derivation === name);

test("the artifact is non-vacuous and matches the pin the rest of the repo is built on", () => {
	assert.equal(artifact.schema, "one-of-each/derived-exclusions@1");
	assert.equal(artifact.application_version, "2.1.17");
	assert.ok(artifact.entries.length >= 50,
		`only ${artifact.entries.length} entries — an empty or collapsed artifact excludes nothing and `
		+ "every raw object cell then reads as a false agreement");
	assert.deepEqual(artifact.scope_classes, SCOPE_CLASSES,
		"the derivation scope is pinned here so a change to it cannot silently change what gets excluded");
});

test("absolute clocks derive to exactly the five doc-matched names, classified band", () => {
	const names = artifact.derivations.absolute_clock.names;
	assert.deepEqual(names, ["character_corpse_tick_of_death", "spoil_tick", "tick_grown",
		"tick_of_last_attack", "tick_of_last_damage"]);
	const rows = derivation("absolute_clock");
	assert.equal(rows.length, 5);
	for (const row of rows) {
		assert.equal(row.classification, "band",
			`${idOf(row)} must be BANDED, not excluded — an absolute tick is another instance's clock, `
			+ "but the duration it encodes is a real property that must still be compared");
	}
});

test("identity derives to exactly the four class-qualified names, classified exclude", () => {
	const ids = derivation("identity").map(idOf).sort();
	assert.deepEqual(ids, ["LuaEntity.unit_number", "LuaItemStack.item_number",
		"LuaSpacePlatform.index", "LuaTrain.id"]);
	for (const row of derivation("identity")) assert.equal(row.classification, "exclude");
});

test("object-valued reads derive to 61 on LuaEntity — 51 own plus 10 walked in from LuaControl", () => {
	const rows = derivation("object_valued").filter(row => row.class === "LuaEntity");
	const own = rows.filter(row => row.definingClass === "LuaEntity").length;
	assert.equal(rows.length, 61, "61 is the merged count; 51 means the inheritance chain stopped at LuaEntity");
	assert.equal(own, 51);
	assert.equal(rows.length - own, 10);
	assert.equal(new Set(rows.map(row => row.definingClass)).size, 2, "LuaEntity merges exactly one parent");
	for (const row of rows) {
		assert.equal(row.classification, "canonicalize",
			`${idOf(row)} must be CANONICALIZED, never excluded — a raw object cell compares two engine `
			+ "handles and agrees for the wrong reason");
	}
});

test("link_id is classified as nothing at all — the pipeline restores it", () => {
	assert.equal(classify("LuaEntity", "link_id"), null);
	assert.equal(entryFor("LuaEntity", "link_id"), null);
	const index = JSON.parse(JSON.stringify({ doc: "The link ID this linked container is using." }));
	assert.equal(IDENTITY_DOC_RE.test(index.doc), false,
		"the identity pattern must not reach link_id: entity-handlers.lua:370 captures it and "
		+ "deserializer.lua:103 writes it back, so excluding it would hide a real loss");
});

test("every manual entry carries a reason; every derived entry does not invent one", () => {
	const manual = derivation("manual");
	assert.ok(manual.length >= 3, `only ${manual.length} manual entries — the reviewed residue vanished`);
	assert.deepEqual(manual.map(idOf).sort(),
		["LuaEntity.electric_network_id", "LuaEntity.force_index", "LuaEntity.surface_index"]);
	for (const row of manual) assert.ok(typeof row.reason === "string" && row.reason.length >= 20, idOf(row));
	for (const row of artifact.entries.filter(e => e.derivation !== "manual")) {
		assert.equal(row.reason, null, `${idOf(row)} is derived — its derivation is its reason`);
	}
});

test("classify answers per class, and an unlisted member is comparable-raw", () => {
	assert.equal(classify("LuaEntity", "unit_number"), "exclude");
	assert.equal(classify("LuaEntity", "tick_grown"), "band");
	assert.equal(classify("LuaEntity", "last_user"), "canonicalize");
	assert.equal(classify("LuaEntity", "direction"), null);
	assert.equal(classify("LuaEntity", "zzz_not_a_member_zzz"), null);
	assert.ok(entriesForClass("LuaEntity").length > entriesForClass("LuaInventory").length);
});

test("counts add up — no entry is silently dropped by the conflict merge", () => {
	const { absolute_clock, object_valued, identity, manual } = artifact.derivations;
	const sum = absolute_clock.count + object_valued.count + identity.count + manual.count;
	assert.equal(sum, artifact.entries.length);
	assert.equal(new Set(artifact.entries.map(idOf)).size, artifact.entries.length, "entries must be unique");
});

test("MUTATION KILL: an inheritance merge that stops at LuaEntity turns the 61 pin red", () => {
	assert.deepEqual(checkControls(artifact), [], "the shipped artifact must pass its own controls");

	const broken = JSON.parse(JSON.stringify(artifact));
	broken.entries = broken.entries.filter(entry =>
		!(entry.derivation === "object_valued" && entry.class === "LuaEntity"
			&& entry.definingClass !== "LuaEntity"));
	const failures = checkControls(broken);
	assert.ok(failures.some(f => f.includes("object_valued LuaEntity derived 51")),
		`breaking the merge must be caught, got: ${JSON.stringify(failures)}`);
});

test("MUTATION KILL: classifying link_id turns the negative control red", () => {
	const broken = JSON.parse(JSON.stringify(artifact));
	broken.entries.push({
		class: "LuaEntity", member: "link_id", definingClass: "LuaEntity",
		classification: "exclude", derivation: "identity", reason: null,
	});
	assert.ok(checkControls(broken).some(f => f.includes("LuaEntity.link_id is classified")));
});

test("MUTATION KILL: losing the reviewed residue turns the manual control red", () => {
	const broken = JSON.parse(JSON.stringify(artifact));
	broken.entries = broken.entries.filter(entry => entry.derivation !== "manual");
	assert.ok(checkControls(broken).some(f => f.includes("no manual entries survived")));
});

const SYNTHETIC_API = {
	application_version: "2.1.11",
	api_version: 6,
	classes: [
		{
			name: "LuaControl", parent: null, methods: [],
			attributes: [
				{ name: "inherited_object", read_type: "LuaInventory" },
				{ name: "inherited_scalar", read_type: "uint" },
			],
		},
		{
			name: "LuaEntity", parent: "LuaControl", methods: [],
			attributes: [
				{ name: "own_scalar", read_type: "uint" },
				{ name: "own_object", read_type: "LuaEntity" },
				{ name: "own_array_of_object", read_type: { complex_type: "array", value: "LuaEntity" } },
				{ name: "own_union_with_object", read_type: { complex_type: "union", options: ["string", "LuaEntity"] } },
				{ name: "own_dict_keyed_by_object", read_type: { complex_type: "dictionary", key: "LuaEntity", value: "uint" } },
				{ name: "own_literal", read_type: { complex_type: "literal", value: "left" } },
				{
					name: "own_table_holding_object",
					read_type: { complex_type: "table", parameters: [{ name: "e", type: "LuaEntity" }] },
				},
				{ name: "write_only", read_type: null, write_type: "uint" },
			],
		},
		{ name: "LuaInventory", parent: null, methods: [], attributes: [] },
		{ name: "LuaItemStack", parent: null, methods: [], attributes: [] },
		{ name: "LuaTrain", parent: null, methods: [], attributes: [] },
		{ name: "LuaSpacePlatform", parent: null, methods: [], attributes: [] },
	],
};

test("the object-valued predicate recurses arrays, unions and dictionaries but not table parameters", () => {
	const names = new Set(["LuaEntity", "LuaInventory", "LuaItemStack", "LuaTrain", "LuaSpacePlatform", "LuaControl"]);
	assert.equal(mentionsClass("LuaEntity", names), true);
	assert.equal(mentionsClass("uint", names), false);
	assert.equal(mentionsClass({ complex_type: "array", value: "LuaEntity" }, names), true);
	assert.equal(mentionsClass({ complex_type: "array", value: "uint" }, names), false);
	assert.equal(mentionsClass({ complex_type: "union", options: ["string", "LuaEntity"] }, names), true);
	assert.equal(mentionsClass({ complex_type: "dictionary", key: "LuaEntity", value: "uint" }, names), true);
	assert.equal(mentionsClass({ complex_type: "literal", value: "left" }, names), false);
	assert.equal(mentionsClass({ complex_type: "table", parameters: [{ name: "e", type: "LuaEntity" }] }, names), false,
		"a table complex_type reads as a plain Lua table and is serialized by the walker, not canonicalized — "
		+ "this is the boundary that makes the LuaEntity count 61 rather than 64");
});

test("an unenumerated complex_type throws rather than reading as not-object-valued", () => {
	assert.throws(() => mentionsClass({ complex_type: "sometime_future_shape" }, new Set(["LuaEntity"])),
		/unhandled complex_type "sometime_future_shape"/);
});

test("the merge walks the parent chain, and dropping the parent is visible in the derived count", () => {
	const merged = mergedAttributes(SYNTHETIC_API, "LuaEntity");
	assert.equal(merged.get("inherited_object").definingClass, "LuaControl");
	assert.equal(merged.get("own_object").definingClass, "LuaEntity");

	const withParent = deriveObjectValued(SYNTHETIC_API).filter(row => row.class === "LuaEntity");
	assert.deepEqual(withParent.map(row => row.member).sort(),
		["inherited_object", "own_array_of_object", "own_dict_keyed_by_object", "own_object", "own_union_with_object"]);

	const orphaned = JSON.parse(JSON.stringify(SYNTHETIC_API));
	orphaned.classes.find(cls => cls.name === "LuaEntity").parent = null;
	const withoutParent = deriveObjectValued(orphaned).filter(row => row.class === "LuaEntity");
	assert.equal(withoutParent.length, withParent.length - 1,
		"breaking the chain must lose exactly the inherited object-valued attribute");
	assert.equal(withoutParent.some(row => row.member === "inherited_object"), false);
});

test("a write-only attribute is never walked into the object-valued set", () => {
	const rows = deriveObjectValued(SYNTHETIC_API).filter(row => row.class === "LuaEntity");
	assert.equal(rows.some(row => row.member === "write_only"), false);
});

test("a manual entry without a reason, outside scope, or misdescribed is refused", () => {
	const index = { classes: { LuaEntity: { surface_index: { kind: "attribute", read: true, write: false } } } };
	const ok = loadManual(index, {
		entries: [{
			class: "LuaEntity", member: "surface_index", classification: "exclude", assert_read_only: true,
			reason: "read-only at the pin and scoped to this instance's surface table",
		}],
	});
	assert.equal(ok.length, 1);

	assert.throws(() => loadManual(index, {
		entries: [{ class: "LuaEntity", member: "surface_index", classification: "exclude", reason: "too short" }],
	}), /has no reason/);

	assert.throws(() => loadManual(index, {
		entries: [{
			class: "LuaForce", member: "index", classification: "exclude",
			reason: "a perfectly good reason that is long enough to pass the length floor",
		}],
	}), /outside the derivation scope/);

	assert.throws(() => loadManual(index, {
		entries: [{
			class: "LuaEntity", member: "not_a_member", classification: "exclude",
			reason: "a perfectly good reason that is long enough to pass the length floor",
		}],
	}), /does not exist at this pin/);

	const writable = { classes: { LuaEntity: { surface_index: { kind: "attribute", read: true, write: true } } } };
	assert.throws(() => loadManual(writable, {
		entries: [{
			class: "LuaEntity", member: "surface_index", classification: "exclude", assert_read_only: true,
			reason: "a perfectly good reason that is long enough to pass the length floor",
		}],
	}), /claims read-only, but the index says write=true/);
});

test("two derivations disagreeing about one member is refused, not silently resolved", () => {
	const index = {
		application_version: "2.1.11",
		classes: {
			LuaEntity: { spoil_tick: { kind: "attribute", read: true, write: true, doc: "The tick this item spoils." } },
			LuaItemStack: {}, LuaInventory: {}, LuaTrain: {}, LuaSpacePlatform: {},
		},
	};
	const api = {
		application_version: "2.1.11", api_version: 6, __source: "synthetic",
		classes: [
			{ name: "LuaEntity", parent: null, methods: [], attributes: [{ name: "spoil_tick", read_type: "LuaEntity" }] },
			{ name: "LuaItemStack", parent: null, methods: [], attributes: [] },
			{ name: "LuaInventory", parent: null, methods: [], attributes: [] },
			{ name: "LuaTrain", parent: null, methods: [], attributes: [] },
			{ name: "LuaSpacePlatform", parent: null, methods: [], attributes: [] },
		],
	};
	assert.throws(() => assemble({ index, api, manualRaw: { entries: [] } }),
		/derives as both "band" \(absolute_clock\) and "canonicalize" \(object_valued\)/);
});
