import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("./run-pr0c.mjs", import.meta.url), "utf8");
const notebook = readFileSync(new URL("./NOTEBOOK.md", import.meta.url), "utf8");

test("runner prepares a real held destination and visible control", () => {
	assert.match(script, /force\.create_space_platform/);
	assert.match(script, /visible-control/);
	assert.match(script, /held-destination/);
	assert.match(script, /destination_hold_json/);
	assert.match(script, /"stage"/);
	assert.match(script, /force\.set_surface_hidden\(platform\.surface, false\)/);
});

test("runner emits the connected-player observation checklist and expected safe results", () => {
	assert.match(script, /manualObservationChecklist/);
	assert.match(script, /space-platform-list/);
	assert.match(script, /remote-view-picker-map-search/);
	assert.match(script, /direct-references/);
	assert.match(script, /attempted-interaction/);
	assert.match(script, /expectedSafeResults/);
	assert.match(script, /unsafe_blocker/);
});

test("runner has reset and zero-leftover checks for lab state", () => {
	assert.match(script, /storage\.hidden_semantics_lab = nil/);
	assert.match(script, /storage\.destination_holds/);
	assert.match(script, /hidden-semantics-lab-/);
	assert.match(script, /zero_storage/);
	assert.match(script, /zero_surfaces/);
	assert.match(script, /game\.tick_paused = false/);
	assert.match(script, /step-tick 2/);
	assert.match(script, /post_tick/);
});

test("notebook records exact semi-manual procedure and expected results", () => {
	assert.match(notebook, /Manual Observation Checklist/);
	assert.match(notebook, /Space platform list/);
	assert.match(notebook, /Remote view picker\/map search/);
	assert.match(notebook, /Expected Safe Results/);
	assert.match(notebook, /unsafe exposure/);
	assert.match(notebook, /Result Template/);
});
