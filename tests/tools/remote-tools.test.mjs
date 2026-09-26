import test from "node:test";
import assert from "node:assert/strict";
import { parseInstanceList, readRemoteCluster, withCluster } from "../../tools/shared/remote-cluster.mjs";
import { isReadOnly, main as ctlMain } from "../../tools/clusterio/ctl.mjs";
import { diffSnapshots, snapshotLua, takeSnapshot } from "../../tools/surface-export/player-state.mjs";

const TOKEN = "secret-token-value";
function sink() { const parts = []; return { write: text => parts.push(text), text: () => parts.join("") }; }

test("remote cluster config reads a token file and names the missing file without leaking values", () => {
	const files = { "clusters.json": JSON.stringify({ vm: { url: "https://vm.example/", tokenFile: "token.txt" } }), "token.txt": `${TOKEN}\n` };
	const options = { file: "clusters.json", read: name => files[name], exists: name => name in files };
	assert.deepEqual(readRemoteCluster("vm", options), { url: "https://vm.example/", token: TOKEN });
	assert.throws(() => readRemoteCluster("vm", { ...options, exists: () => false }), /is missing/);
	assert.throws(() => readRemoteCluster("other", options), /No cluster "other".*Known: vm/);
	const noToken = { ...options, read: () => JSON.stringify({ vm: { url: "https://vm.example/" } }) };
	assert.throws(() => readRemoteCluster("vm", noToken), /needs a "token", "tokenFile" or "controlConfig"/);
	const control = { "c.json": JSON.stringify({ vm: { url: "https://vm.example/", controlConfig: "control.json" } }),
		"control.json": "﻿" + JSON.stringify({ "control.controller_url": "http://internal:8080/", "control.controller_token": TOKEN }) };
	assert.deepEqual(readRemoteCluster("vm", { file: "c.json", read: name => control[name], exists: name => name in control }),
		{ url: "https://vm.example/", token: TOKEN }, "a copied control config supplies the token, even with a byte-order mark");
});

test("a remote cluster call writes a private temporary config, never passes the token as an argument, and removes it", async () => {
	const calls = [];
	const exec = (program, args, options) => { calls.push({ program, args, options }); return "name | status\nfact1 | running\n"; };
	const read = () => JSON.stringify({ vm: { url: "https://vm.example/", token: TOKEN } });
	const output = await withCluster("vm", transport => transport.ctl("instance", "list"), { exec, controller: "local-controller", read });
	assert.match(output, /fact1/);
	const [write, request, remove] = calls;
	assert.match(write.args.at(-1), /^umask 077 && cat > \/tmp\/remote-vm-/);
	assert.match(write.options.input, new RegExp(TOKEN));
	const file = write.args.at(-1).split("> ")[1];
	assert.deepEqual(request.args.slice(0, 8), ["exec", "local-controller", "npx", "clusterioctl", "--log-level", "error", "--config", file]);
	assert.deepEqual(remove.args, ["exec", "local-controller", "rm", "-f", file]);
	for (const call of calls) assert.ok(!call.args.join(" ").includes(TOKEN), "the token never appears in a command line");
	await assert.rejects(withCluster("vm", () => { throw new Error("boom"); }, { exec, controller: "local-controller", read }), /boom/);
	assert.deepEqual(calls.at(-1).args.slice(0, 4), ["exec", "local-controller", "rm", "-f"], "the temporary config is removed after a failure");
});

test("ctl allows only read-only commands without --write", async () => {
	assert.ok(isReadOnly(["instance", "list"]));
	assert.ok(isReadOnly(["mod-pack", "show", "3"]));
	assert.ok(!isReadOnly(["instance", "stop", "fact1"]));
	assert.ok(!isReadOnly(["instance", "config", "set", "fact1", "x", "y"]));
	assert.ok(!isReadOnly(["instance", "send-rcon", "fact1", "/sc game.print(1)"]));
	const ran = [];
	const run = async (cluster, fn) => fn({ ctl: (...args) => { ran.push([cluster, ...args]); return "ok"; } });
	const err = sink();
	assert.equal(await ctlMain(["--cluster", "vm", "instance", "stop", "fact1"], { run, out: sink(), err }), 2);
	assert.match(err.text(), /without --write/);
	assert.equal(ran.length, 0);
	assert.equal(await ctlMain(["--cluster", "vm", "--write", "instance", "stop", "fact1"], { run, out: sink(), err: sink() }), 0);
	assert.equal(await ctlMain(["instance", "list"], { run, out: sink(), err: sink() }), 0);
	assert.deepEqual(ran, [["vm", "instance", "stop", "fact1"], ["dev", "instance", "list"]]);
});

test("instance lists parse by header, skipping the rule line", () => {
	const rows = parseInstanceList("name | id | status\n----------------\nfact1 | 1 | running\nfact2 | 2 | stopped\n");
	assert.deepEqual(rows.map(row => [row.name, row.status]), [["fact1", "running"], ["fact2", "stopped"]]);
	assert.deepEqual(parseInstanceList("error: not connected"), []);
});

test("the snapshot Lua is one line and refuses unsafe player names", () => {
	assert.ok(!snapshotLua("solarcloud7").includes("\n"));
	assert.throws(() => snapshotLua('x") game.print("y'), /Unsupported player name/);
});

const armor = (quality = "normal", equipment = [{ item: "solar-panel-equipment", quality: "normal" }]) => [
	{ item: "modular-armor", quality, count: 1, location: "armor" },
	...equipment.map(e => ({ item: e.item, quality: e.quality, count: 1, location: "grid:armor" })),
];
const observed = (possessions, extra = {}) => ({ observation: "observed", connected: true, controller: "character",
	body: { unit: 1, surface: "nauvis", possessions }, ...extra });

test("the diff proves conservation only from complete observations", () => {
	const before = { instances: {
		a: observed([...armor(), { item: "iron-plate", quality: "normal", count: 5, location: "main" }]),
		b: observed([], { connected: false }),
	} };
	const moved = { instances: {
		a: observed([{ item: "iron-plate", quality: "normal", count: 5, location: "main" }]),
		b: observed(armor(), { aboard: "ship" }),
	} };
	const result = diffSnapshots(before, moved);
	assert.ok(result.conserved && result.complete, result.lines.join("\n"));
	assert.ok(result.lines.some(line => line.includes("armor modular-armor -1")));
	assert.equal(result.lines.at(-1), "totals: unchanged across all instances (nothing created or lost)");
	const duplicated = structuredClone(moved);
	duplicated.instances.a.body.possessions.push(...armor());
	const dup = diffSnapshots(before, duplicated);
	assert.ok(dup.complete && !dup.conserved && dup.lines.at(-1).includes("CHANGED modular-armor +1, solar-panel-equipment +1"));
});

test("moving an item between locations is conserved, but losing a cursor stack or equipment is not", () => {
	const base = observed([...armor(), { item: "copper-plate", quality: "normal", count: 100, location: "cursor" }]);
	const intoMain = observed([...armor(), { item: "copper-plate", quality: "normal", count: 100, location: "main" }]);
	assert.ok(diffSnapshots({ instances: { a: base } }, { instances: { a: intoMain } }).conserved, "cursor to main is a move, not a loss");
	const cursorLost = diffSnapshots({ instances: { a: base } }, { instances: { a: observed(armor()) } });
	assert.ok(cursorLost.complete && !cursorLost.conserved && cursorLost.lines.at(-1).includes("copper-plate -100"));
	const equipmentLost = diffSnapshots({ instances: { a: base } }, { instances: { a: observed([...armor("normal", []), base.body.possessions[2]]) } });
	assert.ok(!equipmentLost.conserved && equipmentLost.lines.at(-1).includes("solar-panel-equipment -1"));
	const qualityChanged = diffSnapshots({ instances: { a: base } },
		{ instances: { a: observed([...armor("normal", [{ item: "solar-panel-equipment", quality: "rare" }]), base.body.possessions[2]]) } });
	assert.ok(!qualityChanged.conserved && qualityChanged.lines.at(-1).includes("solar-panel-equipment -1, solar-panel-equipment@rare +1"));
});

test("failed, missing and unavailable observations never produce a verdict", () => {
	const failed = { instances: { a: { success: false, error: "Lua snapshot failed" } } };
	const bothFailed = diffSnapshots(failed, failed);
	assert.ok(!bothFailed.complete && !bothFailed.conserved);
	assert.match(bothFailed.lines.at(-1), /UNKNOWN, evidence incomplete: no instance was observed in the before snapshot/);
	assert.match(bothFailed.lines.at(-1), /snapshot failed: Lua snapshot failed/);
	const empty = diffSnapshots({ instances: {} }, { instances: {} });
	assert.ok(!empty.complete && !empty.conserved, "no observed instances is not evidence of conservation");
	const absent = { instances: { a: { observation: "absent" } } };
	const allAbsent = diffSnapshots(absent, absent);
	assert.ok(allAbsent.complete && allAbsent.conserved, "an explicitly observed absence is complete evidence");
	const other = diffSnapshots({ instances: { a: observed([]) } }, { instances: { a: observed([]), b: observed([]) } });
	assert.ok(!other.complete && other.lines.at(-1).includes("different instances"));
});

test("a snapshot records stopped and failing instances as unavailable with a reason", async () => {
	const lua = name => { if (name === "broken") throw new Error("rcon timeout"); return name === "gone" ? { observation: "absent" } : observed([]); };
	const run = async (_cluster, fn) => fn({ ctl: () => "name | status\n---\nup | running\ndown | stopped\nbroken | running\ngone | running\n", lua });
	const state = await takeSnapshot("test", "player", { run });
	assert.equal(state.instances.up.observation, "observed");
	assert.deepEqual(state.instances.down, { observation: "unavailable", reason: "instance stopped" });
	assert.equal(state.instances.broken.observation, "unavailable");
	assert.match(state.instances.broken.reason, /query failed: rcon timeout/);
	assert.deepEqual(state.instances.gone, { observation: "absent" });
	assert.ok(!diffSnapshots(state, state).complete, "an unavailable instance leaves the verdict unknown");
});
