import test from "node:test";
import assert from "node:assert/strict";
import { parseInstanceList, readRemoteCluster, REMOTE_SCRIPT, withCluster } from "../../tools/shared/remote-cluster.mjs";
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

test("a remote call writes, uses and removes its private config inside one container shell, with the token only on stdin", async () => {
	const calls = [];
	const exec = (program, args, options) => { calls.push({ program, args, options }); return "name | status\nfact1 | running\n"; };
	const read = () => JSON.stringify({ vm: { url: "https://vm.example/", token: TOKEN } });
	const output = await withCluster("vm", transport => transport.ctl("instance", "list"), { exec, controller: "local-controller", read });
	assert.match(output, /fact1/);
	assert.equal(calls.length, 1, "no separate write or cleanup call can be skipped by an interrupt");
	const [call] = calls;
	assert.deepEqual(call.args.slice(0, 5), ["exec", "-i", "local-controller", "sh", "-c"]);
	assert.equal(call.args[5], REMOTE_SCRIPT);
	assert.match(REMOTE_SCRIPT, /umask 077; f=\$\(mktemp\) \|\| exit 1; trap 'rm -f "\$f"' EXIT INT TERM HUP;/);
	assert.deepEqual(call.args.slice(6), ["sh", "instance", "list"]);
	assert.match(call.options.input, new RegExp(TOKEN));
	assert.equal(call.options.stdio[0], "pipe", "the transport's ignored stdin must not swallow the config");
	assert.ok(!call.args.join(" ").includes(TOKEN), "the token never appears in a command line");
	const devCalls = [];
	await withCluster("dev", transport => transport.ctl("instance", "list"), { exec: (p, a) => { devCalls.push(a); return ""; } });
	assert.ok(devCalls[0].includes("/clusterio/tokens/config-control.json"), "the development cluster keeps its own config");
});

test("a malformed local config is reported without echoing its content", () => {
	const files = { "clusters.json": `{ "vm": { "url": "https://vm.example/", "token": ${TOKEN} } }` };
	assert.throws(() => readRemoteCluster("vm", { file: "clusters.json", read: name => files[name], exists: () => true }),
		error => /is not valid JSON$/.test(error.message) && !error.message.includes(TOKEN.slice(0, 6)));
});

test("ctl refuses global options anywhere and local-config commands on remote clusters, even with --write", async () => {
	const ran = [];
	const run = async (cluster, fn) => fn({ ctl: (...args) => { ran.push([cluster, ...args]); return "ok"; } });
	for (const argv of [
		["--cluster", "vm", "instance", "list", "--config", "/clusterio/tokens/config-control.json"],
		["--cluster", "vm", "instance", "list", "--plugin-list=/tmp/evil.json"],
		["instance", "list", "--log-level", "silly"],
		["--cluster", "vm", "--write", "control-config", "list"],
		["--cluster", "vm", "--write", "plugin", "list"],
	]) {
		const err = sink();
		assert.equal(await ctlMain(argv, { run, out: sink(), err }), 2, argv.join(" "));
		assert.match(err.text(), /^Refusing/);
	}
	assert.deepEqual(ran, [], "nothing reached clusterioctl");
	assert.equal(await ctlMain(["--write", "control-config", "list"], { run, out: sink(), err: sink() }), 0, "the local dev cluster may inspect its own config");
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

test("gear waiting in arrival records and manifests counts, and different players or clusters are not compared", () => {
	const armorAboard = observed(armor());
	const arrived = { ...observed([]), pending: armor().map(p => ({ ...p, location: "pending:arrival:transfer-1" })) };
	const handedOver = diffSnapshots({ cluster: "vm", player: "p", instances: { a: armorAboard } }, { cluster: "vm", player: "p", instances: { a: arrived } });
	assert.ok(handedOver.conserved, "armor waiting for delivery is still the player's");
	const mixed = diffSnapshots({ cluster: "vm", player: "p", instances: { a: armorAboard } }, { cluster: "vm", player: "q", instances: { a: armorAboard } });
	assert.ok(!mixed.complete && mixed.lines.at(-1).includes("different players"));
	const clusters = diffSnapshots({ cluster: "dev", player: "p", instances: { a: armorAboard } }, { cluster: "vm", player: "p", instances: { a: armorAboard } });
	assert.ok(!clusters.complete && clusters.lines.at(-1).includes("different clusters"));
});
