import test from "node:test";
import assert from "node:assert/strict";
import { parseInstanceList, readRemoteCluster, withCluster } from "../../tools/shared/remote-cluster.mjs";
import { isReadOnly, main as ctlMain } from "../../tools/clusterio/ctl.mjs";
import { diffSnapshots, snapshotLua } from "../../tools/surface-export/player-state.mjs";

const TOKEN = "secret-token-value";
function sink() { const parts = []; return { write: text => parts.push(text), text: () => parts.join("") }; }

test("remote cluster config reads a token file and names the missing file without leaking values", () => {
	const files = { "clusters.json": JSON.stringify({ vm: { url: "https://vm.example/", tokenFile: "token.txt" } }), "token.txt": `${TOKEN}\n` };
	const options = { file: "clusters.json", read: name => files[name], exists: name => name in files };
	assert.deepEqual(readRemoteCluster("vm", options), { url: "https://vm.example/", token: TOKEN });
	assert.throws(() => readRemoteCluster("vm", { ...options, exists: () => false }), /is missing/);
	assert.throws(() => readRemoteCluster("other", options), /No cluster "other".*Known: vm/);
	const noToken = { ...options, read: () => JSON.stringify({ vm: { url: "https://vm.example/" } }) };
	assert.throws(() => readRemoteCluster("vm", noToken), /needs a "token" or "tokenFile"/);
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

test("the diff proves conservation only when every body was readable", () => {
	const armor = { "modular-armor": 1 };
	const before = { instances: {
		a: { present: true, connected: true, controller: "character", aboard: "ship", body: { unit: 1, surface: "platform-1", armor, main: { "iron-plate": 5 } } },
		b: { present: true, connected: false, controller: "character", body: { unit: 2, surface: "nauvis", main: {} } },
	} };
	const moved = { instances: {
		a: { present: true, connected: false, controller: "character", body: { unit: 1, surface: "nauvis", main: { "iron-plate": 5 } } },
		b: { present: true, connected: true, controller: "remote", aboard: "ship", body: { unit: 2, surface: "platform-2", armor, main: {} } },
	} };
	const conserved = diffSnapshots(before, moved);
	assert.ok(conserved.conserved && conserved.complete);
	assert.ok(conserved.lines.some(line => line.includes("armor: modular-armor -1")));
	assert.ok(conserved.lines.some(line => line.includes("armor: modular-armor +1")));
	assert.equal(conserved.lines.at(-1), "totals: unchanged across all instances (nothing created or lost)");
	const duplicated = structuredClone(moved);
	duplicated.instances.a.body.armor = armor;
	const dup = diffSnapshots(before, duplicated);
	assert.ok(!dup.conserved && dup.lines.at(-1).includes("CHANGED modular-armor +1"));
	const hidden = structuredClone(moved);
	delete hidden.instances.a.body;
	const partial = diffSnapshots(before, hidden);
	assert.ok(!partial.complete && partial.lines.some(line => line.startsWith("totals: incomplete, no readable body on a")));
});
