import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	COLUMNS, PLATFORM_NAME, ROWS, censusHash, freezes, outwardDirection, partitionSpecs,
	resolveAgainstPlaced, specFor, specsFor,
} from "./build-staging.mjs";
import { loadPlacementRules } from "./lattice.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const UNIVERSE = JSON.parse(readFileSync(path.join(here, "universe.json"), "utf8"));
const RULES = loadPlacementRules();

const placement = (type, name, x, y, rule = null, cell = { column: 3, row: 4 }) => ({
	type, name, position: { x, y }, cell, rule,
});

test("the fixture builds under its permanent banked name, not a staging name", () => {
	assert.equal(PLATFORM_NAME, "oneofeach-fixture-v1");
	assert.doesNotMatch(PLATFORM_NAME, /staging/,
		"the generator clones, strips and rescans by name — a rename after banking would leave it building a "
		+ "platform the banked save does not contain");
});

test("a rail rule expands one cell into a centred segment at the prototype's own pitch", () => {
	const rule = RULES.rules["straight-rail"];
	const specs = specsFor(placement("straight-rail", "straight-rail", 100, 50, rule), RULES);
	assert.equal(specs.length, rule.segment.count);
	assert.deepEqual(specs.map(spec => spec.y), [46, 48, 50, 52, 54]);
	assert.equal(specs.every(spec => spec.x === 100), true);
	assert.equal(specs.every(spec => spec.dir === "north"), true);
	const mean = specs.reduce((sum, spec) => sum + spec.y, 0) / specs.length;
	assert.equal(mean, 50, "the segment must stay centred on the cell the lattice allocated");
});

test("a cell with no segment rule stays exactly one placement", () => {
	assert.equal(specsFor(placement("lamp", "small-lamp", 10, 10), RULES).length, 1);
});

test("the wagon is deferred and lands on the CENTRE rail, not the first one placed", () => {
	const rails = specsFor(placement("straight-rail", "straight-rail", 100, 50,
		RULES.rules["straight-rail"]), RULES);
	const placedRails = rails.map((spec, index) => ({
		t: "straight-rail", n: "straight-rail", placed: true, px: spec.x, py: spec.y, un: 900 + index,
	}));
	const wagon = specFor(placement("infinity-cargo-wagon", "infinity-cargo-wagon", 0, 0,
		RULES.rules["infinity-cargo-wagon"]), RULES);
	assert.equal(wagon.on_type, "straight-rail");

	const resolved = resolveAgainstPlaced(wagon, placedRails);
	assert.equal(resolved.ty, 50, "a wagon hung off the end rail would overhang the segment it needs under it");
	assert.equal(resolved.tx, 100);
	assert.equal(resolved.tn, "straight-rail");
});

test("a deferred spec whose anchor never placed is neutralised rather than aimed at the origin", () => {
	const wagon = specFor(placement("infinity-cargo-wagon", "infinity-cargo-wagon", 0, 0,
		RULES.rules["infinity-cargo-wagon"]), RULES);
	const resolved = resolveAgainstPlaced(wagon, []);
	assert.equal(resolved.tx, 0);
	assert.equal(resolved.ty, 0);
	assert.notEqual(resolved.tn, "straight-rail",
		"an unresolved anchor must not name a real prototype, or the Lua would attach to some other cell's entity");
});

test("partitionSpecs defers both the proxy and the wagon, and expands the rail into the first pass", () => {
	const placements = [
		placement("straight-rail", "straight-rail", 100, 50, RULES.rules["straight-rail"]),
		placement("infinity-cargo-wagon", "infinity-cargo-wagon", 200, 50, RULES.rules["infinity-cargo-wagon"]),
		placement("item-request-proxy", "item-request-proxy", 300, 50, RULES.rules["item-request-proxy"]),
		placement("lamp", "small-lamp", 400, 50),
	];
	const { first, afterTargets } = partitionSpecs(placements, RULES);
	assert.deepEqual(afterTargets.map(spec => spec.t).sort(), ["infinity-cargo-wagon", "item-request-proxy"]);
	assert.equal(first.filter(spec => spec.t === "straight-rail").length, 5);
	assert.equal(first.length, 6);
});

test("the freeze list is data, and it covers every type the ruling names", () => {
	for (const type of ["unit", "unit-spawner", "turret", "segmented-unit", "spider-unit", "combat-robot"]) {
		assert.equal(freezes(RULES, type), true, `${type} is named by the ruling and is not in the freeze list`);
	}
	assert.equal(freezes(RULES, "lamp"), false);
	assert.equal(RULES.freeze.lever, "disabled_by_script");
	assert.match(RULES.freeze.reason, /READ-ONLY at 2\.1\.11/,
		"the substitution of disabled_by_script for the ruling's active=false must carry the measurement");
});

test("every frozen type is actually in the universe the generator will place", () => {
	const universeTypes = new Set(UNIVERSE.entries.map(entry => entry.type));
	for (const type of RULES.freeze.types) {
		assert.equal(universeTypes.has(type), true,
			`${type} is in the freeze list but not in the universe — the freeze would silently apply to nothing`);
	}
});

test("a placement spec carries the freeze flag exactly for the frozen types", () => {
	assert.equal(specFor(placement("unit", "behemoth-biter", 1, 1), RULES).freeze, 1);
	assert.equal(specFor(placement("lamp", "small-lamp", 1, 1), RULES).freeze, undefined);
});

test("an unenumerated direction is refused rather than silently placed unrotated", () => {
	assert.throws(() => specFor(placement("x", "x", 1, 1, { direction: "widdershins" }), RULES),
		/does not implement/);
	assert.equal(specFor(placement("x", "x", 1, 1, { direction: "north" }), RULES).dir, "north");
	assert.equal(specFor(placement("x", "x", 1, 1, { direction: "south" }), RULES).dir, "south");
});

test("outwardDirection faces a cell off the platform, and refuses an interior cell", () => {
	assert.equal(outwardDirection({ column: 0, row: ROWS - 1 }, COLUMNS, ROWS), "south");
	assert.equal(outwardDirection({ column: 0, row: 0 }, COLUMNS, ROWS), "north");
	assert.equal(outwardDirection({ column: COLUMNS - 1, row: 3 }, COLUMNS, ROWS), "east");
	assert.throws(() => outwardDirection({ column: 3, row: 3 }, COLUMNS, ROWS), /interior/);
});

test("the placement census hash is order-independent but content-sensitive", () => {
	const rows = [
		{ type: "lamp", name: "small-lamp", x: 1, y: 2, outcome: "placed" },
		{ type: "pipe", name: "pipe", x: 3, y: 4, outcome: "placed" },
	];
	assert.equal(censusHash(rows).hash, censusHash([...rows].reverse()).hash);
	const moved = [{ ...rows[0], x: 9 }, rows[1]];
	assert.notEqual(censusHash(rows).hash, censusHash(moved).hash);
});
