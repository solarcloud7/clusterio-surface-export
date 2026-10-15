import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
	DEFAULT_RADIUS_CHUNKS, EXIT_NOT_READY, GameRefusal, MAX_COMMAND_BYTES, MAX_RADIUS_CHUNKS,
	main, normalizeReport, parseArgs, parseReply, prepareCommand, rconCommand, scanCommand, verdict,
} from "../../tools/surface-export/prepare-world.mjs";

const require = createRequire(import.meta.url);
const luaparse = require("../../docker/seed-data/external_plugins/surface_export/scripts/vendor/luaparse.cjs");

function capture() {
	const text = { out: "", err: "" };
	return { text, out: { write: s => { text.out += s; } }, err: { write: s => { text.err += s; } } };
}

const prepared = { success: true, surface: "vulcanus", planet: "vulcanus", policyApplied: true, radiusChunks: 6, dryRun: false };
const clean = {
	success: true, surface: "vulcanus", planet: "vulcanus", policyApplied: true, radiusChunks: 6, radiusTiles: 192, dryRun: false,
	foundTotal: 0, destroyedTotal: 0, remainingTotal: 0, kinds: [], freePositionNear00: { x: 1.5, y: -2 }, charted: true,
};

function fakeCluster(replies, calls = []) {
	return async (cluster, fn) => fn({ ctl: (...args) => { calls.push([cluster, ...args]); return replies.shift(); } });
}

const defaults = { cluster: "dev", instance: "Sigma", radiusChunks: DEFAULT_RADIUS_CHUNKS, planet: null, dryRun: false, yes: false, help: false };

test("arguments: instance is required, a destroying run needs --yes, radius and planet are validated, repeats and strangers are refused", () => {
	assert.deepEqual(parseArgs(["--instance", "Sigma", "--yes"]), { ...defaults, yes: true });
	assert.deepEqual(parseArgs(["--instance", "Sigma", "--dry-run"]), { ...defaults, dryRun: true });
	assert.deepEqual(parseArgs(["--cluster=vm", "--instance=Dev One", "--radius-chunks", "3", "--planet", "gleba", "--dry-run", "--yes"]),
		{ cluster: "vm", instance: "Dev One", radiusChunks: 3, planet: "gleba", dryRun: true, yes: true, help: false });
	assert.equal(parseArgs(["--help"]).help, true);
	assert.throws(() => parseArgs(["--instance", "Sigma"]), /needs --yes; add --dry-run/);
	for (const argv of [[], ["--instance"], ["--instance", "--dry-run"], ["--instance=", "x"], ["Sigma", "--yes"], ["--instance", "Sigma", "--yes", "--radius"],
		["--instance", "Sigma", "--yes", "--radius-chunks", "0"], ["--instance", "Sigma", "--yes", "--radius-chunks", "2.5"],
		["--instance", "Sigma", "--yes", "--radius-chunks", String(MAX_RADIUS_CHUNKS + 1)], ["--instance", "Sigma", "--yes", "--planet", "vulcanus; game"],
		["--instance", "Sigma", "--yes", "--instance", "Theta"], ["--instance", "Sigma", "--yes", "--cluster", "vm", "--cluster", "dev"]]) {
		assert.throws(() => parseArgs(argv), Error, argv.join(" "));
	}
});

test("both commands are one-line /sc payloads under the byte cap, in Lua 5.2 syntax with lowercase_underscore locals, and carry the options", () => {
	for (const text of [prepareCommand({ radiusChunks: 6, dryRun: false }), prepareCommand({ radiusChunks: 2, planet: "gleba", dryRun: true }),
		scanCommand({ radiusChunks: 6, dryRun: false }), scanCommand({ radiusChunks: MAX_RADIUS_CHUNKS, planet: "vulcanus", dryRun: true })]) {
		assert.match(text, /^\/sc /);
		assert.ok(!text.includes("\n"));
		assert.ok(Buffer.byteLength(text, "utf8") <= MAX_COMMAND_BYTES, `${Buffer.byteLength(text, "utf8")} bytes`);
		const ast = luaparse.parse(text.slice("/sc ".length), { luaVersion: "5.2", comments: true });
		assert.deepEqual(ast.comments, [], "a flattened command cannot carry a Lua comment");
		assert.ok(!/local [a-z]*[A-Z]/.test(text), "Lua locals are lowercase_underscore");
	}
	const scan = scanCommand({ radiusChunks: 4, dryRun: true });
	assert.ok(scan.includes("local radius = 128") && scan.includes("local dry_run = true") && scan.includes("local wanted = nil"));
	assert.ok(scan.includes("get_segmented_units()") && scan.includes('force = "enemy", is_military_target = true') && scan.includes('find_non_colliding_position("character", {0, 0}, 64, 0.5)'));
	assert.ok(scan.includes('e.type ~= "segment" and e.type ~= "segmented-unit"'), "segments are handled through their segmented unit");
	assert.ok(scan.includes("partial = snapshot()"), "a Lua error returns the counts so far");
	assert.ok(scanCommand({ radiusChunks: 6, dryRun: false }).includes("local dry_run = false"));
	const dry = prepareCommand({ radiusChunks: 6, planet: "gleba", dryRun: true });
	assert.ok(dry.includes('local wanted = "gleba"') && dry.includes("request_to_generate_chunks({0, 0}, 6)"));
	assert.ok(dry.includes("local dry_run = true") && dry.includes("has no surface yet; a --yes run creates it") && dry.includes("planet.create_surface()"));
	assert.ok(prepareCommand({ radiusChunks: 6, dryRun: false }).includes("local dry_run = false"));
});

test("a command over the byte cap is refused before it is sent", () => {
	assert.doesNotThrow(() => rconCommand("rcon.print(1)"));
	assert.throws(() => rconCommand(`rcon.print("${"x".repeat(MAX_COMMAND_BYTES)}")`), /bytes; the limit is/);
});

test("the reply is the last JSON object line even with notices after it; no JSON object is an error", () => {
	assert.deepEqual(parseReply(`Sending command\n${JSON.stringify(prepared)}\n`), prepared);
	assert.deepEqual(parseReply(`${JSON.stringify(prepared)}\nWarning: something clusterioctl printed afterwards\n`), prepared);
	assert.deepEqual(parseReply(`{"success":true,"surface":"old"}\n${JSON.stringify(prepared)}`), prepared);
	assert.deepEqual(parseReply(JSON.stringify({ success: false, error: "nope" })), { success: false, error: "nope" });
	assert.throws(() => parseReply("Cannot execute command. Error: [string \"...\"]:1: unexpected symbol"), /replied without JSON/);
	assert.throws(() => parseReply(""), /replied without JSON/);
	assert.throws(() => parseReply("[1,2]"), /replied without JSON/);
	assert.throws(() => parseReply("{not json"), /replied without JSON/);
	assert.match(new GameRefusal({ success: false, error: "no planet policy is applied on this instance; pass --planet" }).message, /the game refused: no planet policy/);
	assert.equal(new GameRefusal({ success: false, error: "x", partial: {} }).partial, null);
});

test("the report keeps totals from the game, treats an empty Lua table as no names, and the verdict names what blocks readiness", () => {
	const report = normalizeReport({ ...clean, foundTotal: 3, destroyedTotal: 3, remainingTotal: 0,
		kinds: [{ kind: "unit-spawner", found: 1, destroyed: 1, remaining: 0, names: { "gleba-spawner": 1 } }, { kind: "unit", found: 2, destroyed: 2, remaining: 0, names: [] }] }, { prepareMs: 1234 });
	assert.equal(report.found, 3);
	assert.equal(report.prepareMs, 1234);
	assert.equal(report.partial, false);
	assert.deepEqual(report.kinds[1].names, {});
	assert.deepEqual(report.freePositionNear00, { x: 1.5, y: -2 });
	assert.deepEqual(verdict(report), []);
	const stale = normalizeReport({ ...clean, foundTotal: 2, destroyedTotal: 0, remainingTotal: 2, dryRun: true, freePositionNear00: false });
	assert.equal(stale.freePositionNear00, null);
	assert.equal(stale.prepareMs, null);
	const reasons = verdict(stale);
	assert.equal(reasons.length, 2);
	assert.match(reasons[0], /2 hostile entities remain inside 192 tiles of 0,0 on vulcanus \(dry run/);
	assert.match(reasons[1], /no free character position within 64 tiles/);
	assert.match(verdict(normalizeReport({ ...clean, remainingTotal: 1 }))[0], /1 hostile entity remain/);
	assert.equal(normalizeReport({ ...clean, foundTotal: undefined, kinds: [{ kind: "unit", found: 4, destroyed: 4, remaining: 0 }] }).found, 4);
});

test("a clean --yes run sends two send-rcon commands to the named instance and exits 0 with the JSON report and the generate time", async () => {
	const calls = [];
	const io = capture();
	let tick = 1000;
	const code = await main(["--cluster", "vm", "--instance", "Sigma", "--radius-chunks", "2", "--yes"],
		{ ...io, run: fakeCluster([JSON.stringify(prepared), `${JSON.stringify(clean)}\n`], calls), now: () => { tick += 2500; return tick; } });
	assert.equal(code, 0, io.text.err);
	assert.equal(calls.length, 2);
	for (const call of calls) {
		assert.deepEqual(call.slice(0, 4), ["vm", "instance", "send-rcon", "Sigma"]);
		assert.match(call[4], /^\/sc /);
	}
	assert.ok(calls[0][4].includes("request_to_generate_chunks({0, 0}, 2)") && calls[0][4].includes("local dry_run = false"));
	assert.ok(calls[1][4].includes("local radius = 64") && calls[1][4].includes("local dry_run = false"));
	const printed = JSON.parse(io.text.out);
	assert.equal(printed.remaining, 0);
	assert.equal(printed.prepareMs, 2500);
	assert.deepEqual(printed.freePositionNear00, { x: 1.5, y: -2 });
	assert.match(io.text.err, /surface vulcanus \(planet vulcanus, applied planet policy\) generated within 2 chunks of 0,0 in 2500 ms/);
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

test("--dry-run reaches both commands, a refusal by the game stops before the scan, and a mid-scan error prints the partial counts before exit 1", async () => {
	const calls = [];
	const io = capture();
	const code = await main(["--instance", "Sigma", "--dry-run", "--planet", "gleba"],
		{ ...io, run: fakeCluster([JSON.stringify({ success: false, error: "the applied planet policy names vulcanus, not gleba" })], calls) });
	assert.equal(code, 1);
	assert.equal(calls.length, 1);
	assert.ok(calls[0][4].includes('local wanted = "gleba"') && calls[0][4].includes("local dry_run = true"));
	assert.match(io.text.err, /the game refused: the applied planet policy names vulcanus, not gleba/);
	assert.equal(io.text.out, "");
	const dry = [];
	await main(["--instance", "Sigma", "--dry-run"], { ...capture(), run: fakeCluster([JSON.stringify(prepared), JSON.stringify({ ...clean, dryRun: true })], dry) });
	assert.ok(dry[1][4].includes("local dry_run = true"));
	const partial = capture();
	const failed = await main(["--instance", "Sigma", "--yes"], { ...partial, run: fakeCluster([JSON.stringify(prepared), JSON.stringify({
		success: false, error: "[string \"...\"]:1: LuaEntity API call when LuaEntity was invalid",
		partial: { ...clean, success: undefined, freePositionNear00: undefined, charted: undefined, foundTotal: 3, destroyedTotal: 1, remainingTotal: 0,
			kinds: [{ kind: "unit", found: 3, destroyed: 1, remaining: 0, names: { "small-biter": 3 } }] },
	})]) });
	assert.equal(failed, 1);
	const printed = JSON.parse(partial.text.out);
	assert.equal(printed.partial, true);
	assert.equal(printed.found, 3);
	assert.equal(printed.destroyed, 1);
	assert.equal(printed.freePositionNear00, null);
	assert.match(partial.text.err, /the game refused: .*LuaEntity was invalid/);
});

test("a cluster failure, a non-JSON reply and usage errors exit 1 and 2 without a report, and nothing is sent without --yes or --dry-run", async () => {
	let io = capture();
	assert.equal(await main(["--instance", "Sigma", "--yes"], { ...io, run: async () => { throw new Error("docker: no such container"); } }), 1);
	assert.match(io.text.err, /docker: no such container/);
	io = capture();
	assert.equal(await main(["--instance", "Sigma", "--yes"], { ...io, run: fakeCluster(["Cannot execute command. Error: nope"]) }), 1);
	assert.match(io.text.err, /replied without JSON/);
	assert.equal(io.text.out, "");
	let sent = 0;
	for (const argv of [[], ["--radius-chunks", "6"], ["--instance", "Sigma"], ["--instance", "Sigma", "--yes", "--bogus"]]) {
		io = capture();
		assert.equal(await main(argv, { ...io, run: async () => { sent += 1; } }), 2, argv.join(" "));
		assert.match(io.text.err, /^usage:/);
	}
	assert.match(io.text.err, /\(--dry-run \| --yes\)/);
	io = capture();
	assert.equal(await main(["--help"], { ...io, run: async () => { sent += 1; } }), 0);
	assert.match(io.text.out, /^usage:/);
	assert.equal(sent, 0);
});
