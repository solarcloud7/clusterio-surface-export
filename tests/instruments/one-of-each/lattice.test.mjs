import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	CELL_INNER, CELL_PITCH, allocate, boxesOverlap, cellClass, cellFitFailure, cellsFor, checkLayout,
	collisionFootprint, findOverlaps, loadPlacementRules, positionIn, ruleFor, tileFootprint,
} from "./lattice.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const UNIVERSE = JSON.parse(readFileSync(path.join(here, "universe.json"), "utf8"));
const RULES = loadPlacementRules();

const COLUMNS = 8;
const ROWS = 12;
const ORIGIN = { x: -6, y: -7 };

const entry = (type, tw, th, box) => ({
	type, representative: type,
	footprint: { tile_width: tw, tile_height: th, collision_box: box || [-tw / 2 + 0.1, -th / 2 + 0.1, tw / 2 - 0.1, th / 2 - 0.1] },
});

const HUB_CELL = { column: 0, row: 0 };
const HUB_BOX = { left: -4, top: -4, right: 4, bottom: 4 };

const production = () => allocate({
	entries: UNIVERSE.entries.filter(row => !RULES.rules[row.type]?.provided_by),
	columns: COLUMNS, rows: ROWS, origin: ORIGIN, reserved: [HUB_CELL], rules: RULES,
});

test("cellClass partitions the grid — south wins over outward, and interiors exist", () => {
	assert.equal(cellClass(3, ROWS - 1, COLUMNS, ROWS), "edge_south");
	assert.equal(cellClass(0, ROWS - 1, COLUMNS, ROWS), "edge_south");
	assert.equal(cellClass(3, 0, COLUMNS, ROWS), "edge_outward");
	assert.equal(cellClass(0, 4, COLUMNS, ROWS), "edge_outward");
	assert.equal(cellClass(COLUMNS - 1, 4, COLUMNS, ROWS), "edge_outward");
	assert.equal(cellClass(3, 4, COLUMNS, ROWS), "interior");
});

test("cells are laid on the gallery pitch, in row-major order", () => {
	const cells = cellsFor(COLUMNS, ROWS, ORIGIN);
	assert.equal(cells.length, COLUMNS * ROWS);
	assert.deepEqual({ x: cells[0].left, y: cells[0].top }, { x: ORIGIN.x, y: ORIGIN.y });
	assert.equal(cells[1].left - cells[0].left, CELL_PITCH.x);
	assert.equal(cells[COLUMNS].top - cells[0].top, CELL_PITCH.y);
});

test("positionIn returns an engine-aligned position — half-tile for odd spans, whole for even", () => {
	const cell = { left: 0, top: 0 };
	assert.equal(positionIn(cell, 3, 3).x % 1, 0.5);
	assert.equal(positionIn(cell, 4, 4).x % 1, 0);
	assert.equal(positionIn(cell, 1, 2).x % 1, 0.5);
	assert.equal(positionIn(cell, 1, 2).y % 1, 0);
});

test("a zero-tile prototype is still given a real cell slot", () => {
	const position = positionIn({ left: 0, top: 0 }, 0, 0);
	assert.equal(Number.isFinite(position.x) && Number.isFinite(position.y), true);
	const box = tileFootprint(position, 0, 0);
	assert.equal(box.right - box.left, 1, "a 0x0 flying prototype must still reserve a tile of space");
});

test("boxesOverlap is exclusive at the edge — touching footprints do not overlap", () => {
	const a = { left: 0, top: 0, right: 2, bottom: 2 };
	assert.equal(boxesOverlap(a, { left: 2, top: 0, right: 4, bottom: 2 }), false);
	assert.equal(boxesOverlap(a, { left: 1.9, top: 0, right: 4, bottom: 2 }), true);
	assert.equal(boxesOverlap(a, { left: 0, top: 2, right: 2, bottom: 4 }), false);
});

test("VACUITY CONTROL: findOverlaps reports a real overlap, so a clean run means something", () => {
	const position = { x: 0, y: 0 };
	const stacked = [
		{ type: "a", collision_footprint: collisionFootprint(position, [-2, -2, 2, 2]) },
		{ type: "b", collision_footprint: collisionFootprint(position, [-1, -1, 1, 1]) },
	];
	assert.deepEqual(findOverlaps(stacked), [{ a: "a", b: "b" }]);
	assert.deepEqual(findOverlaps([stacked[0]]), []);
	assert.deepEqual(findOverlaps([]), []);
});

test("VACUITY CONTROL: a cell too small for its occupant is reported as an overhang", () => {
	const cell = { left: 0, top: 0, column: 0, row: 0, cellClass: "interior" };
	const oversized = CELL_INNER.width + 4;
	const position = positionIn(cell, oversized, 2);
	const placement = {
		type: "too-wide", cell,
		tile_footprint: tileFootprint(position, oversized, 2),
	};
	assert.match(cellFitFailure(placement), /overhangs its cell/);
});

test("the PRODUCTION allocation places every universe entry the platform must create", () => {
	const { placements, unplaced } = production();
	const expected = UNIVERSE.entries.filter(row => !RULES.rules[row.type]?.provided_by).length;
	assert.deepEqual(unplaced, [], "an entry with nowhere to go would silently shrink the fixture");
	assert.equal(placements.length, expected);
	assert.equal(placements.length > 0, true, "a zero-placement run would pass every property below vacuously");
});

test("the PRODUCTION allocation has no overlapping footprint and no cell overhang", () => {
	const { placements } = production();
	assert.equal(placements.length > 0, true);
	assert.deepEqual(checkLayout(placements), []);
});

test("every placement sits in its own cell — one entity per cell", () => {
	const { placements } = production();
	const cells = placements.map(row => `${row.cell.column},${row.cell.row}`);
	assert.equal(new Set(cells).size, cells.length, "two entries were allocated the same cell");
});

test("the thruster lands on the SOUTH edge and the collector on an outward edge", () => {
	const { placements } = production();
	const thruster = placements.find(row => row.type === "thruster");
	assert.equal(thruster.cell.cellClass, "edge_south");
	assert.equal(thruster.cell.row, ROWS - 1);
	assert.equal(thruster.rule.direction, "south");

	const collector = placements.find(row => row.type === "asteroid-collector");
	assert.notEqual(collector.cell.cellClass, "interior",
		"an interior collector faces nothing — the constraint is the cell, not just the direction");
});

test("the hub type is provided by the platform, not allocated a cell", () => {
	const rule = ruleFor(RULES, "space-platform-hub");
	assert.equal(rule.provided_by, "platform_hub");
	const { placements } = production();
	assert.equal(placements.some(row => row.type === "space-platform-hub"), false);
});

test("the hub's own cell is RESERVED, and nothing is placed into the hub's footprint", () => {
	const { placements } = production();
	assert.equal(placements.some(row => row.cell.column === HUB_CELL.column && row.cell.row === HUB_CELL.row),
		false, "an entry allocated the hub's cell would be created on top of the hub");
	for (const placement of placements) {
		assert.equal(boxesOverlap(placement.collision_footprint, HUB_BOX), false,
			`${placement.type} overlaps the platform hub`);
	}
});

test("a reserved cell that is not in the lattice is refused rather than ignored", () => {
	assert.throws(() => allocate({
		entries: [entry("a", 1, 1)], columns: 2, rows: 2, origin: ORIGIN,
		reserved: [{ column: 9, row: 9 }], rules: { rules: {} },
	}), /is not in a 2x2 lattice/);
});

test("an unsatisfiable edge constraint comes back in unplaced — it is never quietly downgraded", () => {
	const entries = [entry("thruster", 4, 5), entry("second-thruster", 4, 5)];
	const rules = { rules: { thruster: { edge: "south" }, "second-thruster": { edge: "south" } } };
	const { placements, unplaced } = allocate({ entries, columns: 1, rows: 2, origin: ORIGIN, rules });
	assert.equal(placements.length, 1);
	assert.equal(unplaced.length, 1);
	assert.match(unplaced[0].reason, /no free south-edge cell/);
});

test("a grid with fewer cells than entries reports the shortfall rather than dropping it", () => {
	const entries = [entry("a", 1, 1), entry("b", 1, 1), entry("c", 1, 1)];
	const { placements, unplaced } = allocate({
		entries, columns: 1, rows: 2, origin: ORIGIN, rules: { rules: {} },
	});
	assert.equal(placements.length, 2);
	assert.equal(unplaced.length, 1);
	assert.match(unplaced[0].reason, /ran out of cells/);
});

test("an unenumerated edge class throws rather than silently allocating an interior cell", () => {
	const entries = [entry("weird", 1, 1)];
	const rules = { rules: { weird: { edge: "up" } } };
	assert.throws(() => allocate({ entries, columns: 2, rows: 2, origin: ORIGIN, rules }),
		/does not implement/);
});

test("allocation is deterministic — the same input yields the same cells", () => {
	const first = production().placements.map(row => `${row.type}@${row.position.x},${row.position.y}`);
	const second = production().placements.map(row => `${row.type}@${row.position.x},${row.position.y}`);
	assert.deepEqual(first, second);
});

test("every placement rule names a type that is in the universe", () => {
	const universe = new Set(UNIVERSE.entries.map(row => row.type));
	for (const type of Object.keys(RULES.rules)) {
		assert.equal(universe.has(type), true, `placement rule ${type} names a type outside the universe`);
	}
});

test("every placement rule carries a reason", () => {
	for (const [type, rule] of Object.entries(RULES.rules)) {
		assert.equal(typeof rule.reason === "string" && rule.reason.length > 20, true,
			`placement rule ${type} has no reason`);
	}
});

test("both ghost rules name an inner_name — a ghost of nothing cannot be created", () => {
	for (const type of ["entity-ghost", "tile-ghost"]) {
		assert.equal(typeof RULES.rules[type].inner_name, "string");
		assert.equal(RULES.rules[type].inner_name.length > 0, true);
	}
});

test("the proxy rule targets a type that is itself placed, and is ordered after it", () => {
	const rule = RULES.rules["item-request-proxy"];
	assert.equal(rule.order, "after_targets");
	const { placements } = production();
	assert.equal(placements.some(row => row.type === rule.target_type), true,
		"the proxy targets a type the lattice never places");
});
