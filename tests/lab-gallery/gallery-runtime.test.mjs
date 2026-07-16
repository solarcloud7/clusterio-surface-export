import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./gallery-runtime.lua", import.meta.url), "utf8");

test("gallery runtime is prefix-owned, version-pinned, and never changes pause ownership", () => {
	assert.match(source, /lab-gallery-/);
	assert.match(source, /2\.0\.77/);
	assert.doesNotMatch(source, /game\.tick_paused\s*=/);
	assert.doesNotMatch(source, /clone|spill_item_stack|remote\.call/);
});

test("gallery runtime exposes bounded preflight, build, inspect, finalize, save, and cleanup operations", () => {
	for (const operation of ["preflight", "build", "inspect", "finalize", "save", "cleanup"]) {
		assert.match(source, new RegExp(`operation == [\"']${operation}[\"']`));
	}
	for (const state of ["gamePaused", "jobs", "locks", "holds", "tombstones"]) assert.match(source, new RegExp(state));
	assert.match(source, /game\.server_save/);
	assert.match(source, /game\.delete_surface/);
});

test("visual catalog and belt pilot are grounded by physical unique-id census", () => {
	assert.match(source, /rendering\.draw_text/);
	assert.match(source, /add_chart_tag/);
	assert.match(source, /get_detailed_contents/);
	assert.match(source, /unique_id/);
	assert.match(source, /maximumStack == expected\.maximumStack/);
	assert.match(source, /sourceQuantity == expected\.sourceQuantity/);
	assert.match(source, /targetQuantity == expected\.targetQuantity/);
	assert.match(source, /find_entity/);
	assert.doesNotMatch(source, /insert_at_back|insert_at\(/);
});
