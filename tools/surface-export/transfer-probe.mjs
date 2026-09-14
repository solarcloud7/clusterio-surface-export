// requires: structured Lua/Clusterio responses and a disposable clone
// produces: operation-specific completion and identity-checked cleanup
// does not: interpret absence or timeouts as permission to delete or replay
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cloneStatusLua, waitForFixtureClone } from "../../tests/lab-gallery/clone-fixture.mjs";
import { fixtureSweepLua, assertFixtureCleanup } from "../../tests/lab-gallery/fixture-cleanup.mjs";

function quote(value) {
	assert.ok(typeof value === "string" && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value), "Invalid Lua string");
	return JSON.stringify(value);
}

function array(value) {
	if (value && !Array.isArray(value) && typeof value === "object" && !Object.keys(value).length) return [];
	assert.ok(Array.isArray(value), "Expected a record array");
	return value;
}

function checked(result) {
	assert.equal(result?.success, true, result?.error || "Lua observation unavailable");
	return result;
}

function identity(platform) {
	assert.ok(platform, "Platform unavailable");
	for (const key of ["platform_index", "surface_index"]) {
		assert.ok(Number.isSafeInteger(platform[key]) && platform[key] > 0, `Invalid ${key}`);
	}
	assert.equal(platform.force_name, "player", "Unexpected platform force");
	quote(platform.platform_uid);
	return platform;
}

function unique(rows, predicate, label) {
	const matches = rows.filter(predicate);
	assert.ok(matches.length <= 1, `Ambiguous ${label}`);
	return matches[0];
}

function currentLua(platform) {
	identity(platform);
	return `local p=game.forces.player.platforms[${platform.platform_index}]
assert(p and p.valid and p.surface and p.surface.valid and p.surface.index==${platform.surface_index},'Probe platform location changed')
local matched=false
for _,record in pairs(remote.call('surface_export','list_platforms','player')) do
 if record.platform_index==p.index and record.platform_uid==${quote(platform.platform_uid)} then matched=true end
end
assert(matched,'Probe platform identity changed')`;
}

export function cleanupProbeLua(platform) {
	return `${currentLua(platform)}
assert(not (storage.locked_platforms or {})[p.index],'Probe platform is locked; preserve it')
for _,hold in pairs(storage.destination_holds or {}) do
 assert(hold.platform_index~=p.index and hold.surface_index~=p.surface.index,'Probe platform has a destination hold')
end
for _,job in pairs(storage.async_jobs or {}) do
 assert(job.platform_index~=p.index and job.target_platform~=p and job.target_surface~=p.surface,'Probe platform has active work')
end
return ${fixtureSweepLua(`q.index==${platform.platform_index}`)}`;
}

export function destinationReceiptLua(transferId) {
	return `local bucket=(storage.surface_export_transfer_receipts or {}).destination_live
local receipt=bucket and bucket.records[${quote(transferId)}]
return {success=true,receipt=receipt}`;
}

export async function waitForProbeTransfer({ read, transferId, sourceId, targetId, timeoutMs, sleep,
	now = () => performance.now() }) {
	const deadline = now() + timeoutMs;
	let last;
	while (now() < deadline) {
		last = unique(array(await read()), row => row.transferId === transferId, "transfer record");
		if (last) {
			assert.equal(last.sourceInstanceId, sourceId, "Transfer source mismatch");
			assert.equal(last.targetInstanceId, targetId, "Transfer destination mismatch");
			assert.equal(last.operationType, "transfer", "Unexpected operation type");
			if (["failed", "cancelled", "cleanup_failed", "rolled_back"].includes(last.status)) {
				throw new Error(`Transfer ${transferId} ${last.status}: ${last.error || "inspect its retained details"}`);
			}
			if (last.status === "completed") {
				assert.ok(Number.isFinite(last.completedAt) && !last.error && !last.lateDestinationCleanup
					&& !last.timingPendingRecovery, "Transfer still has unresolved recovery");
				return last;
			}
		}
		await sleep(500);
	}
	throw new Error(`Transfer ${transferId} completion unavailable after ${timeoutMs} ms; platforms retained (${last?.status || "missing status"})`);
}

export async function runTransferProbe(options, io) {
	const { fixtureIndex, sourcePlatform, direction, name, preparation, keep = false, timeoutMs = 300_000 } = options;
	assert.ok(["1to2", "2to1"].includes(direction), "Invalid direction");
	assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Invalid timeout");
	assert.match(name, /^[A-Za-z0-9_-]+$/);
	assert.ok((fixtureIndex === undefined) !== (sourcePlatform === undefined), "Select one source fixture");
	if (fixtureIndex !== undefined) assert.ok(Number.isSafeInteger(fixtureIndex) && fixtureIndex > 0, "Invalid fixture index");
	if (sourcePlatform !== undefined) quote(sourcePlatform);
	const [source, target] = direction === "1to2" ? [1, 2] : [2, 1];
	const ids = await io.instanceIds();
	for (const host of [source, target]) assert.ok(Number.isSafeInteger(ids[host]) && ids[host] > 0, "Instance ID unavailable");
	assert.notEqual(ids[source], ids[target], "Source and destination must differ");
	const report = io.report ?? (() => {});
	const platforms = async host => array(checked(await io.lua(host,
		"return {success=true,platforms=remote.call('surface_export','list_platforms','player')}")).platforms);
	for (const host of [source, target]) {
		assert.ok(!(await platforms(host)).some(p => p.platform_name === name), "Probe name already exists");
	}
	const prior = checked(await io.lua(source, cloneStatusLua(name, "probe_preflight")));
	assert.ok(!prior.jobId && !prior.existingJobId, "Probe name belongs to a retained clone job; choose a fresh name");
	const fixture = identity(unique(await platforms(source), p => fixtureIndex === undefined
		? p.platform_name === sourcePlatform : p.platform_index === fixtureIndex, "source fixture"));
	let cleanup, transferId, failure, result;
	try {
		const queued = checked(await io.lua(source, `${currentLua(fixture)}
return remote.call('surface_export','clone_platform',p.index,${quote(name)})`));
		let cloneStatus;
		const cloneIndex = await waitForFixtureClone({ read: async () => {
			cloneStatus = await io.lua(source, cloneStatusLua(name, queued.job_id));
			return cloneStatus;
		},
			timeoutMs, sleep: io.sleep, now: io.now });
		const clone = identity(unique(await platforms(source), p => p.platform_index === cloneIndex, "completed clone"));
		for (const field of ["platform_uid", "surface_index", "force_name"]) {
			assert.equal(clone[field], cloneStatus.identity?.[field], `Clone ${field} changed after completion`);
		}
		assert.equal(clone.platform_name, name, "Clone name changed before identity capture");
		assert.notEqual(clone.platform_uid, fixture.platform_uid, "Clone reused the fixture identity");
		cleanup = { host: source, platform: clone };
		report(`Clone ready: ${name} (${clone.platform_uid})`);
		if (preparation) checked(await io.lua(source, `${currentLua(clone)}
local surface=p.surface
${preparation}
return {success=true}`));
		cleanup = undefined;
		const started = checked(await io.lua(source, `${currentLua(clone)}
local id,err=remote.call('surface_export','export_platform',p.index,'player',${ids[target]},nil,${quote(clone.platform_uid)})
return {success=type(id)=='string',jobId=id,error=err}`));
		assert.match(started.jobId, /^[A-Za-z0-9_-]+$/);
		transferId = `${ids[source]}:${started.jobId}`;
		report(`Tracking transfer ${transferId}`);
		const summary = await waitForProbeTransfer({
			read: async () => JSON.parse(String(await io.ctl("surface-export", "list-transfers", "500")).trim().split(/\r?\n/).at(-1)),
			transferId, sourceId: ids[source], targetId: ids[target], timeoutMs, sleep: io.sleep, now: io.now,
		});
		const receipt = checked(await io.lua(target, destinationReceiptLua(transferId))).receipt;
		assert.equal(receipt?.transfer_id, transferId, "Destination release receipt unavailable");
		const destination = identity(unique(await platforms(target), p => p.platform_index === receipt.platform_index, "destination"));
		for (const field of ["platform_uid", "surface_index", "force_name"]) {
			assert.equal(destination[field], receipt[field], `Destination ${field} changed`);
		}
		assert.ok(!(await platforms(source)).some(p => p.platform_index === clone.platform_index
			|| p.platform_uid === clone.platform_uid), "Source copy still present or its slot was reused; preserve platforms");
		cleanup = { host: target, platform: destination };
		result = { transferId, summary, source: clone, destination };
	} catch (error) {
		failure = error;
		if (!cleanup) report(`Platforms retained; inspect ${transferId || name}. No cleanup authority was established.`);
	} finally {
		if (cleanup && !keep) {
			try {
				const swept = assertFixtureCleanup(await io.lua(cleanup.host, cleanupProbeLua(cleanup.platform)));
				assert.equal(swept.swept, 1, "Probe cleanup did not remove exactly one platform");
				assert.ok(!(await platforms(cleanup.host)).some(p => p.platform_index === cleanup.platform.platform_index
					|| p.platform_uid === cleanup.platform.platform_uid), "Probe cleanup left a platform behind");
				report("Probe cleanup confirmed");
			} catch (error) {
				failure = failure ? new AggregateError([failure, error], `${failure.message}; cleanup failed: ${error.message}`) : error;
			}
		} else if (keep && cleanup) report(`Kept probe platform ${cleanup.platform.platform_uid}`);
	}
	if (failure) throw failure;
	report(`PASS ${transferId}: completed, source absent, destination released${keep ? " (kept)" : " and probe removed"}`);
	return result;
}
