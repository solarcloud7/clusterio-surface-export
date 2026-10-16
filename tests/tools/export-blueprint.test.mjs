import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, createCommand, readCommand, clearCommand, normalizeToHub, READ_CHARS } from "../../tools/surface-export/export-blueprint.mjs";
import { MAX_COMMAND_BYTES } from "../../tools/surface-export/import-blueprint.mjs";

test("arguments require an instance, a platform and an output file", () => {
	assert.throws(() => parseArgs(["--platform", "1", "--out", "x"]), /--instance/);
	assert.throws(() => parseArgs(["--instance", "a", "--out", "x"]), /--platform/);
	assert.throws(() => parseArgs(["--instance", "a", "--platform", "1"]), /--out/);
	assert.throws(() => parseArgs(["--instance", "a", "--platform", "1", "--out", "x", "--yes"]), /unsupported/);
	assert.deepEqual(parseArgs(["--instance=Dev One", "--platform", "COMMON roundtrip", "--out", "bp.txt"]),
		{ cluster: "dev", instance: "Dev One", platform: "COMMON roundtrip", out: "bp.txt", help: false });
});

test("a numeric platform selects by index and anything else by exact name", () => {
	assert.match(createCommand({ platform: "125" }), /p\.index == 125/);
	assert.match(createCommand({ platform: "Ship \"A\"" }), /p\.name == "Ship \\"A\\""/);
});

test("every command stays under the RCON limit and reads fixed-size parts", () => {
	for (const command of [createCommand({ platform: "A long platform name used for a size check (import)" }), readCommand(9_999_999), clearCommand()]) {
		assert.ok(command.startsWith("/sc "));
		assert.ok(Buffer.byteLength(command) <= MAX_COMMAND_BYTES);
	}
	assert.match(readCommand(1), new RegExp(`string\\.sub\\(text, 1, ${READ_CHARS}\\)`));
});

test("normalizing moves the hub to 0,0 and shifts tiles by the same whole-tile amount", () => {
	const json = { blueprint: {
		entities: [{ name: "space-platform-hub", position: { x: 12, y: -40 } }, { name: "beacon", position: { x: 15.5, y: -35.5 } }],
		tiles: [{ name: "space-platform-foundation", position: { x: 10, y: -43 } }],
	} };
	assert.deepEqual(normalizeToHub(json), { dx: 12, dy: -40 });
	assert.deepEqual(json.blueprint.entities.map(e => e.position), [{ x: 0, y: 0 }, { x: 3.5, y: 4.5 }]);
	assert.deepEqual(json.blueprint.tiles[0].position, { x: -2, y: -3 });
	assert.throws(() => normalizeToHub({ blueprint: { entities: [{ name: "beacon", position: { x: 0, y: 0 } }] } }), /space-platform-hub/);
});
