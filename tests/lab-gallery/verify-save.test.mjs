import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertReloadReading, parseArguments } from "./verify-save.mjs";

const source = readFileSync(new URL("./verify-save.mjs", import.meta.url), "utf8");

test("paired reload verifier requires both artifacts and an isolated host", () => {
	assert.deepEqual(parseArguments(["--source-save", "source.zip", "--destination-save", "destination.zip"]), {
		sourceSave: "source.zip", destinationSave: "destination.zip", container: "surface-export-host-2",
	});
	assert.throws(() => parseArguments(["--source-save", "source.zip"]), /destination-save/);
	assert.throws(() => parseArguments(["--destination-save", "destination.zip"]), /source-save/);
});

test("source acceptance includes both independent physical fixtures", () => {
	const reading = {
		version: "2.0.77", save_role: "source", gallery_storage: true, index_surface: true,
		game_paused: false, transient: { jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		source_belts: 16, target_belts: 16, source_quantity: 125, physical_stacks: 125,
		maximum_stack: 1, source_line_quantities: [67, 58], target_quantity: 0,
		index_texts: 12, index_tags: 12,
		reachability: { exists: true, platform_name: "lab-specialized-fluid-r1", drill_name: "electric-mining-drill", pressure: 0, gravity: 0, mining_target: null, live_fluidbox_count: 0, read_ok: false, write_ok: false },
		surface_census: { total_entities: 34, total_generated_chunks: 248, surface_names: ["lab-gallery-index-v2", "nauvis", "platform-2"] },
	};
	assert.equal(assertReloadReading(reading, "source"), reading);
	assert.throws(() => assertReloadReading({ ...reading, source_quantity: 124 }, "source"), /source_quantity/);
	assert.throws(() => assertReloadReading({ ...reading, reachability: { ...reading.reachability, read_ok: true } }, "source"), /read_ok/);
});

test("destination acceptance proves the paired absence contract", () => {
	const reading = {
		version: "2.0.77", save_role: "destination", gallery_storage: true, index_surface: true,
		game_paused: false, transient: { jobs: 0, locks: 0, holds: 0, tombstones: 0 },
		source_belts: 0, target_belts: 0, source_quantity: 0, physical_stacks: 0,
		maximum_stack: 0, source_line_quantities: [0, 0], target_quantity: 0,
		index_texts: 12, index_tags: 12, reachability: { exists: false },
		surface_census: { total_entities: 0, total_generated_chunks: 92, surface_names: ["lab-gallery-index-v2", "nauvis"] },
	};
	assert.equal(assertReloadReading(reading, "destination"), reading);
	assert.throws(() => assertReloadReading({ ...reading, reachability: { exists: true } }, "destination"), /exists/);
});

test("isolated verifier reloads each save and always removes its runtime", () => {
	assert.match(source, /for \(const role of \["source", "destination"\]\)/);
	assert.match(source, /--start-server/);
	assert.match(source, /finally/);
	assert.match(source, /surface-export-lab-gallery-verify/);
	assert.doesNotMatch(source, /clusterioctl|send-rcon|game\.tick_paused\s*=/);
});
