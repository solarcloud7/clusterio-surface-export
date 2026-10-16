import test from "node:test";
import assert from "node:assert/strict";
import {
	parseArgs, decodeBlueprint, encodeBlueprint, versionParts, versionNumber, compareVersions, summarize, chunks,
	uploadCommand, buildCommand, reviveCommand, fulfillCommand, countCommand, compare, CHUNK_CHARS, MAX_COMMAND_BYTES,
} from "../../tools/surface-export/import-blueprint.mjs";

const blueprint = {
	blueprint: {
		label: " Test ship ",
		version: versionNumber([2, 1, 22, 1]),
		entities: [
			{ entity_number: 1, name: "space-platform-hub", position: { x: 0, y: 0 } },
			{ entity_number: 2, name: "beacon", position: { x: 5.5, y: 5.5 }, items: [{ id: { name: "speed-module-3" }, items: { in_inventory: [{ inventory: 1, stack: 0 }, { inventory: 1, stack: 1, count: 1 }] } }] },
			{ entity_number: 3, name: "beacon", position: { x: 9.5, y: 5.5 } },
		],
		tiles: [{ name: "space-platform-foundation", position: { x: 0, y: 0 } }, { name: "space-platform-foundation", position: { x: 1, y: 0 } }],
	},
};

test("a blueprint string round-trips through encode and decode", () => {
	const text = encodeBlueprint(blueprint);
	assert.equal(text[0], "0");
	assert.deepEqual(decodeBlueprint(text), blueprint);
});

test("decoding refuses text that is not a single blueprint", () => {
	assert.throws(() => decodeBlueprint("1abc"), /format version 0/);
	assert.throws(() => decodeBlueprint("0not-base64-zlib"), /not a blueprint string/);
	assert.throws(() => decodeBlueprint(encodeBlueprint({ blueprint_book: { blueprints: [] } })), /expected one blueprint/);
});

test("game versions pack into the 64-bit blueprint version and compare by major, minor and patch", () => {
	assert.deepEqual(versionParts(562954249830401), [2, 1, 22, 1]);
	assert.equal(versionNumber([2, 1, 22, 1]), 562954249830401);
	assert.ok(compareVersions([2, 1, 22, 1], [2, 1, 20]) > 0);
	assert.equal(compareVersions([2, 1, 20, 5], [2, 1, 20]), 0);
	assert.ok(compareVersions([2, 0, 76], [2, 1, 20]) < 0);
});

test("the summary counts entities, foundation tiles and requested modules", () => {
	assert.deepEqual(summarize(blueprint), {
		label: "Test ship", version: "2.1.22.1",
		entities: { "space-platform-hub": 1, beacon: 2 },
		tiles: { "space-platform-foundation": 2 },
		requestedItems: { "speed-module-3": 2 },
	});
});

test("chunks reassemble to the original text and every command stays under the RCON limit", () => {
	const text = encodeBlueprint(blueprint).repeat(400);
	const parts = chunks(text);
	assert.equal(parts.join(""), text);
	assert.ok(parts.every(part => part.length <= CHUNK_CHARS));
	const commands = [
		uploadCommand(1, "A".repeat(CHUNK_CHARS)), uploadCommand(99, "A".repeat(CHUNK_CHARS)),
		buildCommand({ planet: "nauvis", name: "A long platform name used for a size check (import)", expectedChunks: 999 }),
		reviveCommand({ surface: "platform-9999", batch: 5000 }), fulfillCommand({ surface: "platform-9999", batch: 5000 }), countCommand({ surface: "platform-9999" }),
	];
	for (const command of commands) {
		assert.ok(command.startsWith("/sc "));
		assert.ok(Buffer.byteLength(command) <= MAX_COMMAND_BYTES, `${Buffer.byteLength(command)} bytes`);
	}
});

test("uploads accept only base64 so a chunk cannot break out of its Lua string", () => {
	assert.throws(() => uploadCommand(1, `abc" error("x") --`), /base64/);
});

test("the comparison reports missing and extra entities, missing modules and missing foundation", () => {
	const expected = summarize(blueprint);
	assert.deepEqual(compare(expected, { entities: { "space-platform-hub": 1, beacon: 2 }, modules: { "speed-module-3": 2 }, foundation: 2 }),
		{ missing: {}, extra: {}, modulesMissing: {}, foundationMissing: 0 });
	assert.deepEqual(compare(expected, { entities: { "space-platform-hub": 1, beacon: 1, pipe: 3 }, modules: {}, foundation: 1 }),
		{ missing: { beacon: 1 }, extra: { pipe: 3 }, modulesMissing: { "speed-module-3": 2 }, foundationMissing: 1 });
});

test("arguments require an instance, a blueprint file and --yes", () => {
	assert.throws(() => parseArgs(["--blueprint", "x", "--yes"]), /--instance/);
	assert.throws(() => parseArgs(["--instance", "Dev One", "--yes"]), /--blueprint/);
	assert.throws(() => parseArgs(["--instance", "Dev One", "--blueprint", "x"]), /--yes/);
	assert.throws(() => parseArgs(["--instance", "a", "--blueprint", "x", "--yes", "--batch", "10"]), /--batch/);
	assert.throws(() => parseArgs(["--instance", "a", "--blueprint", "x", "--yes", "--planet", "nauvis; x"]), /--planet/);
	assert.deepEqual(parseArgs(["--instance=Dev One", "--blueprint", "bp.txt", "--yes", "--planet", "vulcanus"]),
		{ cluster: "dev", instance: "Dev One", blueprint: "bp.txt", planet: "vulcanus", name: null, batch: 1500, yes: true, help: false });
});
