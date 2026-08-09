import assert from "node:assert/strict";
import test from "node:test";

import { inspectPayloadObject } from "../../tools/tests/testkit/export-inspect.mjs";

const PAYLOAD = {
	platform_name: "fixture", schema_version: "2.0.0", factorio_version: "2.1.11",
	tiles: [{}, {}], fluid_segments: [{}],
	platform: { schedule: { records: [1, 2], interrupts: [{ name: "lab-interrupt" }] } },
	entities: [
		{ name: "infinity-pipe", type: "pipe", position: { x: 40.5, y: 46.5 },
			infinity_pipe_filter: { name: "fusion-plasma", temperature: 1000000 },
			specific_data: { fluidboxes: [{ name: "fusion-plasma" }] } },
		{ name: "heat-pipe", type: "heat-pipe", position: { x: 42.5, y: -13.5 },
			specific_data: { temperature: 500 } },
		{ name: "beacon", type: "beacon", position: { x: 40.5, y: 26.5 },
			specific_data: { energy: 0 } },
		{ name: "twin", type: "container", position: { x: 0, y: 1 }, specific_data: {} },
		{ name: "twin", type: "container", position: { x: 0, y: -1 }, specific_data: {} },
	],
};

const inspector = inspectPayloadObject(PAYLOAD);

test("an exactly-placed anchor resolves with zero delta", () => {
	const hit = inspector.resolveAnchor({ entity: "infinity-pipe", x: 40.5, y: 46.5 });
	assert.equal(hit.ok, true);
	assert.equal(hit.delta, 0);
	assert.equal(hit.ambiguous, false);
});

test("a tile-corner anchor still resolves — the manifest mixes coordinate conventions", () => {
	const hit = inspector.resolveAnchor({ entity: "heat-pipe", x: 43, y: -13 });
	assert.equal(hit.ok, true);
	assert.ok(Math.abs(hit.delta - 0.707) < 0.01, `delta ${hit.delta}`);
});

test("an anchor naming an entity that is not in the payload does NOT resolve", () => {
	const hit = inspector.resolveAnchor({ entity: "infinity-chest", x: 19.5, y: 45.5 });
	assert.equal(hit.ok, false);
	assert.equal(hit.reason, "no-such-entity-in-payload");
	assert.equal(hit.record, null);
});

test("two equidistant same-name entities are reported AMBIGUOUS, not silently picked", () => {
	const hit = inspector.resolveAnchor({ entity: "twin", x: 0, y: 0 });
	assert.equal(hit.ok, true);
	assert.equal(hit.ambiguous, true, "an anchor equidistant from two same-name entities identifies neither");
});

test("a present field never reports as survivable", () => {
	const result = inspector.field({ entity: "heat-pipe", x: 43, y: -13 }, "specific_data.temperature");
	assert.equal(result.inPayload, true);
	assert.equal(result.value, 500);
	assert.equal(result.restorationTested, false);
});

test("a WRONG query path is distinguishable from a real omission", () => {
	const wrong = inspector.field({ entity: "infinity-pipe", x: 40.5, y: 46.5 }, "specific_data.infinity_pipe_filter");
	assert.equal(wrong.inPayload, false);
	assert.deepEqual(wrong.pathHints, ["infinity_pipe_filter"], "must point at where the field really lives");

	const real = inspector.field({ entity: "beacon", x: 40.5, y: 26.5 }, "specific_data.inventories");
	assert.equal(real.inPayload, false);
	assert.deepEqual(real.pathHints, [], "a genuine omission has no alternative route");
	assert.deepEqual(real.availableKeys, ["energy"], "and reports what WAS there, so the miss is diagnosable");
});

test("an unresolved anchor yields inPayload null, never false", () => {
	const result = inspector.field({ entity: "infinity-chest", x: 19.5, y: 45.5 }, "infinity_filters");
	assert.equal(result.anchorResolved, false);
	assert.equal(result.inPayload, null);
	assert.equal(result.restorationTested, false);
});

test("summary reports the platform-scoped facts a pad cannot carry", () => {
	const s = inspector.summary();
	assert.equal(s.platform, "fixture");
	assert.equal(s.entities, 5);
	assert.equal(s.scheduleRecords, 2);
	assert.equal(s.scheduleInterrupts, 1);
	assert.equal(s.fluidSegments, 1);
});

test("countsByType covers the anchorless fixtures", () => {
	const counts = inspector.countsByType();
	assert.equal(counts.container, 2);
	assert.equal(counts.beacon, 1);
});

test("INVARIANT: every suggested pathHint itself resolves, and never equals the failed query", () => {
	const missCases = [
		{ anchor: { entity: "infinity-pipe", x: 40.5, y: 46.5 }, query: "specific_data.infinity_pipe_filter" },
		{ anchor: { entity: "heat-pipe", x: 43, y: -13 }, query: "platform.temperature" },
		{ anchor: { entity: "infinity-pipe", x: 40.5, y: 46.5 }, query: "specific_data.name" },
	];
	let hintsSeen = 0;
	for (const { anchor, query } of missCases) {
		const res = inspector.field(anchor, query);
		assert.equal(res.inPayload, false, `'${query}' is a deliberate miss`);
		for (const hint of res.pathHints ?? []) {
			hintsSeen++;
			assert.notEqual(hint, query, `a hint must never equal the failed query ('${hint}')`);
			const followed = inspector.field(anchor, hint);
			assert.equal(followed.inPayload, true,
				`suggested hint '${hint}' for failed query '${query}' must itself resolve`);
		}
	}
	assert.ok(hintsSeen >= 3,
		`expected hints across the miss cases (got ${hintsSeen}) - a hint feature that stopped `
		+ "emitting would leave this property vacuously green");
});
