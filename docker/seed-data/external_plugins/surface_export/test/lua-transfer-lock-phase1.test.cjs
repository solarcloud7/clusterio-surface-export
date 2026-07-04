"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginDir = path.join(__dirname, "..");
const moduleDir = path.join(pluginDir, "module");

function readModule(rel) {
	return fs.readFileSync(path.join(moduleDir, rel), "utf8");
}

test("surface-lock exposes transfer-only expiry scanner with nil-safe TTL fallback", () => {
	const src = readModule(path.join("utils", "surface-lock.lua"));

	assert.match(src, /DEFAULT_TRANSFER_LOCK_TTL_TICKS\s*=\s*36000/, "named 10-minute transfer TTL constant is required");
	assert.match(src, /MIN_WORST_CASE_TRANSFER_TTL_TICKS\s*=\s*[\s\S]*?VALIDATION_TIMEOUT_TICKS\s*\+\s*WORST_CASE_RCON_TICKS/, "TTL floor must be DERIVED from named worst-case components (not a duplicate of DEFAULT), so DEFAULT>=MIN is a real check");
	assert.match(src, /function\s+SurfaceLock\.scan_transfer_expiries\s*\(/, "scan_transfer_expiries must exist");
	assert.doesNotMatch(src, /function\s+SurfaceLock\.cleanup_stale_locks\s*\(/, "destructive stale cleanup should be retired");
	assert.match(src, /kind\s*==\s*["']transfer["']/, "scanner must only act on transfer locks");
	assert.match(src, /expires_tick\s+or\s+\(\s*locked_tick\s*\+\s*DEFAULT_TRANSFER_LOCK_TTL_TICKS\s*\)/, "scanner must fall back from expires_tick to locked_tick + TTL");
	assert.match(src, /if\s+not\s+locked_tick\s+then[\s\S]*skip/, "scanner must skip old locks without locked_tick");
	assert.match(src, /SurfaceLock\.unlock_platform\s*\(\s*platform_index\s*,\s*lock_data\.platform_name\s*\)/, "expiry unlock must use the stored name tripwire");
});

test("transfer exports stamp transfer lock metadata and refuse manual locks", () => {
	const surfaceLock = readModule(path.join("utils", "surface-lock.lua"));
	const exportPipeline = readModule(path.join("core", "export-pipeline.lua"));
	const transferTrigger = readModule(path.join("core", "transfer-trigger.lua"));
	const remoteLock = readModule(path.join("interfaces", "remote", "lock-platform-for-transfer.lua"));

	assert.match(surfaceLock, /function\s+SurfaceLock\.lock_platform\s*\(\s*platform\s*,\s*force\s*,\s*transfer_opts\s*\)/, "lock_platform must accept transfer_opts");
	assert.match(surfaceLock, /kind\s*=\s*transfer_opts\s+and\s+["']transfer["']\s+or\s+nil/, "transfer lock must stamp kind");
	assert.match(surfaceLock, /transfer_job_id\s*=\s*transfer_opts\s+and\s+transfer_opts\.job_id\s+or\s+nil/, "transfer lock must retain source job_id correlation");
	assert.match(surfaceLock, /expires_tick\s*=\s*transfer_opts\s+and\s+transfer_opts\.expires_tick\s+or\s+nil/, "transfer lock must stamp expires_tick");
	assert.match(surfaceLock, /already locked by a different transfer lock/, "mismatched stale transfer locks must be refused");
	assert.match(surfaceLock, /return\s+true,\s+nil\s+--\s+same transfer lock upgraded/, "same-transfer backfill must let the universal export path continue");

	assert.match(exportPipeline, /local\s+transfer_opts\s*=/, "ExportPipeline.queue must build transfer_opts");
	assert.match(exportPipeline, /destination_instance_id[\s\S]*expires_tick\s*=\s*game\.tick\s*\+\s*SurfaceLock\.DEFAULT_TRANSFER_LOCK_TTL_TICKS/, "transfer exports must get a TTL at the universal lock path");
	assert.match(exportPipeline, /SurfaceLock\.lock_platform\s*\(\s*platform\s*,\s*force\s*,\s*transfer_opts\s*\)/, "universal lock path must pass transfer_opts");
	assert.match(exportPipeline, /already locked by a non-transfer lock/, "transfer against a manual lock must be refused loudly");

	assert.match(transferTrigger, /SurfaceLock\.lock_platform\s*\(\s*platform\s*,\s*force\s*,\s*\{[\s\S]*expires_tick\s*=\s*game\.tick\s*\+\s*SurfaceLock\.DEFAULT_TRANSFER_LOCK_TTL_TICKS/, "in-game transfer pre-lock must carry transfer metadata");
	assert.match(remoteLock, /SurfaceLock\.lock_platform\s*\(\s*platform\s*,\s*force\s*,\s*\{[\s\S]*expires_tick\s*=\s*game\.tick\s*\+\s*SurfaceLock\.DEFAULT_TRANSFER_LOCK_TTL_TICKS/, "documented lock_platform_for_transfer remote must create an expiring transfer lock");
});

test("control and remote interface expose transfer lock self-healing hooks", () => {
	const control = readModule("control.lua");
	const remoteInterface = readModule(path.join("interfaces", "remote-interface.lua"));

	assert.match(control, /SurfaceLock\.scan_transfer_expiries\s*\(\s*\)/, "on_tick must call scan_transfer_expiries");
	assert.match(control, /game\.tick\s*%\s*60\s*==\s*0/, "expiry scan should be throttled to once per second");
	assert.match(remoteInterface, /transfer_lock_selftest/, "remote selftest must be registered for live RCON verification");
	assert.match(remoteInterface, /transfer_lock_selftest_json/, "remote JSON selftest must be registered for automation");
});
