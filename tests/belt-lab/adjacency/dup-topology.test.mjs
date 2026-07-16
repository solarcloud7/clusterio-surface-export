import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	assertDeterministicObservations,
	assertExactConstruction,
	buildDupTopology,
	certifyGeometryControls,
	constructionDescriptors,
	maximumLineNodes,
	projectDetailedContentReads,
} from "./dup-topology.mjs";
import * as topology from "./dup-topology.mjs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/replay_payload_DUP-233855.json", import.meta.url), "utf8"));

test("construction descriptors preserve all 596 belt entities and topology-affecting fields", () => {
	const descriptors = constructionDescriptors(fixture);
	assert.equal(descriptors.length, 596);
	assert.deepEqual(descriptors.find(row => row.entityId === 64990), {
		entityId: 64990,
		name: "turbo-underground-belt",
		type: "underground-belt",
		position: { x: -17.5, y: -22.5 },
		direction: 0,
		force: "player",
		quality: undefined,
		undergroundType: "input",
		expectsPartner: true,
		splitterFilter: undefined,
		inputPriority: undefined,
		outputPriority: undefined,
	});
});

test("transport-line roles are explicit per entity type despite aliased define values", () => {
	assert.equal(typeof topology.roleForEntityLine, "function");
	assert.equal(topology.roleForEntityLine("underground-belt", 3), "left_underground_line");
	assert.equal(topology.roleForEntityLine("splitter", 3), "secondary_left_line");
	assert.equal(topology.roleForEntityLine("underground-belt", 4), "right_underground_line");
	assert.equal(topology.roleForEntityLine("splitter", 4), "secondary_right_line");
	assert.throws(() => topology.roleForEntityLine("transport-belt", 3), /unsupported transport line/);
});

test("observation normalization assigns roles from entity type and line index", () => {
	assert.equal(typeof topology.normalizeObservationRoles, "function");
	const normalized = topology.normalizeObservationRoles({ entities: [
		{ entityId: "u", type: "underground-belt", lines: [{ index: 3, role: "secondary_left_line" }] },
		{ entityId: "s", type: "splitter", lines: [{ index: 3, role: "left_underground_line" }] },
	] });
	assert.equal(normalized.entities[0].lines[0].role, "left_underground_line");
	assert.equal(normalized.entities[1].lines[0].role, "secondary_left_line");
});

test("configured splitter descriptors use one field name through construction comparison", () => {
	const descriptor = constructionDescriptors({ entities: [{
		entity_id: 9, name: "splitter", type: "splitter", position: { x: 1, y: 2 }, direction: 2,
		specific_data: { filter: "iron-plate", input_priority: "left", output_priority: "right" },
	}] })[0];
	assert.equal(descriptor.splitterFilter, "iron-plate");
	assert.equal(Object.hasOwn(descriptor, "filter"), false);
	assert.doesNotThrow(() => assertExactConstruction([descriptor], [{ ...descriptor, unitNumber: 123, lines: [] }]));
});

test("exact construction rejects missing, duplicate, or structurally changed entities", () => {
	const expected = constructionDescriptors(fixture).slice(0, 2);
	const actual = expected.map((row, index) => ({ ...row, unitNumber: index + 1 }));
	assert.doesNotThrow(() => assertExactConstruction(expected, actual));
	assert.throws(() => assertExactConstruction(expected, actual.slice(1)), /construction mismatch/);
	assert.throws(() => assertExactConstruction(expected, [...actual, actual[0]]), /duplicate observed entity/);
	assert.throws(() => assertExactConstruction(expected, [{ ...actual[0], direction: 4 }, actual[1]]), error => {
		assert.match(error.message, /construction mismatch/);
		assert.deepEqual(error.details.changedEntities, [String(expected[0].entityId)]);
		return true;
	});
});

test("repeated graph observations must have identical canonical signatures", () => {
	const observation = { tick: 1, profiler: "Duration: 1ms", entities: [{ entityId: "1", unitNumber: 10, lines: [{ index: 1, role: "left_line" }] }] };
	const second = structuredClone(observation);
	second.tick = 2;
	second.profiler = "Duration: 2ms";
	second.entities[0].unitNumber = 99;
	assert.equal(assertDeterministicObservations([observation, second, structuredClone(second)]).runs, 3);
	const changed = structuredClone(observation);
	changed.entities[0].lines[0].role = "right_line";
	assert.throws(() => assertDeterministicObservations([observation, changed]), error => {
		assert.match(error.message, /nondeterministic empty-target graph/);
		assert.deepEqual(error.details.changedEntities, ["1"]);
		return true;
	});
});

test("DUP topology maps known endpoints and forbids backward sibling-merge movement", () => {
	const geometry = { start: { x: 0, y: 0 }, finish: { x: 1, y: 0 } };
	const observed = {
		entities: [
			{ entityId: "65243", type: "transport-belt", inputs: [], outputs: ["70000"], lines: [
				{ index: 1, role: "left_line", geometry },
				{ index: 2, role: "right_line", geometry },
			] },
			{ entityId: "65907", type: "transport-belt", inputs: [], outputs: ["70000"], lines: [
				{ index: 1, role: "left_line", geometry },
				{ index: 2, role: "right_line", geometry },
			] },
			{ entityId: "70000", type: "transport-belt", inputs: ["65243", "65907"], outputs: [], lines: [
				{ index: 1, role: "left_line", geometry },
				{ index: 2, role: "right_line", geometry },
			] },
		],
	};
	const result = buildDupTopology(observed, ["65243:1", "65243:2", "65907:2"]);
	assert.equal(result.knownEndpoints.length, 3);
	assert.deepEqual(result.graph.routes["65243:left_line"], ["65243:left_line", "70000:left_line"]);
	assert.ok(!result.graph.routes["65243:left_line"].includes("65907:left_line"));
});

test("configured splitter rejects its weak network", () => {
	const observed = { entities: [{
		entityId: "9", type: "splitter", inputs: [], outputs: [], splitterFilter: "iron-plate",
		inputPriority: "none", outputPriority: "none",
		lines: [{ index: 1, role: "left_line", geometry: { token: "a" } }],
	}] };
	const result = buildDupTopology(observed, []);
	assert.equal(result.graph.supported, false);
	assert.match(JSON.stringify(result.graph.unsupportedNetworks), /configured splitter 9/);
});

test("empty Lua neighbour sequences serialized as objects are normalized", () => {
	const observed = { entities: [{
		entityId: "1", type: "transport-belt", inputs: {}, outputs: {},
		lines: [{ index: 1, role: "left_line", geometry: { start: { x: 0, y: 0 }, finish: { x: 1, y: 0 } } }],
	}] };
	assert.doesNotThrow(() => buildDupTopology(observed, []));
});

test("equidistant same-side transition candidates are ambiguous and unsupported", () => {
	const geometry = (start, finish) => ({ start: { x: start, y: 0 }, finish: { x: finish, y: 0 } });
	const observed = { entities: [
		{ entityId: "1", type: "transport-belt", inputs: [], outputs: ["2"], lines: [
			{ index: 1, role: "left_line", geometry: geometry(0, 1) },
		] },
		{ entityId: "2", type: "splitter", inputs: ["1"], outputs: [], inputPriority: "none", outputPriority: "none", lines: [
			{ index: 1, role: "left_line", geometry: geometry(2, 3) },
			{ index: 3, role: "secondary_left_line", geometry: geometry(2, 3) },
		] },
	] };
	const result = buildDupTopology(observed, []);
	assert.equal(result.graph.supported, false);
	assert.match(result.graph.reasons.join("\n"), /ambiguous transition 1:left_line->2/);
});

test("R0 read projection counts only its three empty-target censuses", () => {
	assert.equal(maximumLineNodes(fixture), 1490);
	assert.equal(projectDetailedContentReads({ observationRuns: 3, maximumLineNodes: 1490 }), 4470);
	assert.throws(() => projectDetailedContentReads({ observationRuns: 4000, maximumLineNodes: 1490 }), /5000000/);
});

test("geometry controls require straight, corner, splitter, and paired underground evidence", () => {
	const line = index => ({ index, role: index === 1 ? "left_line" : "right_line", geometry: {
		lineLength: 1, start: { x: 0, y: 0 }, finish: { x: 1, y: 0 },
		startInsert: { line: index, position: 0 }, finishInsert: { line: index, position: 1 },
	} });
	const observation = { entities: [
		{ entityId: "1", type: "transport-belt", beltShape: "straight", lines: [line(1), line(2)] },
		{ entityId: "2", type: "transport-belt", beltShape: "left", lines: [line(1), line(2)] },
		{ entityId: "3", type: "splitter", beltShape: "straight", lines: [line(1), line(2)] },
		{ entityId: "4", type: "underground-belt", expectsPartner: true, undergroundPartner: "5", lines: [line(1), line(2)] },
		{ entityId: "5", type: "underground-belt", expectsPartner: true, undergroundPartner: "4", lines: [line(1), line(2)] },
		{ entityId: "6", type: "underground-belt", expectsPartner: false, lines: [line(1), line(2)] },
	] };
	assert.deepEqual(certifyGeometryControls(observation), { corners: 1, splitters: 1, straight: 1, undergroundPairs: 1, lines: 12, insertRemaps: 0, remapExamples: [] });
	assert.throws(() => certifyGeometryControls({ entities: observation.entities.slice(0, 1) }), /missing corner geometry control/);
	observation.entities[0].lines[0].geometry.finishInsert.line = 2;
	const remapped = certifyGeometryControls(observation);
	assert.equal(remapped.insertRemaps, 1);
	assert.deepEqual(remapped.remapExamples, [{ entityId: "1", line: 1, startInsertLine: 1, finishInsertLine: 2 }]);
});
