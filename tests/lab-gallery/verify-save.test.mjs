import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertReloadReading, parseArguments } from "./verify-save.mjs";

const source = readFileSync(new URL("./verify-save.mjs", import.meta.url), "utf8");

test("reload verifier requires a save and restricts the target container", () => {
	assert.deepEqual(parseArguments(["--save", "gallery.zip"]), {
		save: "gallery.zip", container: "surface-export-host-2",
	});
	assert.throws(() => parseArguments([]), /--save/);
	assert.throws(() => parseArguments(["--save", "gallery.zip", "--container", "unrelated"]), /container/);
});

test("reload acceptance is an exact independent physical census", () => {
	const reading = {
		version: "2.0.77", gallery_storage: true, index_surface: true,
		source_belts: 16, target_belts: 16, source_quantity: 125,
		physical_stacks: 125, maximum_stack: 1,
		source_line_quantities: [67, 58], target_quantity: 0,
		index_texts: 12, source_texts: 3, index_tags: 12, source_tags: 2,
	};
	assert.deepEqual(assertReloadReading(reading), reading);
	assert.throws(() => assertReloadReading({ ...reading, source_quantity: 124 }), /source_quantity/);
});

test("isolated verifier is time-bounded and always removes its prefix-owned runtime", () => {
	assert.match(source, /timeout/);
	assert.match(source, /finally/);
	assert.match(source, /surface-export-lab-gallery-verify/);
	assert.match(source, /rm["'],\s*["']-rf/);
});
