import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t, seeds, client = {}) {
	const root = mkdtempSync(join(tmpdir(), "client-mods-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const dir of ["tools/clusterio", "tools/surface-export", "docker/seed-data/mods",
		"docker/seed-data/mods-src/surfexp_gateways", "appdata/Factorio/mods"]) {
		mkdirSync(join(root, dir), { recursive: true });
	}
	for (const script of ["tools/clusterio/sync-client-mods.ps1", "tools/surface-export/build-gateway-mod.ps1"]) {
		copyFileSync(join(repo, script), join(root, script));
	}
	for (const [name, bytes] of Object.entries(seeds)) writeFileSync(join(root, "docker/seed-data/mods", name), bytes);
	const mods = join(root, "appdata/Factorio/mods");
	for (const [name, bytes] of Object.entries(client)) writeFileSync(join(mods, name), bytes);
	return {
		root, mods,
		run(args = [], script = "tools/clusterio/sync-client-mods.ps1") {
			const r = spawnSync("pwsh", ["-NoProfile", "-File", join(root, script), ...args], {
				cwd: root, env: { ...process.env, APPDATA: join(root, "appdata") }, encoding: "utf8", timeout: 30_000,
			});
			assert.ifError(r.error);
			return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
		},
		bytes(name) { return readFileSync(join(mods, name), "utf8"); },
		names() { return readdirSync(mods).sort(); },
	};
}

test("duplicate seed versions sync and remain intact on prune and repeat runs", t => {
	const f = fixture(t, { "example_1.2.0.zip": "old seed", "example_1.3.0.zip": "new seed" });
	for (const args of [[], ["-PruneShadowing"], []]) {
		const r = f.run(args);
		assert.equal(r.status, 0, r.output);
		assert.equal(f.bytes("example_1.2.0.zip"), "old seed");
		assert.equal(f.bytes("example_1.3.0.zip"), "new seed");
	}
});

test("shadow refusal is preflight; pruning removes only newer unseeded copies once", t => {
	const f = fixture(t, { "example_1.2.0.zip": "seed", "example_1.3.0.zip": "next" }, {
		"example_1.1.0.zip": "older", "example_1.4.0.zip": "shadow", "client_only_9.0.0.zip": "keep",
	});
	const before = f.names();
	const refused = f.run();
	assert.notEqual(refused.status, 0);
	assert.deepEqual(f.names(), before, "refusal must precede copying");
	const pruned = f.run(["-PruneShadowing"]);
	assert.equal(pruned.status, 0, pruned.output);
	assert.equal((pruned.output.match(/pruned newer: example_1.4.0.zip/g) || []).length, 1);
	assert.deepEqual(f.names(), ["client_only_9.0.0.zip", "example_1.1.0.zip", "example_1.2.0.zip", "example_1.3.0.zip"]);
});

test("dry-run reports copies and authorized pruning without changing bytes", t => {
	const f = fixture(t, { "example_1.0.0.zip": "new" }, {
		"example_1.0.0.zip": "old", "example_2.0.0.zip": "shadow", "mod-list.json": '{"mods":[]}',
	});
	const before = Object.fromEntries(f.names().map(n => [n, f.bytes(n)]));
	const r = f.run(["-DryRun", "-PruneShadowing"]);
	assert.equal(r.status, 0, r.output);
	assert.match(r.output, /would prune newer: example_2.0.0.zip/);
	assert.deepEqual(Object.fromEntries(f.names().map(n => [n, f.bytes(n)])), before);
});

test("same-name rebuilds repair bytes and keep unrelated mod-list entries untouched", t => {
	const f = fixture(t, { "example_1.0.0.zip": "new" }, {
		"example_1.0.0.zip": "old", "mod-list.json": '{"mods":[{"name":"client_only","enabled":true}]}',
	});
	const list = f.bytes("mod-list.json");
	assert.equal(f.run().status, 0);
	assert.equal(f.bytes("example_1.0.0.zip"), "new");
	assert.equal(f.bytes("mod-list.json"), list);
	assert.match(f.run().output, /copied=0 repaired=0 unchanged=1/);
});

test("filename/numeric disagreement refuses before copying, including with prune", t => {
	const f = fixture(t, { "example_1.9.0.zip": "nine", "example_1.10.0.zip": "ten" }, {
		"example_2.0.0.zip": "keep until resolved",
	});
	for (const args of [[], ["-PruneShadowing"], ["-DryRun", "-PruneShadowing"]]) {
		const r = f.run(args);
		assert.notEqual(r.status, 0);
		assert.match(r.output, /Ambiguous seed versions/);
		assert.deepEqual(f.names(), ["example_2.0.0.zip"]);
		assert.equal(f.bytes("example_2.0.0.zip"), "keep until resolved");
	}
});

test("gateway build pruning leaves other seeded mods and prefix-sharing mods untouched", t => {
	const f = fixture(t, { "other_mod_1.0.0.zip": "seed other" }, {
		"other_mod_2.0.0.zip": "newer other", "surfexp_gateways_0.5.0.zip": "old gateway",
		"surfexp_gateways_0.7.0.zip": "newer gateway", "surfexp_gateways_extra_1.0.0.zip": "separate mod",
		"mod-list.json": '{"mods":[{"name":"other_mod","enabled":true}]}',
	});
	writeFileSync(join(f.root, "docker/seed-data/mods-src/surfexp_gateways/info.json"), JSON.stringify({
		name: "surfexp_gateways", version: "0.6.0", title: "fixture", author: "fixture", factorio_version: "2.0",
	}));
	const r = f.run(["-PruneOldClientVersions"], "tools/surface-export/build-gateway-mod.ps1");
	assert.equal(r.status, 0, r.output);
	assert.doesNotMatch(r.output, /Client sync FAILED/);
	assert.equal(f.bytes("other_mod_2.0.0.zip"), "newer other");
	assert.ok(!f.names().includes("other_mod_1.0.0.zip"), "gateway build must scope copying too");
	assert.equal(f.bytes("surfexp_gateways_extra_1.0.0.zip"), "separate mod");
	assert.ok(f.names().includes("surfexp_gateways_0.6.0.zip"));
	assert.ok(!f.names().includes("surfexp_gateways_0.5.0.zip"));
	assert.ok(!f.names().includes("surfexp_gateways_0.7.0.zip"));
	const mods = JSON.parse(f.bytes("mod-list.json")).mods;
	assert.deepEqual(mods.find(m => m.name === "other_mod"), { name: "other_mod", enabled: true });
	assert.equal(mods.find(m => m.name === "surfexp_gateways").enabled, true);
});

test("gateway build selects its exact source version when newer seeds coexist", t => {
	const f = fixture(t, { "surfexp_gateways_0.7.0.zip": "newer seed" }, {
		"mod-list.json": '{"mods":[]}',
	});
	writeFileSync(join(f.root, "docker/seed-data/mods-src/surfexp_gateways/info.json"), JSON.stringify({
		name: "surfexp_gateways", version: "0.6.0", title: "fixture", author: "fixture", factorio_version: "2.0",
	}));
	const r = f.run([], "tools/surface-export/build-gateway-mod.ps1");
	assert.equal(r.status, 0, r.output);
	assert.doesNotMatch(r.output, /Client sync FAILED/);
	assert.ok(f.names().includes("surfexp_gateways_0.6.0.zip"));
	assert.ok(!f.names().includes("surfexp_gateways_0.7.0.zip"), "must not copy a different seed version");
	writeFileSync(join(f.mods, "surfexp_gateways_0.7.0.zip"), "newer client");
	const refused = f.run([], "tools/surface-export/build-gateway-mod.ps1");
	assert.match(refused.output, /Client sync FAILED/);
	assert.equal(f.bytes("surfexp_gateways_0.7.0.zip"), "newer client");
	const pruned = f.run(["-PruneOldClientVersions"], "tools/surface-export/build-gateway-mod.ps1");
	assert.equal(pruned.status, 0, pruned.output);
	assert.doesNotMatch(pruned.output, /Client sync FAILED/);
	assert.ok(!f.names().includes("surfexp_gateways_0.7.0.zip"));
	assert.equal(readFileSync(join(f.root, "docker/seed-data/mods/surfexp_gateways_0.7.0.zip"), "utf8"), "newer seed");
});

test("scoped pruning preserves mods whose names differ by case", t => {
	const f = fixture(t, { "example_1.0.0.zip": "seed" }, { "Example_2.0.0.zip": "different mod" });
	const r = f.run(["-ModName", "example", "-PruneShadowing"]);
	assert.equal(r.status, 0, r.output);
	assert.equal(f.bytes("Example_2.0.0.zip"), "different mod");
});
