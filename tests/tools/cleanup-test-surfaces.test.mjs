import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import luaparse from "../../docker/seed-data/external_plugins/surface_export/scripts/vendor/luaparse.cjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..", "..");
const sweeperPath = path.join(repoRoot, "tools", "tests", "cleanup-test-surfaces.ps1");
const selftestPath = path.join(repoRoot, "docker", "seed-data", "external_plugins", "surface_export",
	"module", "interfaces", "remote", "no-tick-sync-selftest.lua");

const sweeper = fs.readFileSync(sweeperPath, "utf8");
const selftest = fs.readFileSync(selftestPath, "utf8");

function capturePlatformSweeps(replies) {
	const script = `
$module = Import-Module ./tests/integration/lib/TestBase.psm1 -Force -PassThru
& $module {
    function script:Invoke-Lua { param($Instance, $Code) $script:query=$Code; return $script:reply }
    $results = foreach ($value in ($env:SE_SWEEP_REPLIES | ConvertFrom-Json)) {
        $script:reply=$value; $script:query=$null
        try { $result=Remove-PlatformSurfacesWhere -Instance fixture -PredicateLua "p.name == 'itemstate-retained'"; @{result=$result;query=$script:query} }
        catch { @{error=$_.Exception.Message;query=$script:query} }
    }
    ConvertTo-Json -Depth 6 -Compress -InputObject @($results)
}`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], { cwd: repoRoot, encoding: "utf8",
		env: { ...process.env, SE_SWEEP_REPLIES: JSON.stringify(replies) } });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

const noPowerShell = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status !== 0;

test("platform sweep refuses missing, malformed and unconfirmed deletion replies", { skip: noPowerShell }, () => {
	const invalid = ["", "Lua ownership guard refused", "{}", '{"deleted":0,"names":["itemstate-retained"]}',
		'{"deleted":1,"names":null}', '{"deleted":"1","names":["itemstate-retained"]}',
		...[0, false, "", null].map(value => JSON.stringify({ deleted: 1, names: [value] }))];
	const results = capturePlatformSweeps([...invalid, '{"deleted":0,"names":{}}', '{"deleted":1,"names":["itemstate-retained"]}']);
	for (const result of results.slice(0, invalid.length)) assert.match(result.error || "", /Platform cleanup failed/);
	assert.equal(results.at(-2).result.deleted, 0);
	assert.equal(results.at(-1).result.deleted, 1);
});

test("a refused platform sweep stops later surface and group deletion", { skip: noPowerShell }, () => {
	const script = `
function Import-Module {}
function Get-ProtectedFixtures { @('protected') }
function Get-HostInstanceId { 'fixture' }
function Get-PlatformInventory { @{name='itemstate-retained';force='player';hasSurface=$true;hasHub=$true;entities=1} }
function Remove-PlatformSurfacesWhere { throw 'retained transfer' }
$global:later=0
function Invoke-Lua { $global:later++; throw 'later sweep ran' }
function Step-Tick { $global:later++ }
try { & ./tools/tests/cleanup-test-surfaces.ps1 -Hosts 1 } catch { $failure=$_.Exception.Message }
@{error=$failure;later=$global:later} | ConvertTo-Json -Compress`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], { cwd: repoRoot, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)), { error: "retained transfer", later: 0 });
});

test("Lua cleanup guards protect bulk fixture sweeps", { skip: noPowerShell }, t => {
	const binary = process.env.SE_TEST_LUA || "lua";
	const check = spawnSync(binary, ["-v"], { encoding: "utf8" });
	if (check.error?.code === "ENOENT" && !process.env.SE_TEST_LUA) return t.skip("Lua unavailable; CI runs this on Lua 5.2");
	assert.ifError(check.error);
	assert.equal(check.status, 0, check.stderr);
	const [{ query, error }] = capturePlatformSweeps(['{"deleted":1,"names":["itemstate-retained"]}']);
	assert.equal(error, undefined);
	const execute = input => spawnSync(binary, ["tests/lua/probe-cleanup.lua", "bulk"], { input, encoding: "utf8", timeout: 5000 });
	const baseline = execute(query);
	assert.equal(baseline.status, 0, baseline.stderr);
	for (const guard of [
		"assert(not (storage.locked_platforms or {})[p.index],'Probe platform is locked; preserve it')",
		"assert(hold.platform_index~=p.index and hold.surface_index~=p.surface.index,'Probe platform has a destination hold')",
		"assert(job.platform_index~=p.index and job.target_platform~=p and job.target_surface~=p.surface,'Probe platform has active work')",
	]) {
		assert.ok(query.includes(guard));
		assert.notEqual(execute(query.replace(guard, "")).status, 0, `Removing guard survived: ${guard}`);
	}
});

const prefixListPath = path.join(repoRoot, "tools", "shared", "test-surface-prefixes.json");

function defaultPrefixes() {
	assert.match(sweeper, /\$Prefixes = @\(Get-Content -LiteralPath \(Join-Path \$PSScriptRoot '\.\.\/shared\/test-surface-prefixes\.json'\)/,
		"cleanup-test-surfaces.ps1 must take its default -Prefixes from tools/shared/test-surface-prefixes.json");
	const prefixes = JSON.parse(fs.readFileSync(prefixListPath, "utf8"));
	assert.ok(Array.isArray(prefixes) && prefixes.length && prefixes.every(p => typeof p === "string" && /^[a-z][a-z0-9_-]*$/.test(p)),
		"test-surface-prefixes.json must be a non-empty array of lowercase name prefixes");
	return prefixes;
}

function integrationSources(dir = path.join(repoRoot, "tests", "integration")) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return integrationSources(full);
		return /\.(mjs|js|lua)$/.test(entry.name) ? [full] : [];
	});
}

function platformNamePrefixes() {
	const found = new Map();
	const note = (prefix, file) => { if (!found.has(prefix)) found.set(prefix, path.relative(repoRoot, file)); };
	for (const file of integrationSources()) {
		const text = fs.readFileSync(file, "utf8");
		const createsPlatforms = /create_space_platform|clone_platform/.test(text);
		for (const [, name] of text.matchAll(/\brunFixture\(\s*["']([a-z][a-z0-9_-]*)["']/g)) note(`${name}-`, file);
		if (!createsPlatforms) continue;
		for (const [, prefix] of text.matchAll(/\b[A-Za-z_]\w*\s*=\s*`([a-z][a-z0-9_-]*[-_])\$\{/g)) note(prefix, file);
		for (const [, prefix] of text.matchAll(/\b[A-Za-z_]\w*\s*=\s*["']([a-z][a-z0-9_-]*[-_])["']/g)) note(prefix, file);
	}
	return found;
}

test("every platform-name prefix an integration suite creates is in the shared throwaway list", () => {
	const prefixes = defaultPrefixes();
	const found = platformNamePrefixes();
	for (const known of ["latch-adversarial-", "mptransfer-", "transfer-cleanup-", "gwpark-probe-", "cfgattr-", "itemstate-"]) {
		assert.ok(found.has(known), `the prefix scan no longer finds ${known}; it has stopped reading the suites`);
	}
	const uncovered = [...found].filter(([prefix]) => !prefixes.some(p => prefix.startsWith(p)))
		.map(([prefix, file]) => `${prefix} (${file})`);
	assert.deepEqual(uncovered, [], "add these prefixes to tools/shared/test-surface-prefixes.json so a leaked platform is sweepable");
});

test("no gallery fixture platform carries a throwaway prefix", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests", "lab-gallery", "manifest.json"), "utf8"));
	const names = [...new Set((manifest.fixtures || []).map(f => f?.platformName).filter(Boolean))];
	assert.ok(names.length > 0);
	const prefixes = defaultPrefixes();
	assert.deepEqual(names.filter(name => prefixes.some(p => name.startsWith(p))), []);
});

function scratchSurfacePrefix() {
	const m = selftest.match(/^local LAB_PREFIX = "([^"]+)"$/m);
	assert.ok(m, "could not parse LAB_PREFIX out of no-tick-sync-selftest.lua");
	return m[1];
}

function plainSurfaceSweepLua({ dryRun }) {
	const deleteBranch = sweeper.match(/\$deleteLua = if \(\$DryRun\) \{ "" \} else \{ "((?:[^"\\]|\\.)*)" \}[\s\S]*?names=names\}\)\)"/);
	assert.ok(deleteBranch, "could not locate the plain-surface sweep block in cleanup-test-surfaces.ps1");
	const block = deleteBranch[0];
	const deleteStatement = dryRun ? "" : deleteBranch[1];

	const expression = block.slice(block.indexOf("$code ="));
	const marked = expression.replace(/^\s*\$deleteLua\s*\+\s*$/m, '"<<DELETE>>" +');
	assert.notEqual(marked, expression, "the sweep block no longer splices $deleteLua — the -DryRun path is unverified");

	const literals = [...marked.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((q) => q[1]);
	assert.ok(literals.length >= 4, `expected the sweep Lua to be built from several literals, parsed ${literals.length}`);

	return literals.join("")
		.replace("<<DELETE>>", deleteStatement)
		.replace("$prefixLua", "'lab-scratch-','other-'")
		.replace("$protectedLua", "['lab-transfer-fixture-v1']=true");
}

test("the selftest's scratch-surface prefix is one the sweeper actually sweeps", () => {
	const prefix = scratchSurfacePrefix();
	assert.ok(defaultPrefixes().includes(prefix),
		`no_tick_sync's scratch surfaces are named ${prefix}* but that prefix is not in the default ` +
		"-Prefixes of tools/tests/cleanup-test-surfaces.ps1 — a leak would be unsweepable");
});

test("combined and historical item-state fixtures remain eligible for guarded cleanup", () => {
	for (const prefix of ["itemstate-", "beltstate-", "invstate-"]) {
		assert.ok(defaultPrefixes().includes(prefix), `Missing fixture cleanup prefix: ${prefix}`);
	}
});

test("the plain-surface sweep Lua parses, on both the sweep and the -DryRun path", () => {
	for (const dryRun of [false, true]) {
		const code = plainSurfaceSweepLua({ dryRun });
		luaparse.parse(code, { luaVersion: "5.2" });
	}
});

test("the plain-surface sweep never reaches a platform surface, a protected fixture, or an undeletable surface", () => {
	const code = plainSurfaceSweepLua({ dryRun: false });
	assert.match(code, /s\.platform == nil/,
		"without this filter the plain-surface pass would double-sweep platform surfaces the platform pass owns");
	assert.match(code, /not protected\[s\.name\]/, "protected fixtures must be excluded by name");
	assert.match(code, /s\.deletable/, "nauvis and any other undeletable surface must be excluded by the engine's own answer");
	assert.match(code, /s\.name:sub\(1, #prefix\) == prefix/, "only prefix-matched surfaces may be swept");
});

test("-DryRun sweeps nothing", () => {
	assert.doesNotMatch(plainSurfaceSweepLua({ dryRun: true }), /delete_surface/,
		"the audit mode must not delete");
	assert.match(plainSurfaceSweepLua({ dryRun: false }), /delete_surface/,
		"the sweep mode must delete — a sweeper that reports without removing is the leak it exists to fix");
});

test("the selftest deletes its scratch surface on the error path too, and demotes status on a leak", () => {
	const wrapper = selftest.slice(selftest.indexOf("local function no_tick_sync_selftest"));
	assert.ok(wrapper.length > 0, "could not locate the no_tick_sync_selftest wrapper");

	const pcallAt = wrapper.indexOf("pcall(run_lab");
	const cleanupAt = wrapper.indexOf("delete_scratch(surface");
	const errorReturnAt = wrapper.indexOf("if not ok then");
	assert.ok(pcallAt !== -1 && cleanupAt !== -1 && errorReturnAt !== -1,
		"the wrapper must run the lab under pcall and clean up through delete_scratch");
	assert.ok(cleanupAt > pcallAt && cleanupAt < errorReturnAt,
		"delete_scratch must run after the lab and before the error return, so a throw cannot skip it");

	assert.match(wrapper, /result\.status = "leaked"/,
		"a leak must demote status — the batch runner reads only status, so a leak reported beside a " +
		"passed status is a vacuous green");
});
