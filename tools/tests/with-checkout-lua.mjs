#!/usr/bin/env node
// Run a local integration command with specified checkout Lua module tables temporarily installed.
// Existing consumers retain the same table identity. Original members are restored and checked in
// finally; refuses concurrent players, jobs, pauses, locks and an outstanding replacement marker.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { lua, preflightState, assertLeaseClean, REPO_ROOT } from "../../tests/lab-gallery/batch-lifecycle.mjs";

const args = process.argv.slice(2);
const split = args.indexOf("--");
if (split < 1 || !args[split + 1]) throw new Error("usage: with-checkout-lua.mjs module/path.lua [...] -- command [args]");
const root = resolve(REPO_ROOT, "docker/seed-data/external_plugins/surface_export/module");
const modules = args.slice(0, split).map(name => {
	if (!/^[a-z0-9_/-]+\.lua$/.test(name)) throw new Error(`invalid module path: ${name}`);
	const path = resolve(root, name);
	if (!path.startsWith(root + sep)) throw new Error(`module outside source tree: ${name}`);
	const source = readFileSync(path, "utf8");
	const declaration = /^local ([A-Za-z_][A-Za-z0-9_]*) = \{\}$/m;
	if (!declaration.test(source)) throw new Error(`no module table declaration in ${name}`);
	return { name, source: source.replace(declaration, "local $1 = M"), key: `__level__/modules/surface_export/${name}`,
		hash: createHash("sha256").update(source).digest("hex") };
});
const armed = [];
let exitCode = 1;
try {
	for (const host of [1, 2]) assertLeaseClean(host, preflightState(host), "checkout Lua replacement");
	for (const host of [1, 2]) {
		for (const mod of modules) {
			// Register before the request: a transport error may occur after the replacement executes.
			const item = { host, mod };
			const token = `checkout-${Date.now()}-${host}-${armed.length}`;
			item.token = token;
			armed.push(item);
			const r = lua(host, `local M = package.loaded['${mod.key}']
if type(M) ~= 'table' then return {success=false,error='module not loaded'} end
if M._checkout_original then return {success=false,error='checkout replacement already present'} end
local original = {}
for key, value in pairs(M) do original[key] = value end
M._checkout_original = original
M._checkout_token = '${token}'
M._checkout_hash = '${mod.hash}'
local function require(path)
  local loaded = package.loaded['__level__/' .. path .. '.lua']
  assert(loaded ~= nil, 'dependency not already loaded: ' .. path)
  return loaded
end
local replacement = (function() ${mod.source}\nend)()
assert(replacement == M, 'module table identity changed')
return {success=true}`);
			if (!r.success) throw new Error(`arm ${host}/${mod.name}: ${r.error}`);
			console.log(`checkout Lua host=${host} module=${mod.name} sha256=${mod.hash}`);
		}
	}
	const run = spawnSync(args[split + 1], args.slice(split + 2), {
		cwd: REPO_ROOT, stdio: "inherit", timeout: 600_000,
	});
	if (run.error) throw run.error;
	exitCode = run.status ?? 1;
} finally {
	let restoreFailed = false;
	for (const { host, mod, token } of armed.reverse()) {
		try {
			const r = lua(host, `local M = package.loaded['${mod.key}']
if type(M) ~= 'table' then return {success=false,error='module missing at restore'} end
if not M._checkout_original then return {success=true,unchanged=true} end
if M._checkout_token ~= '${token}' then return {success=false,error='replacement belongs to another run'} end
local original = M._checkout_original
for key in pairs(M) do M[key] = nil end
for key, value in pairs(original) do M[key] = value end
for key, value in pairs(original) do assert(M[key] == value, 'original member not restored') end
return {success=true}`);
			if (!r.success) throw new Error(r.error);
			console.log(`restored original Lua host=${host} module=${mod.name}`);
		} catch (error) {
			restoreFailed = true;
			console.error(`RESTORE FAILED ${host}/${mod.name}: ${error.message}; inspect runtime before further tests`);
		}
	}
	if (restoreFailed) process.exitCode = 2;
}
process.exitCode ??= exitCode;
