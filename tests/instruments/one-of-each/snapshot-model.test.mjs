// snapshot-model.test — the walk roster, the pairing key, and the generated walker
//
// requires: the vendored scripts/factorio-api-index.json at the 2.1.17 pin
// produces: pins on the readable-attribute roster, the cell states, the hash constants the emitted
//           Lua must carry, and the fingerprint's sensitivity to what was walked
// does not: execute the emitted Lua (no Lua runtime offline) — the constants are pinned in one
//           place and asserted to appear in the emitted text, which is the offline half

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	SNAPSHOT_SCHEMA, CELL_STATES, HASH_THRESHOLD_CHARS, HASH_SEED, HASH_MULT, HASH_MOD, HASH_PREFIX,
	POSITION_DECIMALS, NUMBER_FORMAT, MAX_TABLE_DEPTH,
	buildWalkerLua, cellHashed, cellNil, cellPresent, cellThrew, entityKey, hashString,
	parseSnapshot, positionKey, specFingerprint, walkableAttributes,
} from "./snapshot-model.mjs";

test("the LuaEntity walk roster is the READABLE attributes, and both counts are pinned", () => {
	const roster = walkableAttributes("LuaEntity");
	assert.equal(roster.pin, "2.1.17");
	assert.equal(roster.total, 313, "LuaEntity carries 313 merged attributes at this pin (2.1.13 added local_effect and potential_effects)");
	assert.equal(roster.readable.length, 311,
		"311 of those 313 are readable — crane_grappler_destination and crane_grappler_destination_3d are "
		+ "write-only, and walking them would manufacture THREW cells that mean nothing");
	assert.equal(roster.readable.includes("crane_grappler_destination"), false);
	assert.equal(roster.readable.includes("unit_number"), true);
	assert.equal(roster.readable.includes("link_id"), true);
	assert.deepEqual(roster.readable, [...roster.readable].sort(), "the roster must be order-stable");
});

test("the roster reaches inherited members, not just LuaEntity's own", () => {
	const roster = walkableAttributes("LuaEntity").readable;
	for (const inherited of ["opened", "riding_state", "vehicle", "driving", "cursor_stack"]) {
		assert.ok(roster.includes(inherited), `${inherited} comes in from LuaControl and must be walked`);
	}
});

test("a class with no readable attributes is refused rather than walked emptily", () => {
	assert.throws(() => walkableAttributes("LuaNotAClass"), /not in the vendored API index/);
});

test("the pairing key is (name, quality, position) at fixed precision", () => {
	assert.equal(positionKey(10.5, -4.5), "10.500,-4.500");
	assert.equal(POSITION_DECIMALS, 3);
	assert.equal(entityKey({ name: "steel-chest", quality: "normal", x: 10.5, y: -4.5 }),
		"steel-chest|normal|10.500,-4.500");
	assert.notEqual(
		entityKey({ name: "steel-chest", quality: "normal", x: 10.5, y: -4.5 }),
		entityKey({ name: "steel-chest", quality: "rare", x: 10.5, y: -4.5 }),
		"quality is part of identity — two qualities at one position are two different entities");
});

test("cells are three-valued and the throw text is kept as data", () => {
	assert.deepEqual(CELL_STATES, ["PRESENT", "NIL", "THREW"]);
	assert.deepEqual(cellPresent("42"), { state: "PRESENT", value: "42", hashed: false });
	assert.deepEqual(cellNil(), { state: "NIL" });
	assert.deepEqual(cellThrew("LuaEntity doesn't contain key foo."),
		{ state: "THREW", throw: "LuaEntity doesn't contain key foo." });
	assert.deepEqual(cellHashed("djb2:0000000123", 4096),
		{ state: "PRESENT", value: "djb2:0000000123", hashed: true, length: 4096 });
});

test("the hash is stable, seeded, and prefixed", () => {
	assert.equal(hashString(""), `${HASH_PREFIX}${String(HASH_SEED).padStart(10, "0")}`);
	assert.equal(hashString("abc"), hashString("abc"));
	assert.notEqual(hashString("abc"), hashString("abd"));
	assert.ok(hashString("x").startsWith(HASH_PREFIX));
	assert.match(hashString("x"), /^djb2:\d{10}$/);
});

test("the emitted walker carries the shared constants — no second copy to drift", () => {
	const lua = buildWalkerLua({ surface: "platform-1", arm: "reference", outputFile: "snap.json" });
	assert.match(lua, /^\/sc /);
	assert.ok(lua.includes(`local HASH_THRESHOLD = ${HASH_THRESHOLD_CHARS}`));
	assert.ok(lua.includes(`local HASH_SEED = ${HASH_SEED}`));
	assert.ok(lua.includes(`local HASH_MULT = ${HASH_MULT}`));
	assert.ok(lua.includes(`local HASH_MOD = ${HASH_MOD}`));
	assert.ok(lua.includes(`local MAX_DEPTH = ${MAX_TABLE_DEPTH}`));
	assert.ok(lua.includes(`string.format("${NUMBER_FORMAT}", v)`));
	assert.ok(lua.includes(`"${SNAPSHOT_SCHEMA}"`));
	assert.ok(lua.includes(`%.${POSITION_DECIMALS}f,%.${POSITION_DECIMALS}f`));
});

test("the emitted walker reads every attribute under pcall and never truncates", () => {
	const lua = buildWalkerLua({ surface: "p", arm: "a", outputFile: "o.json" });
	assert.ok(lua.includes("local ok, value = pcall(function() return entity[attr] end)"),
		"an unguarded read on 309 attributes kills the instance");
	assert.ok(lua.includes('state = "THREW"'));
	assert.ok(lua.includes('state = "NIL"'));
	assert.ok(lua.includes('state = "PRESENT"'));
	assert.equal(/:sub\(|string\.sub|\.\.\."\.\.\."/.test(lua), false,
		"no truncation: a long value is hashed whole, by the same Lua in both arms");
	assert.ok(lua.includes("hash_string(text)"));
});

test("the walker canonicalizes objects by name and position, sorts table keys, and caps depth", () => {
	const lua = buildWalkerLua({ surface: "p", arm: "a", outputFile: "o.json" });
	assert.ok(lua.includes("local function object_key(v, oname)"));
	assert.ok(lua.includes("lua_object_name(v)"), "objects are detected by object_name, not by type()");
	assert.ok(lua.includes("table.sort(keys"), "table key order must be fixed or the two arms disagree");
	assert.ok(lua.includes("if depth <= 0 then return \"<depth>\" end"));
});

test("the walker refuses to be built without the things that make a snapshot pairable", () => {
	assert.throws(() => buildWalkerLua({ arm: "a", outputFile: "o" }), /needs a surface/);
	assert.throws(() => buildWalkerLua({ surface: "p", outputFile: "o" }), /needs an arm/);
	assert.throws(() => buildWalkerLua({ surface: "p", arm: "a" }), /needs an outputFile/);
	assert.throws(() => buildWalkerLua({ surface: "p", arm: "a", outputFile: "o", attributes: [] }),
		/empty attribute roster/);
});

test("the fingerprint changes when what was walked changes", () => {
	const base = specFingerprint({ className: "LuaEntity", attributes: ["a", "b"] });
	assert.equal(base, specFingerprint({ className: "LuaEntity", attributes: ["a", "b"] }));
	assert.notEqual(base, specFingerprint({ className: "LuaEntity", attributes: ["a", "b", "c"] }));
	assert.notEqual(base, specFingerprint({ className: "LuaTrain", attributes: ["a", "b"] }));
});

const GOOD_SNAPSHOT = {
	schema: SNAPSHOT_SCHEMA,
	fingerprint: "djb2:0000000001",
	arm: "reference",
	class_name: "LuaEntity",
	surface: "p",
	tick: 100,
	attributes: ["direction"],
	entities: [{
		key: "steel-chest|normal|1.500,2.500", name: "steel-chest", quality: "normal",
		etype: "container", x: 1.5, y: 2.5, cells: { direction: { state: "PRESENT", value: "0", hashed: false } },
	}],
};

test("parseSnapshot accepts a well-formed snapshot and refuses a malformed one", () => {
	assert.equal(parseSnapshot(GOOD_SNAPSHOT).arm, "reference");
	assert.equal(parseSnapshot(JSON.stringify(GOOD_SNAPSHOT)).arm, "reference");

	assert.throws(() => parseSnapshot({ ...GOOD_SNAPSHOT, schema: "other" }), /snapshot schema is "other"/);
	assert.throws(() => parseSnapshot({ ...GOOD_SNAPSHOT, fingerprint: undefined }), /missing "fingerprint"/);
	assert.throws(() => parseSnapshot({ ...GOOD_SNAPSHOT, entities: {} }), /entities must be an array/);
	assert.throws(() => parseSnapshot({
		...GOOD_SNAPSHOT,
		entities: [{ ...GOOD_SNAPSHOT.entities[0], key: undefined }],
	}), /carries no pairing key/);
	assert.throws(() => parseSnapshot({
		...GOOD_SNAPSHOT,
		entities: [{ ...GOOD_SNAPSHOT.entities[0], cells: { direction: { state: "MAYBE" } } }],
	}), /has state "MAYBE"/);
});
