import { waitForTransfer } from "../../tools/surface-export/platform-transfer.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { runTransferProbe, cleanupProbeLua } from "../../tools/surface-export/transfer-probe.mjs";

function cliProbe(scenario) {
	const script = `
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const calls = [], deleted = new Set();
let cloned = false;
const platform = (index, uid, name) => ({platform_index:index, surface_index:index+100,platform_uid:uid,platform_name:name,force_name:'player'});
global.setTimeout = fn => { queueMicrotask(fn); return 0; };
cp.execFileSync = (file, args) => {
 calls.push([file, args]);
 if (file === 'pwsh') {
  if (${JSON.stringify(scenario)} === 'lost-reply') throw new Error('Lost transfer acknowledgement');
  return 'Export queued: transfer_1';
 }
 if (file === 'node') return JSON.stringify({result:'SUCCESS',transferId:'other-operation'}, null, 2);
 if (file !== 'docker') throw new Error('Unexpected executable: '+file);
 const command = args.find(a => a.startsWith('/sc ')) || '';
 const host = args.some(a => a === 'clusterio-host-2-instance-1') ? 2 : 1;
 if (args.includes('save') && args.includes('list')) return ' '+host+' | save.zip';
 if (command.includes('clone_platform')) { cloned=true; return JSON.stringify({success:true,job_id:'export_1',entity_count:3}); }
 if (command.includes('platforms=remote.call')) return JSON.stringify({success:true,platforms:host===1 ? [platform(21,'fixture','fixture'),...(cloned?[platform(22,'clone','probe-test')]:[])]:[]});
 if (command.includes("['probe_preflight']")) return JSON.stringify({success:true});
 if (command.includes('local name=')) return JSON.stringify({success:true,index:22,jobId:'import_1',active:false,complete:true,status:'complete',identityMatched:true,identity:platform(22,'clone','probe-test')});
 if (command.includes("'export_platform'")) {
  if (${JSON.stringify(scenario)} === 'lost-reply') throw new Error('Lost transfer acknowledgement');
  return JSON.stringify({success:true,jobId:'transfer_1'});
 }
 if (command.includes('game.delete_surface')) { deleted.add(host); return 'deleted'; }
 if (command.includes('rcon.print(p.index)')) return deleted.has(host) ? '' : String(host === 1 ? 22 : 33);
 if (args.includes('list-transfers')) return JSON.stringify([{transferId:'1:transfer_1',operationType:'transfer',sourceInstanceId:1,targetInstanceId:2,status:'failed',error:'our transfer failed'}]);
 return '';
};
syncBuiltinESMExports();
process.argv = [process.execPath, 'tools/surface-export/probe-transfer.mjs', '--name', 'probe-test'];
process.on('exit', () => console.log('CALLS:'+JSON.stringify(calls)));
import('./tools/surface-export/probe-transfer.mjs').catch(e => { console.error(e); process.exitCode=1; });
`;
	const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });
	assert.ifError(result.error);
	const calls = JSON.parse(result.stdout.split(/\r?\n/).find(line => line.startsWith("CALLS:")).slice(6));
	return { ...result, calls };
}

test("a visible destination and another operation's success cannot pass the probe", () => {
	const result = cliProbe("wrong-operation");
	assert.match(result.stderr, /our transfer failed/);
	assert.notEqual(result.status, 0);
});

test("a lost acknowledgement must not trigger platform deletion", () => {
	const result = cliProbe("lost-reply");
	assert.match(result.stderr, /Lost transfer acknowledgement/);
	assert.notEqual(result.status, 0);
	assert.equal(result.calls.filter(([, args]) => args.some(arg => arg.includes("game.delete_surface"))).length, 0,
		"Unresolved ownership was bypassed during cleanup");
});

const platform = (index, uid, name = "probe-test") => ({ platform_index: index, surface_index: index + 100,
	platform_uid: uid, platform_name: name, force_name: "player" });
const complete = { transferId: "1:transfer_1", sourceInstanceId: 1, targetInstanceId: 2,
	operationType: "transfer", status: "completed", completedAt: 10, error: null };
const options = { fixtureIndex: 21, direction: "1to2", name: "probe-test", timeoutMs: 1500 };

function rig(settings = {}) {
	const original = platform(21, "fixture", "source fixture"), clone = platform(22, "source-clone");
	const destination = platform(33, "destination-clone");
	let cloned = false, started = false, removed = false, time = 0, poll = 0;
	const calls = [], messages = [];
	const io = {
		report: line => messages.push(line), instanceIds: () => ({ 1: 1, 2: 2 }), now: () => time,
		sleep: async ms => { time += ms; },
		ctl: (...args) => {
			calls.push(["ctl", args]);
			return JSON.stringify(settings.records?.(poll++) ?? [complete, { ...complete, transferId: "unrelated", status: "failed" }]);
		},
		lua: (host, body) => {
			calls.push(["lua", host, body]);
			if (body.includes("platforms=remote.call")) {
				const rows = host === 1 ? [original, ...(cloned && (!started || settings.sourceRemains) && !removed ? [clone] : [])]
					: started && !removed ? [{ ...destination, ...(settings.replacement ? { platform_uid: "replacement" } : {}) }] : [];
				if (settings.duplicateName && host === 1) rows.push({ ...original, platform_index: 24 });
				return { success: true, platforms: rows };
			}
			if (body.includes("['probe_preflight']")) return { success: true, ...(settings.priorClone ? { jobId: "old-import" } : {}) };
			if (body.includes("'clone_platform'")) { cloned = true; return { success: true, job_id: "export_1" }; }
			if (body.includes("local name=")) return { success: true, index: 22, jobId: "import_1", active: false,
				complete: true, status: "complete", identityMatched: true, identity: clone, ...settings.cloneResult };
			if (body.includes("local surface=p.surface")) return { success: false, error: "preparation failed" };
			if (body.includes("'export_platform'")) {
				started = true;
				if (settings.lostReply) throw new Error("Lost transfer acknowledgement");
				return { success: true, jobId: "transfer_1" };
			}
			if (body.includes("destination_live")) return { success: true, receipt: settings.missingReceipt ? undefined
				: { ...destination, transfer_id: complete.transferId, job_id: "destination-job" } };
			if (body.includes("game.delete_surface")) {
				if (settings.cleanupFailure) return { success: false, swept: 0, errors: ["locked"] };
				removed = true;
				return { success: true, swept: 1 };
			}
			throw new Error(`Unexpected query ${body}`);
		},
	};
	return { io, calls, messages, deleted: () => calls.filter(c => c[0] === "lua" && c[2].includes("game.delete_surface")) };
}

test("completed operation requires source absence and a matching destination receipt before cleanup", async () => {
	const r = rig();
	const result = await runTransferProbe(options, r.io);
	assert.equal(result.transferId, complete.transferId);
	assert.equal(r.deleted().length, 1);
	assert.equal(r.deleted()[0][1], 2);
	assert.match(r.deleted()[0][2], /destination-clone/);
	assert.ok(r.messages.some(line => line.startsWith("PASS")));
});

for (const [label, settings, expected] of [
	["source still exists", { sourceRemains: true }, /Source copy still present/],
	["receipt expired", { missingReceipt: true }, /receipt unavailable/],
	["destination identity replaced", { replacement: true }, /platform_uid changed/],
	["lost start reply", { lostReply: true }, /Lost transfer/],
	["clone rejected", { cloneResult: { status: "failed", error: "clone rejected" } }, /clone rejected/],
	["clone identity unavailable", { cloneResult: { identityMatched: false } }, /identity unavailable/],
	["clone replaced after observation", { cloneResult: { identity: platform(22, "previous-clone") } }, /Clone platform_uid changed/],
	["retained clone name", { priorClone: true }, /retained clone/],
	["own record failed", { records: () => [{ ...complete, status: "failed", error: "validation refused" }] }, /validation refused/],
	["own record missing", { records: () => [{ ...complete, transferId: "other-operation" }] }, /completion unavailable/],
	["own record ambiguous", { records: () => [complete, complete] }, /Ambiguous transfer/],
	["late cleanup remains", { records: () => [{ ...complete, lateDestinationCleanup: true }] }, /unresolved recovery/],
]) {
	test(`${label} cannot delete a platform or report success`, async () => {
		const r = rig(settings);
		await assert.rejects(runTransferProbe(options, r.io), expected);
		assert.equal(r.deleted().length, 0);
		assert.ok(!r.messages.some(line => line.startsWith("PASS")));
		assert.ok(r.calls.filter(c => c[0] === "lua" && c[2].includes("'export_platform'")).length <= 1);
	});
}

test("preparation failure cleans only the completed clone", async () => {
	const r = rig();
	await assert.rejects(runTransferProbe({ ...options, preparation: "error('prepare')" }, r.io), /preparation failed/);
	assert.equal(r.deleted().length, 1);
	assert.equal(r.deleted()[0][1], 1);
	assert.match(r.deleted()[0][2], /source-clone/);
});

test("cleanup refusal cannot pass", async () => {
	const r = rig({ cleanupFailure: true });
	await assert.rejects(runTransferProbe(options, r.io), /Fixture cleanup failed/);
	assert.ok(!r.messages.some(line => line.startsWith("PASS")));
});

test("keep preserves the verified destination", async () => {
	const r = rig();
	await runTransferProbe({ ...options, keep: true }, r.io);
	assert.equal(r.deleted().length, 0);
});

test("ambiguous source names fail before cloning", async () => {
	const r = rig({ duplicateName: true });
	await assert.rejects(runTransferProbe({ ...options, fixtureIndex: undefined, sourcePlatform: "source fixture" }, r.io), /Ambiguous source fixture/);
	assert.equal(r.calls.filter(c => c[0] === "lua" && c[2].includes("'clone_platform'")).length, 0);
});

test("queued work advances to completion without treating another success as ours", async () => {
	const r = rig({ records: poll => [poll < 2 ? { ...complete, status: "queued", completedAt: null } : complete,
		{ ...complete, transferId: "other-operation" }] });
	await runTransferProbe(options, r.io);
	assert.equal(r.calls.filter(c => c[0] === "ctl").length, 3);
});

test("unavailable and malformed transfer observations fail closed", async () => {
	for (const read of [() => { throw new Error("offline"); }, () => null, () => "invalid"]) {
		await assert.rejects(waitForTransfer({ read, transferId: "1:transfer_1", sourceId: 1, targetId: 2,
			timeoutMs: 5, sleep: async () => {} }));
	}
});

test("Lua cleanup guards execute and reject independent guard removals", t => {
	const binary = process.env.SE_TEST_LUA || "lua";
	const check = spawnSync(binary, ["-v"], { encoding: "utf8" });
	if (check.error?.code === "ENOENT" && !process.env.SE_TEST_LUA) return t.skip("Lua unavailable; CI runs this on Lua 5.2");
	assert.ifError(check.error);
	assert.equal(check.status, 0, check.stderr);
	const query = cleanupProbeLua(platform(33, "destination-clone"));
	const execute = input => spawnSync(binary, ["tests/lua/probe-cleanup.lua"], { input, encoding: "utf8", timeout: 5000 });
	const baseline = execute(query);
	assert.equal(baseline.status, 0, baseline.stderr);
	for (const guard of [
		"assert(matched,'Probe platform identity changed')",
		"assert(p and p.valid and p.surface and p.surface.valid and p.surface.index==133,'Probe platform location changed')",
		"assert(not (storage.locked_platforms or {})[p.index],'Probe platform is locked; preserve it')",
		"assert(hold.platform_index~=p.index and hold.surface_index~=p.surface.index,'Probe platform has a destination hold')",
		"assert(job.platform_index~=p.index and job.target_platform~=p and job.target_surface~=p.surface,'Probe platform has active work')",
	]) {
		assert.ok(query.includes(guard));
		assert.notEqual(execute(query.replace(guard, "")).status, 0, `Removing guard survived: ${guard}`);
	}
});

test("PowerShell repro wrapper forwards options and the shared probe's failure exit", t => {
	const available = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
	if (available.error?.code === "ENOENT") return t.skip("PowerShell unavailable");
	assert.ifError(available.error);
	const script = `function node { ConvertTo-Json -Compress -InputObject @($args); $global:LASTEXITCODE=7 }
& ./tools/surface-export/repro-transfer.ps1 -SourceHost 1 -SourcePlatform 'fixture with spaces' -TimeoutSec 42 -KeepResult
exit $LASTEXITCODE`;
	const result = spawnSync("pwsh", ["-NoProfile", "-Command", script], { encoding: "utf8", timeout: 10000 });
	assert.equal(result.status, 7, result.stderr);
	const args = JSON.parse(result.stdout.trim());
	assert.match(args[0], /probe-transfer\.mjs$/);
	assert.deepEqual(args.slice(1), ["--source-platform", "fixture with spaces", "--direction", "1to2", "--timeout-ms", "42000", "--keep"]);
});
