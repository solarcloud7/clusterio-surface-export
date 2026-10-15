import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
	DEFAULT_RADIUS_CHUNKS, EXIT_NOT_READY, MAX_COMMAND_BYTES, MAX_RADIUS_CHUNKS,
	main, normalizeReport, parseArgs, parseReply, prepareCommand, scanCommand, verdict,
} from "../../tools/surface-export/prepare-world.mjs";

const require = createRequire(import.meta.url);
const luaparse = require("../../docker/seed-data/external_plugins/surface_export/scripts/vendor/luaparse.cjs");

function capture() {
	const text = { out: "", err: "" };
	return { text, out: { write: s => { text.out += s; } }, err: { write: s => { text.err += s; } } };
}

const prepared = { success: true, surface: "vulcanus", planet: "vulcanus", policyApplied: true, radiusChunks: 6 };
const clean = {
	success: true, surface: "vulcanus", planet: "vulcanus", policyApplied: true, radiusChunks: 6, radiusTiles: 192, dryRun: false,
	foundTotal: 0, destroyedTotal: 0, remainingTotal: 0, kinds: [], freePositionNear00: { x: 1.5, y: -2 }, charted: true,
};

function fakeCluster(replies, calls = []) {
	return async (cluster, fn) => fn({ ctl: (...args) => { calls.push([cluster, ...args]); return replies.shift(); } });
}

test("arguments: instance is required, radius and planet are validated, repeats and strangers are refused", () => {
	assert.deepEqual(parseArgs(["--instance", "Sigma"]),
		{ cluster: "dev", instance: "Sigma", radiusChunks: DEFAULT_RADIUS_CHUNKS, planet: null, dryRun: false, help: false });
	assert.deepEqual(parseArgs(["--cluster=vm", "--instance=Dev One", "--radius-chunks", "3", "--planet", "gleba", "--dry-run"]),
		{ cluster: "vm", instance: "Dev One", radiusChunks: 3, planet: "gleba", dryRun: true, help: false });
	assert.equal(parseArgs(["--help"]).help, true);
	for (const argv of [[], ["--instance"], ["--instance", "--dry-run"], ["--instance=", "x"], ["Sigma"], ["--instance", "Sigma", "--radius"],
		["--instance", "Sigma", "--radius-chunks", "0"], ["--instance", "Sigma", "--radius-chunks", "2.5"],
		["--instance", "Sigma", "--radius-chunks", String(MAX_RADIUS_CHUNKS + 1)], ["--instance", "Sigma", "--planet", "vulcanus; game"],
		["--instance", "Sigma", "--instance", "Theta"], ["--instance", "Sigma", "--cluster", "vm", "--cluster", "dev"]]) {
		assert.throws(() => parseArgs(argv), Error, argv.join(" "));
	}
});

test("both commands are one-line /sc payloads under the byte cap, in Lua 5.2 syntax, and carry the options", () => {
	for (const text of [prepareCommand({ radiusChunks: 6 }), prepareCommand({ radiusChunks: 2, planet: "gleba" }),
		scanCommand({ radiusChunks: 6, dryRun: false }), scanCommand({ radiusChunks: MAX_RADIUS_CHUNKS, planet: "vulcanus", dryRun: true })]) {
		assert.match(text, /^\/sc /);
		assert.ok(!text.includes("\n"));
		assert.ok(Buffer.byteLength(text, "utf8") <= MAX_COMMAND_BYTES, `${Buffer.byteLength(text, "utf8")} bytes`);
		const ast = luaparse.parse(text.slice("/sc ".length), { luaVersion: "5.2", comments: true });
		assert.deepEqual(ast.comments, [], "a flattened command cannot carry a Lua comment");
	}
	const scan = scanCommand({ radiusChunks: 4, dryRun: true });
	assert.ok(scan.includes("local R = 128") && scan.includes("local dry = true") && scan.includes("local wanted = nil"));
	assert.ok(scan.includes("get_segmented_units()") && scan.includes('force = "enemy", is_military_target = true') && scan.includes('find_non_colliding_position("character", {0, 0}, 64, 0.5)'));
	assert.ok(scan.includes('e.type ~= "segment" and e.type ~= "segmented-unit"'), "segments are handled through their segmented unit");
	const explicit = prepareCommand({ radiusChunks: 6, planet: "gleba" });
	assert.ok(explicit.includes('local wanted = "gleba"') && explicit.includes("request_to_generate_chunks({0, 0}, 6)"));
	assert.ok(explicit.includes("planet.surface or planet.create_surface()"));
	assert.ok(scanCommand({ radiusChunks: 6, dryRun: false }).includes("local dry = false"));
});

test("the reply is the last JSON line; non-JSON and refusals become errors", () => {
	assert.deepEqual(parseReply(`Sending command\n${JSON.stringify(prepared)}\n`), prepared);
	assert.throws(() => parseReply("Cannot execute command. Error: [string \"...\"]:1: unexpected symbol"), /replied without JSON/);
	assert.throws(() => parseReply(""), /replied without JSON/);
	assert.throws(() => parseReply("[1,2]"), /replied with/);
	assert.throws(() => parseReply(JSON.stringify({ success: false, error: "no planet policy is applied on this instance; pass --planet" })),
		/the game refused: no planet policy is applied/);
});

test("the report keeps totals from the game, treats an empty Lua table as no names, and the verdict names what blocks readiness", () => {
	const report = normalizeReport({ ...clean, foundTotal: 3, destroyedTotal: 3, remainingTotal: 0,
		kinds: [{ kind: "unit-spawner", found: 1, destroyed: 1, remaining: 0, names: { "gleba-spawner": 1 } }, { kind: "unit", found: 2, destroyed: 2, remaining: 0, names: [] }] });
	assert.equal(report.found, 3);
	assert.deepEqual(report.kinds[1].names, {});
	assert.deepEqual(report.freePositionNear00, { x: 1.5, y: -2 });
	assert.deepEqual(verdict(report), []);
	const stale = normalizeReport({ ...clean, foundTotal: 2, destroyedTotal: 0, remainingTotal: 2, dryRun: true, freePositionNear00: false });
	assert.equal(stale.freePositionNear00, null);
	const reasons = verdict(stale);
	assert.equal(reasons.length, 2);
	assert.match(reasons[0], /2 hostile entities remain inside 192 tiles of 0,0 on vulcanus \(dry run/);
	assert.match(reasons[1], /no free character position within 64 tiles/);
	assert.match(verdict(normalizeReport({ ...clean, remainingTotal: 1 }))[0], /1 hostile entity remain/);
	assert.equal(normalizeReport({ ...clean, foundTotal: undefined, kinds: [{ kind: "unit", found: 4, destroyed: 4, remaining: 0 }] }).found, 4);
});

test("a clean world sends two send-rcon commands to the named instance and exits 0 with the JSON report", async () => {
	const calls = [];
	const io = capture();
	const code = await main(["--cluster", "vm", "--instance", "Sigma", "--radius-chunks", "2"],
		{ ...io, run: fakeCluster([JSON.stringify(prepared), `${JSON.stringify(clean)}\n`], calls) });
	assert.equal(code, 0, io.text.err);
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.deepEqual(call.slice(0, 4), ["vm", "instance", "send-rcon", "Sigma"]);
		assert.match(call[4], /^\/sc /);
	}
	assert.ok(calls[0][4].includes("request_to_generate_chunks({0, 0}, 2)"));
	assert.ok(calls[1][4].includes("local R = 64") && calls[1][4].includes("local dry = false"));
	const printed = JSON.parse(io.text.out);
	assert.equal(printed.remaining, 0);
	assert.deepEqual(printed.freePositionNear00, { x: 1.5, y: -2 });
	assert.match(io.text.err, /surface vulcanus \(planet vulcanus, applied planet policy\)/);
	assert.ok(!io.text.err.includes("NOT READY"));
});

test("remaining hostiles or a missing arrival position exit non-zero after printing the report", async () => {
	for (const [reply, pattern] of [
		[{ ...clean, foundTotal: 5, destroyedTotal: 0, remainingTotal: 5, dryRun: true, kinds: [{ kind: "segmented-unit", found: 5, destroyed: 0, remaining: 5, names: { "small-demolisher": 5 } }] }, /5 hostile entities remain .*dry run/],
		[{ ...clean, foundTotal: 2, destroyedTotal: 1, remainingTotal: 1, kinds: [{ kind: "unit", found: 2, destroyed: 1, remaining: 1, names: { "small-biter": 2 } }] }, /1 hostile entity remain/],
		[{ ...clean, freePositionNear00: false }, /no free character position/],
	]) {
		const io = capture();
		const code = await main(["--instance", "Sigma", "--dry-run"], { ...io, run: fakeCluster([JSON.stringify(prepared), JSON.stringify(reply)]) });
		assert.equal(code, EXIT_NOT_READY);
		assert.equal(JSON.parse(io.text.out).surface, "vulcanus");
		assert.match(io.text.err, pattern);
		assert.match(io.text.err, /NOT READY/);
	}
});

test("--dry-run reaches the scan command and a refusal by the game stops before the scan", async () => {
	const calls = [];
	const io = capture();
	const code = await main(["--instance", "Sigma", "--dry-run", "--planet", "gleba"],
		{ ...io, run: fakeCluster([JSON.stringify({ success: false, error: "the applied planet policy names vulcanus, not gleba" })], calls) });
	assert.equal(code, 1);
	assert.equal(calls.length, 1);
	assert.ok(calls[0][4].includes('local wanted = "gleba"'));
	assert.match(io.text.err, /the game refused: the applied planet policy names vulcanus, not gleba/);
	assert.equal(io.text.out, "");
	const dry = [];
	await main(["--instance", "Sigma", "--dry-run"], { ...capture(), run: fakeCluster([JSON.stringify(prepared), JSON.stringify({ ...clean, dryRun: true })], dry) });
	assert.ok(dry[1][4].includes("local dry = true"));
});

test("a cluster failure, a non-JSON reply and usage errors exit 1 and 2 without a report", async () => {
	let io = capture();
	assert.equal(await main(["--instance", "Sigma"], { ...io, run: async () => { throw new Error("docker: no such container"); } }), 1);
	assert.match(io.text.err, /docker: no such container/);
	io = capture();
	assert.equal(await main(["--instance", "Sigma"], { ...io, run: fakeCluster(["Cannot execute command. Error: nope"]) }), 1);
	assert.match(io.text.err, /replied without JSON/);
	assert.equal(io.text.out, "");
	let sent = 0;
	for (const argv of [[], ["--radius-chunks", "6"], ["--instance", "Sigma", "--bogus"]]) {
		io = capture();
		assert.equal(await main(argv, { ...io, run: async () => { sent += 1; } }), 2, argv.join(" "));
		assert.match(io.text.err, /^usage:/);
	}
	io = capture();
	assert.equal(await main(["--help"], { ...io, run: async () => { sent += 1; } }), 0);
	assert.match(io.text.out, /^usage:/);
	assert.equal(sent, 0);
});
