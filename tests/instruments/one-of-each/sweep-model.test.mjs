import { test } from "node:test";
import assert from "node:assert/strict";

import {
	CELL_TOLERANCE, NOT_MEASURED, NOT_STAGED, buildTable, captureVerdict, completeness, createGateLatch,
	gateVerdictFor, matchCells, normalizeRows, restoreVerdict, summarizeGate, tallyVerdicts,
} from "./sweep-model.mjs";

const TYPES = ["accumulator", "gate", "straight-rail", "space-platform-hub"];

const cell = (type, name, x, y) => ({ type, name, x, y });

function scenario(overrides = {}) {
	const sourceRows = [
		cell("accumulator", "accumulator", 0, 0),
		cell("gate", "gate", 4, 0),
		cell("straight-rail", "straight-rail", 8, -4),
		cell("straight-rail", "straight-rail", 8, -2),
		cell("space-platform-hub", "space-platform-hub", -6, -7),
	];
	return {
		types: TYPES,
		sourceRows,
		payloadRows: sourceRows.map(row => ({ type: row.type, name: row.name, position: { x: row.x, y: row.y } })),
		destRows: sourceRows.map(row => ({ ...row })),
		gate: { validation_success: true },
		...overrides,
	};
}

test("rows are keyed on the staged type list, never on what the payload carried", () => {
	const input = scenario({
		payloadRows: [{ type: "segment", name: "big-demolisher-segment", position: { x: 0, y: 0 } }],
	});
	const { rows } = buildTable(input);
	assert.deepEqual(rows.map(r => r.type), TYPES);
	assert.equal(rows.some(r => r.type === "segment"), false);
});

test("an engine-owned type seen only in the reads is reported alongside the table, not as a row", () => {
	const input = scenario();
	input.sourceRows = [...input.sourceRows, cell("segment", "big-demolisher-segment", 20, 20)];
	input.destRows = [...input.destRows, cell("corpse", "behemoth-biter-corpse", 21, 21)];
	const table = buildTable(input);
	assert.deepEqual(table.rows.map(r => r.type), TYPES);
	assert.deepEqual(table.unkeyedSourceTypes, ["segment"]);
	assert.deepEqual(table.unkeyedDestTypes, ["corpse"]);
});

test("a clean round trip reads CAPTURED / PASS / RESTORED on every staged row", () => {
	const { rows } = buildTable(scenario());
	for (const row of rows) {
		assert.equal(row.capture, "CAPTURED", row.type);
		assert.equal(row.gate, "PASS", row.type);
		assert.equal(row.restore, "RESTORED", row.type);
	}
});

test("a destination cell that vanished reads LOST and names the cell it lost", () => {
	const input = scenario();
	input.destRows = input.destRows.filter(row => row.type !== "gate");
	const row = buildTable(input).rows.find(r => r.type === "gate");
	assert.equal(row.restore, "LOST");
	assert.equal(row.lostCells, 1);
	assert.deepEqual(row.lostSample, ["gate@4,0"]);
});

test("a different entity standing on the staged position reads WRONG, not LOST", () => {
	const input = scenario();
	input.destRows = input.destRows.map(row =>
		row.type === "gate" ? cell("wall", "stone-wall", 4, 0) : row);
	const row = buildTable(input).rows.find(r => r.type === "gate");
	assert.equal(row.restore, "WRONG");
	assert.equal(row.wrongCells, 1);
	assert.match(row.substitutions[0], /gate@4,0 -> wall\/stone-wall/);
});

test("LOST outranks WRONG so a type that lost a cell is never reported as merely wrong", () => {
	const input = scenario();
	input.sourceRows = [...input.sourceRows, cell("gate", "gate", 6, 0)];
	input.payloadRows = input.sourceRows.map(row => ({ ...row }));
	input.destRows = input.destRows.map(row => (row.type === "gate" ? cell("wall", "stone-wall", 4, 0) : row));
	const row = buildTable(input).rows.find(r => r.type === "gate");
	assert.equal(row.restore, "LOST");
	assert.equal(row.wrongCells, 1);
	assert.equal(row.lostCells, 1);
});

test("each staged cell consumes at most one destination row, so N cells need N arrivals", () => {
	const input = scenario();
	input.destRows = input.destRows.filter(row => !(row.type === "straight-rail" && row.y === -2));
	const row = buildTable(input).rows.find(r => r.type === "straight-rail");
	assert.equal(row.staged, 2);
	assert.equal(row.restoredCells, 1);
	assert.equal(row.restore, "LOST");
});

test("a type with no staged cell reports NOT_STAGED in all three columns", () => {
	const input = scenario({ types: [...TYPES, "reactor"] });
	const row = buildTable(input).rows.find(r => r.type === "reactor");
	assert.equal(row.staged, 0);
	assert.equal(row.capture, NOT_STAGED);
	assert.equal(row.gate, NOT_STAGED);
	assert.equal(row.restore, NOT_STAGED);
});

test("a payload missing some but not all cells of a type reads PARTIAL", () => {
	const input = scenario();
	input.payloadRows = input.payloadRows.filter(row => !(row.type === "straight-rail" && row.position.y === -2));
	const row = buildTable(input).rows.find(r => r.type === "straight-rail");
	assert.equal(row.capture, "PARTIAL");
	assert.equal(row.capturedCells, 1);
});

test("positions match within tolerance and the worst drift is reported, not hidden", () => {
	const input = scenario();
	input.destRows = input.destRows.map(row => ({ ...row, x: row.x + 0.4 }));
	const row = buildTable(input).rows.find(r => r.type === "accumulator");
	assert.equal(row.restore, "RESTORED");
	assert.ok(Math.abs(row.maxDrift - 0.4) < 1e-9, `drift ${row.maxDrift}`);

	const far = scenario();
	far.destRows = far.destRows.map(row => ({ ...row, x: row.x + CELL_TOLERANCE + 0.01 }));
	assert.equal(buildTable(far).rows.find(r => r.type === "accumulator").restore, "LOST");
});

test("a gate that refused a type reads REFUSED on that row and PASS on the others", () => {
	const input = scenario({
		gate: {
			validation_success: true,
			failedEntityLosses: {
				entity_count: 1,
				entities: [{ type: "gate", name: "gate", position: { x: 4, y: 0 } }],
			},
		},
	});
	const { rows } = buildTable(input);
	assert.equal(rows.find(r => r.type === "gate").gate, "REFUSED");
	assert.equal(rows.find(r => r.type === "gate").gateRefusedCells, 1);
	assert.equal(rows.find(r => r.type === "accumulator").gate, "PASS");
});

test("a capped gate detail list reads UNKNOWN, never PASS — the cap is not evidence of acceptance", () => {
	const entities = Array.from({ length: 50 }, (_, i) => ({
		type: "straight-rail", name: "straight-rail", position: { x: i, y: 99 },
	}));
	const summary = summarizeGate({ validation_success: true, failedEntityLosses: { entity_count: 71, entities } });
	assert.equal(summary.detailCapped, true);
	assert.equal(summary.refusedTotal, 71);
	assert.equal(summary.detailedTotal, 50);
	assert.equal(gateVerdictFor("accumulator", summary, 1), "UNKNOWN");
	assert.equal(gateVerdictFor("straight-rail", summary, 2), "REFUSED");

	const uncapped = summarizeGate({ validation_success: true, failedEntityLosses: { entity_count: 1, entities: [entities[0]] } });
	assert.equal(uncapped.detailCapped, false);
	assert.equal(gateVerdictFor("accumulator", uncapped, 1), "PASS");
});

test("completeness is set-based in both directions, so a dropped or swapped row fails", () => {
	const { rows } = buildTable(scenario());
	assert.equal(completeness(rows, TYPES).ok, true);

	const dropped = rows.filter(row => row.type !== "gate");
	const droppedVerdict = completeness(dropped, TYPES);
	assert.equal(droppedVerdict.ok, false);
	assert.deepEqual(droppedVerdict.missing, ["gate"]);

	const swapped = [...dropped, { ...rows[0], type: "not-a-universe-type" }];
	const swappedVerdict = completeness(swapped, TYPES);
	assert.equal(swappedVerdict.ok, false);
	assert.deepEqual(swappedVerdict.missing, ["gate"]);
	assert.deepEqual(swappedVerdict.extra, ["not-a-universe-type"]);
	assert.equal(swapped.length, TYPES.length, "a count check alone would have accepted this swap");
});

test("a duplicated row fails completeness even though every type is present", () => {
	const { rows } = buildTable(scenario());
	const verdict = completeness([...rows, rows[0]], TYPES);
	assert.equal(verdict.ok, false);
	assert.deepEqual(verdict.duplicates, ["accumulator"]);
});

test("a row carrying an unreadable cell fails completeness rather than passing quietly", () => {
	const { rows } = buildTable(scenario());
	for (const column of ["capture", "gate", "restore"]) {
		const blanked = rows.map(row => (row.type === "gate" ? { ...row, [column]: undefined } : row));
		const verdict = completeness(blanked, TYPES);
		assert.equal(verdict.ok, false, column);
		assert.equal(verdict.incomplete.length, 1);
		assert.match(verdict.incomplete[0], new RegExp(`^gate: ${column}=<undefined>$`));
	}
	const invented = rows.map(row => (row.type === "gate" ? { ...row, restore: "PROBABLY_FINE" } : row));
	assert.equal(completeness(invented, TYPES).ok, false);
});

test("the gate latch refuses a destination read taken before the gate was adjudicated", () => {
	const latch = createGateLatch();
	assert.equal(latch.adjudicated, false);
	assert.throws(() => latch.require("the destination physical read"),
		/before the gate verdict was adjudicated/);

	latch.adjudicate({ validation_success: true });
	assert.equal(latch.adjudicated, true);
	assert.equal(latch.require("the destination physical read").success, true);
});

test("the gate latch refuses to be satisfied by something that is not an import result", () => {
	const latch = createGateLatch();
	assert.throws(() => latch.adjudicate(null), /needs the import result object/);
	assert.throws(() => latch.adjudicate("SUCCESS"), /needs the import result object/);
	assert.equal(latch.adjudicated, false);
	assert.equal(latch.adjudicate({ validation_success: false }).success, false);
});

test("rows arrive from Lua as objects or arrays, and unreadable rows are dropped rather than guessed", () => {
	assert.deepEqual(normalizeRows({}), []);
	assert.deepEqual(normalizeRows(undefined), []);
	assert.deepEqual(normalizeRows({ 1: { t: "gate", n: "gate", x: 1, y: 2 } }),
		[{ type: "gate", name: "gate", x: 1, y: 2 }]);
	assert.deepEqual(normalizeRows([{ type: "gate", name: "gate", position: [1, 2] }]),
		[{ type: "gate", name: "gate", x: 1, y: 2 }]);
	assert.deepEqual(normalizeRows([{ type: "gate", name: "gate" }]), []);
});

test("matchCells and the verdict helpers agree on the empty case", () => {
	const empty = matchCells([], []);
	assert.equal(captureVerdict(empty, 0), NOT_STAGED);
	assert.equal(restoreVerdict(empty, 0), NOT_STAGED);
	assert.equal(restoreVerdict(matchCells([cell("gate", "gate", 0, 0)], []), 1), "LOST");
});

test("an unread destination reads NOT_MEASURED — never RESTORED, never LOST", () => {
	const input = scenario({
		destRows: null,
		gate: {
			failedEntityLosses: {
				entity_count: 1,
				entities: [{ type: "gate", name: "gate", position: { x: 4, y: 0 } }],
			},
		},
	});
	const { rows } = buildTable(input);
	const staged = rows.filter(row => row.staged > 0);
	assert.ok(staged.length > 0);
	for (const row of staged) assert.equal(row.restore, NOT_MEASURED, row.type);
	assert.equal(completeness(rows, TYPES).ok, true,
		"a gate-failed run must still produce a COMPLETE table on the two columns it can measure");
	assert.equal(rows.find(r => r.type === "gate").capture, "CAPTURED");
	assert.equal(rows.find(r => r.type === "gate").gate, "REFUSED");
	assert.equal(rows.find(r => r.type === "accumulator").gate, "PASS");
});

test("a type with no staged cell stays NOT_STAGED even when the destination went unread", () => {
	const input = scenario({ types: [...TYPES, "reactor"], destRows: null });
	assert.equal(buildTable(input).rows.find(r => r.type === "reactor").restore, NOT_STAGED);
});

test("restoreVerdict distinguishes 'nothing arrived' from 'nobody looked'", () => {
	const empty = matchCells([cell("gate", "gate", 0, 0)], []);
	assert.equal(restoreVerdict(empty, 1, true), "LOST");
	assert.equal(restoreVerdict(empty, 1, false), NOT_MEASURED);
});

test("the tally counts every row exactly once", () => {
	const { rows } = buildTable(scenario());
	const tally = tallyVerdicts(rows, "restore");
	assert.equal([...tally.values()].reduce((a, b) => a + b, 0), rows.length);
	assert.equal(tally.get("RESTORED"), rows.length);
});
