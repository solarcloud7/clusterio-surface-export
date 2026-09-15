// requires: configured test cluster and independent fixture cases
// produces: one clone transfer, case verdicts and confirmed guarded cleanup
// does not: replay transfers or remove platforms after uncertain ownership
import assert from "node:assert/strict";
import { checked, currentLua, identity, listPlatforms, quote, transferPlatform, unique }
	from "../../../tools/surface-export/platform-transfer.mjs";
import { cleanupProbe } from "../../../tools/surface-export/transfer-probe.mjs";
import { cloneStatusLua, waitForFixtureClone } from "../../lab-gallery/clone-fixture.mjs";

export async function runFixtureTransfer({ cloneName, cases, fixture = "lab-transfer-fixture-v1", source = 1, target = 2 }, io) {
	assert.ok(cases.length > 0, "No fixture cases selected");
	quote(cloneName);
	const problems = [];
	const say = io.report || console.log;
	const fail = message => { problems.push(message); say(`  FAIL ${message}`); };
	const lua = (host, body) => checked(io.lua(host, body));
	let current, cleanup, transferred;
	const context = { ...io, lua, say, fail, pass: message => say(`  PASS ${message}`),
		SOURCE_HOST: source, DEST_HOST: target, CLONE: cloneName,
		platformLua: () => currentLua(current) + "\nlocal s = p.surface",
		storedField: field => io.storedField(transferred.transferId, field) };
	const selected = cases.map(create => create(context));
	try {
		for (const host of [source, target]) {
			assert.ok(!(await listPlatforms(io, host)).some(p => p.platform_name === cloneName), "Fixture name already exists");
		}
		const prior = lua(source, cloneStatusLua(cloneName, "fixture_preflight"));
		assert.ok(!prior.jobId && !prior.existingJobId, "Fixture name belongs to a retained clone job");
		const original = identity(unique(await listPlatforms(io, source), p => p.platform_name === fixture, "source fixture"));
		const queued = lua(source, `${currentLua(original)}
local r = remote.call('surface_export', 'clone_platform', p.index, ${quote(cloneName)})
if not (r and r.success) then return {success=false,error='Clone refused: '..tostring(r and r.message)} end
return {success=true,job_id=r.job_id}`);
		assert.ok(typeof queued.job_id === "string" && queued.job_id.length, "Clone job identity unavailable");
		let observation;
		await waitForFixtureClone({ read: () => (observation = lua(source, cloneStatusLua(cloneName, queued.job_id))),
			timeoutMs: 300_000, sleep: io.sleep, now: io.now });
		current = identity(observation.identity);
		assert.notEqual(current.platform_uid, original.platform_uid, "Clone reused original fixture identity");
		cleanup = { host: source, platform: current };
		for (const spec of selected) await spec.prepare();
		for (const spec of selected) await spec.source();
		if (problems.length) return { problems };
		transferred = await transferPlatform({ platform: current, source, target, ids: await io.instanceIds(), timeoutMs: 300_000 },
			{ ...io, lua, report: say, beforeExport: () => { cleanup = undefined; } });
		current = identity(transferred.destination);
		cleanup = { host: target, platform: current };
		for (const spec of [...selected].reverse()) await spec.verify(transferred.transferId);
		const summary = io.storedField(transferred.transferId, "summary");
		assert.equal(summary.transferId, transferred.transferId, "Stored verdict operation mismatch");
		assert.equal(summary.platform.name, cloneName, "Stored verdict platform mismatch");
		assert.equal(summary.result, "SUCCESS", "Stored transfer verdict failed");
	} finally {
		if (cleanup) {
			try { await cleanupProbe({ lua }, cleanup.host, cleanup.platform); }
			catch (error) { console.error(error); fail(`Fixture cleanup refused or unavailable: ${error.message}`); }
		} else say("Platforms retained: clone or transfer ownership is unresolved");
		for (const host of [source, target]) {
			try {
				const leftovers = (await listPlatforms(io, host)).filter(p => p.platform_name === cloneName);
				if (leftovers.length) fail(`Fixture remains on host ${host}`);
			} catch (error) { console.error(error); fail(`Leftover observation unavailable on host ${host}: ${error.message}`); }
		}
		try {
			if (lua(source, "return {success=true,paused=game.tick_paused}").paused !== false) fail("Source pause state is not confirmed unpaused");
		} catch (error) { console.error(error); fail(`Pause observation unavailable: ${error.message}`); }
	}
	return { problems, transferId: transferred?.transferId };
}
