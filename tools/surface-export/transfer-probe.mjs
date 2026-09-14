// requires: structured Lua/Clusterio responses and a disposable clone
// produces: operation-specific completion and identity-checked cleanup
// does not: interpret absence or timeouts as permission to delete or replay
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { cloneStatusLua, waitForFixtureClone } from "../../tests/lab-gallery/clone-fixture.mjs";
import { fixtureSweepLua, assertFixtureCleanup } from "../../tests/lab-gallery/fixture-cleanup.mjs";

import { quote, checked, identity, unique, currentLua, listPlatforms, transferPlatform } from "./platform-transfer.mjs";

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

export async function cleanupProbe(io, host, platform) {
	const swept = assertFixtureCleanup(await io.lua(host, cleanupProbeLua(platform)));
	assert.equal(swept.swept, 1, "Probe cleanup did not remove exactly one platform");
	assert.ok(!(await listPlatforms(io, host)).some(p => p.platform_index === platform.platform_index
		|| p.platform_uid === platform.platform_uid), "Probe cleanup left a platform behind");
	return swept;
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
	const platforms = host => listPlatforms(io, host);
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
		result = await transferPlatform({ platform: clone, source, target, ids, timeoutMs }, io);
		transferId = result.transferId;
		cleanup = { host: target, platform: result.destination };
	} catch (error) {
		failure = error;
		transferId = error.transferId ?? transferId;
		if (!cleanup) report(`Platforms retained; inspect ${transferId || name}. No cleanup authority was established.`);
	} finally {
		if (cleanup && !keep) {
			try {
				await cleanupProbe(io, cleanup.host, cleanup.platform);
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
