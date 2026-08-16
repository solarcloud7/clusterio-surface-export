// differ.test — pairing, cell comparison, WE-SET verdicts, and the deduplicated audit report
//
// requires: derived-exclusions.json and we-set.json committed
// produces: pins on the pairing key, THREW-vs-NIL discrimination, band comparison, the audit
//           dedupe, and mutation-kill evidence that breaking the dedupe is visible
// does not: run the walker or contact the cluster — snapshots here are synthetic, which is what
//           makes the pairing and outcome logic testable at all

import { test } from "node:test";
import assert from "node:assert/strict";

import { SNAPSHOT_SCHEMA } from "./snapshot-model.mjs";
import { DEFAULT_BAND_TOLERANCE_TICKS, compareCell, diff, normalizeThrow } from "./differ.mjs";

const FINGERPRINT = "djb2:0000000042";

const present = value => ({ state: "PRESENT", value, hashed: false });
const hashed = (value, length) => ({ state: "PRESENT", value, hashed: true, length });
const nil = () => ({ state: "NIL" });
const threw = text => ({ state: "THREW", throw: text });

function entity(name, etype, x, y, cells, quality = "normal") {
	return { key: `${name}|${quality}|${x.toFixed(3)},${y.toFixed(3)}`, name, quality, etype, x, y, cells };
}

function snapshot({ arm, tick = 1000, attributes, entities, fingerprint = FINGERPRINT }) {
	return {
		schema: SNAPSHOT_SCHEMA, fingerprint, arm, class_name: "LuaEntity",
		surface: "p", tick, attributes, entities,
	};
}

const NO_WE_SET = { we_set: [] };

test("two snapshots from different walkers are refused, not diffed", () => {
	const a = snapshot({ arm: "ref", attributes: ["direction"], entities: [] });
	const b = snapshot({ arm: "sub", attributes: ["direction"], entities: [], fingerprint: "djb2:0000000099" });
	assert.throws(() => diff(a, b, { weSet: NO_WE_SET }), /refusing to diff: reference walker/);
});

test("entities pair on (name, quality, position); an unpaired entity is named, not dropped", () => {
	const cells = { direction: present("0") };
	const a = snapshot({
		arm: "ref", attributes: ["direction"],
		entities: [
			entity("steel-chest", "container", 1.5, 2.5, cells),
			entity("steel-chest", "container", 9.5, 9.5, cells),
			entity("steel-chest", "container", 4.5, 4.5, cells, "rare"),
		],
	});
	const b = snapshot({
		arm: "sub", attributes: ["direction"],
		entities: [
			entity("steel-chest", "container", 1.5, 2.5, cells),
			entity("steel-chest", "container", 4.5, 4.5, cells, "normal"),
		],
	});
	const result = diff(a, b, { weSet: NO_WE_SET });
	assert.equal(result.entities.paired, 1);
	assert.deepEqual(result.entities.only_in_reference,
		["steel-chest|normal|9.500,9.500", "steel-chest|rare|4.500,4.500"]);
	assert.deepEqual(result.entities.only_in_subject, ["steel-chest|normal|4.500,4.500"]);
	assert.equal(result.summary.entities_unpaired, 3,
		"quality is part of the key: the rare chest does not pair with the normal one");
});

test("THREW is discriminated from NIL — the two must never read as agreement", () => {
	assert.deepEqual(compareCell(threw("boom"), nil()), { outcome: "threw-vs-nil", agreement: "differ" });
	assert.deepEqual(compareCell(nil(), threw("boom")), { outcome: "threw-vs-nil", agreement: "differ" });
	assert.deepEqual(compareCell(nil(), nil()), { outcome: "both-nil", agreement: "agree" });
	assert.deepEqual(compareCell(threw("boom"), present("1")),
		{ outcome: "threw-vs-present", agreement: "differ" });
	assert.deepEqual(compareCell(present("1"), nil()), { outcome: "unset-difference", agreement: "differ" });
});

test("two arms throwing the same way agree; throwing differently does not", () => {
	assert.equal(compareCell(threw("LuaEntity doesn't contain key foo."),
		threw("LuaEntity doesn't contain key foo.")).agreement, "agree");
	assert.equal(compareCell(threw("LuaEntity doesn't contain key foo."),
		threw("LuaEntity doesn't contain key bar.")).agreement, "differ");
});

test("throw text is normalized for per-instance noise but not flattened to nothing", () => {
	assert.equal(normalizeThrow("__level__/modules/x.lua:123: attempt to index nil"),
		"attempt to index nil");
	assert.equal(normalizeThrow("tick 1234567 exceeded"), "tick <n> exceeded");
	assert.equal(normalizeThrow("value 42 is fine"), "value 42 is fine",
		"short numbers are data, not clock noise");
	assert.equal(normalizeThrow("  spaced   out  "), "spaced out");
	assert.notEqual(normalizeThrow("key foo"), normalizeThrow("key bar"),
		"normalization must not erase the part that identifies the failure");
});

test("a value equal in both arms agrees; hashed values compare as hashes", () => {
	assert.equal(compareCell(present("7"), present("7")).agreement, "agree");
	assert.equal(compareCell(present("7"), present("8")).agreement, "differ");
	assert.equal(compareCell(hashed("djb2:0000000001", 900), hashed("djb2:0000000001", 900)).agreement, "agree");
	assert.equal(compareCell(hashed("djb2:0000000001", 900), hashed("djb2:0000000002", 900)).agreement, "differ");
	const mixed = compareCell(hashed("djb2:0000000001", 900), present("short"));
	assert.equal(mixed.agreement, "differ");
	assert.match(mixed.detail, /one arm hashed and the other did not/);
});

test("an excluded cell is not compared; a banded cell is compared as a duration", () => {
	assert.deepEqual(compareCell(present("11"), present("99"), { classification: "exclude" }),
		{ outcome: "excluded", agreement: "agree" });

	const tick = { reference: 1000, subject: 5000 };
	const sameAge = compareCell(present("900"), present("4900"), { classification: "band", tick });
	assert.equal(sameAge.agreement, "agree");
	assert.equal(sameAge.outcome, "band-agree");
	assert.equal(sameAge.delta, 0);

	const rawEqual = compareCell(present("900"), present("900"),
		{ classification: "band", tick, toleranceTicks: 100 });
	assert.equal(rawEqual.agreement, "differ",
		"identical raw ticks across arms with different clocks is a DIFFERENT age — comparing raw would "
		+ "report agreement for the wrong reason");
	assert.equal(rawEqual.delta, 4000, "the two ages are 100 and 4100 ticks");

	assert.equal(DEFAULT_BAND_TOLERANCE_TICKS, 60_000);
	const withinTolerance = compareCell(present("900"), present("4000"),
		{ classification: "band", tick, toleranceTicks: 2000 });
	assert.equal(withinTolerance.agreement, "agree");
	assert.equal(compareCell(present("900"), present("100"),
		{ classification: "band", tick, toleranceTicks: 10 }).agreement, "differ");
	assert.equal(compareCell(present("not-a-number"), present("4900"),
		{ classification: "band", tick }).agreement, "differ");
});

test("a real exclusion classification reaches the audit row", () => {
	const attributes = ["unit_number", "tick_grown", "direction"];
	const cellsA = { unit_number: present("11"), tick_grown: present("900"), direction: present("0") };
	const cellsB = { unit_number: present("99"), tick_grown: present("4900"), direction: present("0") };
	const a = snapshot({ arm: "ref", tick: 1000, attributes, entities: [entity("tree", "plant", 1.5, 1.5, cellsA)] });
	const b = snapshot({ arm: "sub", tick: 5000, attributes, entities: [entity("tree", "plant", 1.5, 1.5, cellsB)] });
	const result = diff(a, b, { weSet: NO_WE_SET });
	const byField = new Map(result.audit.map(row => [row.field, row]));

	assert.equal(byField.get("unit_number").classification, "exclude");
	assert.equal(byField.get("unit_number").agreement, "agree");
	assert.equal(byField.get("tick_grown").classification, "band");
	assert.equal(byField.get("tick_grown").agreement, "agree", "same age, different clocks");
	assert.equal(byField.get("direction").classification, null);
	assert.equal(result.summary.audit_differing, 0);
});

test("the audit report carries one row per (type, field) however many entities there are", () => {
	const attributes = ["direction"];
	const many = n => Array.from({ length: n }, (_, i) => entity("steel-chest", "container", i + 0.5, 0.5,
		{ direction: present("0") }));
	const a = snapshot({ arm: "ref", attributes, entities: many(6) });
	const b = snapshot({ arm: "sub", attributes, entities: many(6) });
	const result = diff(a, b, { weSet: NO_WE_SET });

	assert.equal(result.entities.paired, 6);
	assert.equal(result.audit.length, 1, "six entities of one type share one audit row");
	assert.equal(result.audit[0].instances, 6);
	assert.deepEqual(result.audit[0].outcomes, { agree: 6 });

	const keys = result.audit.map(row => `${row.type} ${row.field}`);
	assert.equal(new Set(keys).size, keys.length, "audit keys must be unique");
});

test("two different entity types keep two audit rows for the same field", () => {
	const attributes = ["direction"];
	const rows = [
		entity("steel-chest", "container", 1.5, 0.5, { direction: present("0") }),
		entity("fast-inserter", "inserter", 2.5, 0.5, { direction: present("0") }),
	];
	const result = diff(snapshot({ arm: "ref", attributes, entities: rows }),
		snapshot({ arm: "sub", attributes, entities: rows }), { weSet: NO_WE_SET });
	assert.deepEqual(result.audit.map(row => row.type).sort(), ["container", "inserter"]);
});

test("a differing instance wins the row's verdict and supplies the sample", () => {
	const attributes = ["direction"];
	const refRows = [
		entity("steel-chest", "container", 1.5, 0.5, { direction: present("0") }),
		entity("steel-chest", "container", 2.5, 0.5, { direction: present("0") }),
	];
	const subRows = [
		entity("steel-chest", "container", 1.5, 0.5, { direction: present("0") }),
		entity("steel-chest", "container", 2.5, 0.5, { direction: present("4") }),
	];
	const result = diff(snapshot({ arm: "ref", attributes, entities: refRows }),
		snapshot({ arm: "sub", attributes, entities: subRows }), { weSet: NO_WE_SET });

	assert.equal(result.audit.length, 1);
	assert.equal(result.audit[0].agreement, "differ",
		"one differing instance out of two must not be averaged away into agreement");
	assert.deepEqual(result.audit[0].outcomes, { agree: 1, differ: 1 });
	assert.equal(result.audit[0].sample.entity, "steel-chest|normal|2.500,0.500");
	assert.deepEqual(result.audit[0].sample.reference, present("0"));
	assert.deepEqual(result.audit[0].sample.subject, present("4"));
	assert.equal(result.summary.audit_differing, 1);
});

test("WE-SET verdicts are per type+field, gated by type, with failures enumerated", () => {
	const weSet = {
		we_set: [
			{ property: "link_id", types: ["linked-container"], origins: ["restore_rule"] },
			{ property: "direction", types: null, origins: ["direct_write"] },
		],
	};
	const attributes = ["link_id", "direction"];
	const refRows = [
		entity("linked-chest", "linked-container", 1.5, 0.5, { link_id: present("7"), direction: present("0") }),
		entity("steel-chest", "container", 2.5, 0.5, { link_id: nil(), direction: present("0") }),
	];
	const subRows = [
		entity("linked-chest", "linked-container", 1.5, 0.5, { link_id: present("9"), direction: present("0") }),
		entity("steel-chest", "container", 2.5, 0.5, { link_id: nil(), direction: present("0") }),
	];
	const result = diff(snapshot({ arm: "ref", attributes, entities: refRows }),
		snapshot({ arm: "sub", attributes, entities: subRows }), { weSet });

	const byKey = new Map(result.verdicts.map(row => [`${row.type} ${row.field}`, row]));
	assert.deepEqual([...byKey.keys()].sort(),
		["container direction", "linked-container direction", "linked-container link_id"],
		"link_id is gated to linked-container, so the plain container gets no link_id verdict");

	const linkVerdict = byKey.get("linked-container link_id");
	assert.equal(linkVerdict.status, "FAIL");
	assert.equal(linkVerdict.checked, 1);
	assert.equal(linkVerdict.failures.length, 1);
	assert.equal(linkVerdict.failures[0].entity, "linked-chest|normal|1.500,0.500");
	assert.deepEqual(linkVerdict.failures[0].reference, present("7"));
	assert.deepEqual(linkVerdict.failures[0].subject, present("9"));
	assert.equal(byKey.get("container direction").status, "PASS");
	assert.equal(result.summary.verdicts_failed, 1);
});

test("a WE-SET property the walker never read is reported, not silently passed", () => {
	const weSet = { we_set: [{ property: "not_walked", types: null, origins: ["restore_rule"] }] };
	const rows = [entity("steel-chest", "container", 1.5, 0.5, { direction: present("0") })];
	const result = diff(snapshot({ arm: "ref", attributes: ["direction"], entities: rows }),
		snapshot({ arm: "sub", attributes: ["direction"], entities: rows }), { weSet });
	assert.deepEqual(result.unwalked_we_set, ["not_walked"]);
	assert.equal(result.verdicts.length, 0);
});

test("no paired entity of a type means no verdict row invented for it", () => {
	const weSet = { we_set: [{ property: "direction", types: null, origins: ["direct_write"] }] };
	const result = diff(snapshot({ arm: "ref", attributes: ["direction"], entities: [] }),
		snapshot({ arm: "sub", attributes: ["direction"], entities: [] }), { weSet });
	assert.deepEqual(result.verdicts, []);
	assert.equal(result.summary.verdicts_total, 0);
	assert.equal(result.entities.paired, 0);
});

test("the output contract WP5 consumes is flat and complete", () => {
	const rows = [entity("steel-chest", "container", 1.5, 0.5, { direction: present("0") })];
	const result = diff(snapshot({ arm: "engine-clone", attributes: ["direction"], entities: rows }),
		snapshot({ arm: "transfer-dest", attributes: ["direction"], entities: rows }), { weSet: NO_WE_SET });

	assert.equal(result.schema, "one-of-each/diff@1");
	assert.deepEqual(result.arms, { reference: "engine-clone", subject: "transfer-dest" });
	assert.equal(result.class_name, "LuaEntity");
	assert.equal(result.fingerprint, FINGERPRINT);
	assert.deepEqual(Object.keys(result.summary).sort(), ["audit_differing", "audit_rows",
		"entities_unpaired", "verdicts_failed", "verdicts_total", "verdicts_unexercised"]);
	for (const row of result.audit) {
		assert.deepEqual(Object.keys(row).sort(), ["agreement", "classification", "field", "instances",
			"outcome", "outcomes", "reason", "sample", "type"]);
	}
	assert.equal(JSON.parse(JSON.stringify(result)).schema, "one-of-each/diff@1", "must be plain JSON");
});

test("MUTATION KILL: an audit keyed on the entity instead of the type duplicates rows", () => {
	const attributes = ["direction"];
	const many = n => Array.from({ length: n }, (_, i) => entity("steel-chest", "container", i + 0.5, 0.5,
		{ direction: present("0") }));
	const result = diff(snapshot({ arm: "ref", attributes, entities: many(6) }),
		snapshot({ arm: "sub", attributes, entities: many(6) }), { weSet: NO_WE_SET });

	const deduped = result.audit.length;
	const perEntity = result.audit.reduce((total, row) => total + row.instances, 0);
	assert.equal(deduped, 1);
	assert.equal(perEntity, 6);
	assert.notEqual(deduped, perEntity,
		"if the audit key ever includes the entity key, deduped would equal perEntity and this pin goes red");
});
