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

test("gallery runtime exposes bounded paired-build and inspection operations", () => {
	for (const operation of ["preflight", "normalize_source", "inspect", "prepare_destination", "save"]) {
		assert.match(source, new RegExp(`operation == [\"']${operation}[\"']`));
	}
	for (const state of ["gamePaused", "jobs", "locks", "holds", "tombstones"]) assert.match(source, new RegExp(state));
	assert.match(source, /game\.server_save/);
	assert.match(source, /game\.delete_surface/);
});

test("normalization removes broad world state and builds the first minimal space-platform fixture", () => {
	assert.match(source, /default_enable_all_autoplace_controls\s*=\s*false/);
	assert.match(source, /delete_chunk/);
	assert.match(source, /platform\.destroy\(0\)/);
	assert.match(source, /create_space_platform/);
	assert.match(source, /apply_starter_pack/);
	assert.match(source, /electric-mining-drill/);
	assert.match(source, /specialized-fluid-reachability/);
	assert.match(source, /prepare_destination/);
});

test("visual catalog, belt pilot, and reachability fixture have independent physical readings", () => {
	assert.match(source, /rendering\.draw_text/);
	assert.match(source, /add_chart_tag/);
	assert.match(source, /get_detailed_contents/);
	assert.match(source, /unique_id/);
	assert.match(source, /maximumStack == expected\.maximumStack/);
	assert.match(source, /sourceQuantity == expected\.sourceQuantity/);
	assert.match(source, /targetQuantity == expected\.targetQuantity/);
	assert.match(source, /find_entity/);
	assert.match(source, /surface\.get_property\("pressure"\)/);
	assert.match(source, /surface\.get_property\("gravity"\)/);
	assert.match(source, /#drill\.fluidbox/);
	assert.match(source, /mining_target/);
	assert.doesNotMatch(source, /insert_at_back|insert_at\(/);
});
