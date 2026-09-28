import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	CHECK_INTERFACE, CHECK_LEFTOVERS, CHECK_PLATFORMS, CHECK_RCON, CHECK_RECOVERY, CHECK_ROSTER, CHECK_SURFACES, CHECK_VERSION,
	evaluateReadiness, evaluateRuntime, expectationsFor, expectedModuleVersion, latestRecoveryRefusal, loadReadinessManifest,
	probeReadiness, runReadinessGate, throwawayPrefixes, toList, waitForRuntime,
} from "../../tools/tests/cluster-readiness.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST1 = "host-1";
const HOST2 = "host-2";

const manifest = loadReadinessManifest(repoRoot);
const expectations = expectationsFor(manifest);

function luaJsonList(list) {
	return list.length ? list : {};
}

const VERSION = expectedModuleVersion();

function probeReply({ surfaces, platforms, players, tick = 1, iface = true, ready = true, version = VERSION }) {
	return {
		surfaces: luaJsonList(surfaces), surfaceCount: surfaces.length,
		platforms: luaJsonList(platforms), platformCount: platforms.length,
		players: luaJsonList(players), playerCount: players.length,
		tick, iface, ready, version,
	};
}

const healthyHost1 = () => probeReply({
	surfaces: ["nauvis", "platform-1", "platform-2", "platform-3"],
	platforms: ["lab-transfer-fixture-v1", "lab-omnibus-state-v1", "oneofeach-fixture-v1"],
	players: ["solarcloud7"],
	tick: 32220740,
});

const healthyHost2 = () => probeReply({
	surfaces: ["nauvis", "lab-gallery-index-v2"],
	platforms: [],
	players: ["solarcloud7"],
	tick: 9650328,
});

const blankBootedHost2 = () => probeReply({
	surfaces: ["nauvis"],
	platforms: [],
	players: [],
	tick: 8900,
});

const healthy = () => ({ [HOST1]: healthyHost1(), [HOST2]: healthyHost2() });

const failuresOf = decision => decision.results.filter(r => !r.ok).map(r => `${r.instance}/${r.checkId}`);
const pairsOf = decision => decision.results.map(r => `${r.instance}/${r.checkId}`);

test("the expectation set is grounded in the gallery manifest and is not empty", () => {
	assert.equal(expectations.length, 2);
	const source = expectations.find(e => e.instance === HOST1);
	const destination = expectations.find(e => e.instance === HOST2);

	assert.equal(source.role, "source");
	assert.equal(destination.role, "destination");
	assert.deepEqual(source.requiredPlatforms,
		["lab-omnibus-state-v1", "lab-transfer-fixture-v1", "oneofeach-fixture-v1"]);
	assert.ok(source.requiredSurfaces.includes("platform-1"));
	assert.ok(destination.requiredSurfaces.includes("lab-gallery-index-v2"),
		"the destination golden's discriminating surface must stay in the manifest, or the incident is undetectable");
	assert.deepEqual(destination.requiredPlatforms, []);
});

test("a healthy cluster passes, and every instance is actually evaluated", () => {
	const decision = evaluateReadiness(expectations, healthy());
	assert.equal(decision.ok, true, failuresOf(decision).join(", "));
	assert.deepEqual(pairsOf(decision).sort(), [
		`${HOST1}/${CHECK_INTERFACE}`, `${HOST1}/${CHECK_PLATFORMS}`, `${HOST1}/${CHECK_RCON}`,
		`${HOST1}/${CHECK_ROSTER}`, `${HOST1}/${CHECK_SURFACES}`,
		`${HOST1}/${CHECK_VERSION}`, `${HOST1}/${CHECK_RECOVERY}`, `${HOST1}/${CHECK_LEFTOVERS}`,
		`${HOST2}/${CHECK_INTERFACE}`, `${HOST2}/${CHECK_RCON}`,
		`${HOST2}/${CHECK_ROSTER}`, `${HOST2}/${CHECK_SURFACES}`,
		`${HOST2}/${CHECK_VERSION}`, `${HOST2}/${CHECK_RECOVERY}`, `${HOST2}/${CHECK_LEFTOVERS}`,
	].sort());
	for (const expectation of expectations) {
		assert.ok(decision.results.some(r => r.instance === expectation.instance),
			`${expectation.instance} produced no check results at all`);
	}
});

test("the measured incident state (host-2 blank-booted) fails at least two independent checks", () => {
	const decision = evaluateReadiness(expectations, { [HOST1]: healthyHost1(), [HOST2]: blankBootedHost2() });
	assert.equal(decision.ok, false);

	const failed = failuresOf(decision);
	assert.ok(failed.includes(`${HOST2}/${CHECK_SURFACES}`), failed.join(", "));
	assert.ok(failed.includes(`${HOST2}/${CHECK_ROSTER}`), failed.join(", "));
	assert.ok(failed.length >= 2);
	assert.deepEqual(failed.filter(f => f.startsWith(HOST1)), [],
		"host-1 was correctly seeded in the incident and must not be blamed");

	const surfaces = decision.results.find(r => r.instance === HOST2 && r.checkId === CHECK_SURFACES);
	assert.match(surfaces.detail, /lab-gallery-index-v2/);
	assert.equal(surfaces.category, "identity");
});

test("an empty Lua table from helpers.table_to_json is read as an empty list, not as absent", () => {
	assert.deepEqual(toList({}), []);
	assert.deepEqual(toList(undefined), []);
	assert.deepEqual(toList(["a"]), ["a"]);
	assert.equal(blankBootedHost2().players.length, undefined);

	const decision = evaluateReadiness(expectations, { [HOST1]: healthyHost1(), [HOST2]: blankBootedHost2() });
	const roster = decision.results.find(r => r.instance === HOST2 && r.checkId === CHECK_ROSTER);
	assert.equal(roster.ok, false, "an empty roster serialized as {} must still fail the roster check");
});

test("host-2 missing only its marker surface fails only the surface check", () => {
	const decision = evaluateReadiness(expectations, {
		[HOST1]: healthyHost1(),
		[HOST2]: probeReply({ surfaces: ["nauvis"], platforms: [], players: ["solarcloud7"] }),
	});
	assert.deepEqual(failuresOf(decision), [`${HOST2}/${CHECK_SURFACES}`]);
});

test("host-2 with only an empty roster fails only the roster check", () => {
	const decision = evaluateReadiness(expectations, {
		[HOST1]: healthyHost1(),
		[HOST2]: probeReply({ surfaces: ["nauvis", "lab-gallery-index-v2"], platforms: [], players: [] }),
	});
	assert.deepEqual(failuresOf(decision), [`${HOST2}/${CHECK_ROSTER}`]);
});

test("host-1 missing a fixture platform fails only the fixture-platform check", () => {
	const decision = evaluateReadiness(expectations, {
		[HOST1]: probeReply({
			surfaces: ["nauvis", "platform-1", "platform-2", "platform-3"],
			platforms: ["lab-omnibus-state-v1"],
			players: ["solarcloud7"],
		}),
		[HOST2]: healthyHost2(),
	});
	assert.deepEqual(failuresOf(decision), [`${HOST1}/${CHECK_PLATFORMS}`]);
	const platforms = decision.results.find(r => r.checkId === CHECK_PLATFORMS);
	assert.match(platforms.detail, /lab-transfer-fixture-v1/);
});

test("the banked one-of-each fixture is required by NAME, not by the surface string the engine gave it", () => {
	const decision = evaluateReadiness(expectations, {
		[HOST1]: probeReply({
			surfaces: ["nauvis", "platform-1", "platform-2", "platform-3"],
			platforms: ["lab-transfer-fixture-v1", "lab-omnibus-state-v1"],
			players: ["solarcloud7"],
		}),
		[HOST2]: healthyHost2(),
	});
	assert.deepEqual(failuresOf(decision), [`${HOST1}/${CHECK_PLATFORMS}`],
		"a re-bank that drops oneofeach-fixture-v1 but leaves any third platform must still fail");

	const platforms = decision.results.find(r => r.checkId === CHECK_PLATFORMS);
	assert.match(platforms.detail, /oneofeach-fixture-v1/);
	const surfaces = decision.results.find(r => r.instance === HOST1 && r.checkId === CHECK_SURFACES);
	assert.equal(surfaces.ok, true,
		"platform-3 is the engine's surface string, not the fixture — it cannot be the fixture's only witness");
});

test("a missing surface_export interface fails only the interface check", () => {
	const probes = healthy();
	probes[HOST1].iface = false;
	const decision = evaluateReadiness(expectations, probes);
	assert.deepEqual(failuresOf(decision), [`${HOST1}/${CHECK_INTERFACE}`]);
});

test("an unreachable instance is its own probe-error category, never a pass", () => {
	const decision = evaluateReadiness(expectations, {
		[HOST1]: healthyHost1(),
		[HOST2]: { error: "Instance is not running" },
	});
	assert.equal(decision.ok, false);

	const host2Results = decision.results.filter(r => r.instance === HOST2);
	assert.equal(host2Results.length, 1);
	assert.equal(host2Results[0].checkId, CHECK_RCON);
	assert.equal(host2Results[0].category, "probe-error");
	assert.match(host2Results[0].detail, /not running/);
});

test("an instance that was never probed fails rather than being skipped", () => {
	const decision = evaluateReadiness(expectations, { [HOST1]: healthyHost1() });
	assert.equal(decision.ok, false);
	assert.deepEqual(failuresOf(decision), [`${HOST2}/${CHECK_RCON}`]);
});

test("a probe whose list and count disagree is a probe error, not an identity verdict", () => {
	const probes = healthy();
	probes[HOST2].playerCount = 1;
	probes[HOST2].players = {};
	const decision = evaluateReadiness(expectations, probes);
	const host2Results = decision.results.filter(r => r.instance === HOST2);
	assert.equal(host2Results.length, 1);
	assert.equal(host2Results[0].category, "probe-error");
	assert.match(host2Results[0].detail, /players carries 0 entries but playerCount=1/);
});

test("an empty check list is a failure, not a vacuous pass", () => {
	assert.equal(evaluateReadiness([], {}).ok, false);
	assert.equal(evaluateReadiness(expectations, {}).ok, false);
});

test("a manifest that cannot discriminate a freshly generated world is refused", () => {
	const noSurfaces = structuredClone(manifest);
	noSurfaces.saves.destination.expectedCensus.surfaces = [];
	assert.throws(() => expectationsFor(noSurfaces), /names no expected surfaces/);

	const onlyNauvis = structuredClone(manifest);
	onlyNauvis.saves.destination.expectedCensus.surfaces = [{ name: "nauvis" }];
	assert.throws(() => expectationsFor(onlyNauvis), /freshly generated world/);
});

test("the gate reports per-instance per-check lines and never probes on a healthy verdict twice", async () => {
	const lines = [];
	let probeCalls = 0;
	const decision = await runReadinessGate({
		manifest,
		log: line => lines.push(line),
		probe: instances => {
			probeCalls += 1;
			assert.deepEqual(instances, [HOST1, HOST2]);
			return healthy();
		},
	});
	assert.equal(decision.ok, true);
	assert.equal(probeCalls, 1);
	assert.ok(lines.some(l => l.includes(HOST1) && l.includes(CHECK_PLATFORMS) && l.startsWith("  PASS")));
	assert.ok(lines.some(l => l.includes(HOST2) && l.includes(CHECK_SURFACES) && l.startsWith("  PASS")));
});

const REFUSAL = "2026-09-28T02:18:42.324Z Source recovery startup refused; platforms remain protected. Repair the cause and restart "
	+ "the instance: Unidentified platform in an older save; manual reconciliation required";

test("the measured Dev One state (refused recovery, leaked probe platform) fails only recovery and leftovers", () => {
	const blocked = probeReply({
		surfaces: ["nauvis", "platform-1", "platform-2", "platform-3", "platform-4"],
		platforms: ["lab-transfer-fixture-v1", "lab-omnibus-state-v1", "oneofeach-fixture-v1", "gwpark-probe-mukmetwc"],
		players: ["solarcloud7"], ready: false,
	});
	blocked.recoveryRefusal = REFUSAL;
	const decision = evaluateReadiness(expectations, { [HOST1]: blocked, [HOST2]: healthyHost2() });
	assert.deepEqual(failuresOf(decision).sort(), [`${HOST1}/${CHECK_LEFTOVERS}`, `${HOST1}/${CHECK_RECOVERY}`]);
	const recovery = decision.results.find(r => r.checkId === CHECK_RECOVERY && r.instance === HOST1);
	assert.equal(recovery.blocked, true);
	assert.match(recovery.detail, /Unidentified platform in an older save/);
	const leftovers = decision.results.find(r => r.checkId === CHECK_LEFTOVERS && r.instance === HOST1);
	assert.match(leftovers.detail, /gwpark-probe-mukmetwc/);
	assert.match(leftovers.detail, /cleanup-test-surfaces\.ps1 -DryRun/);
});

test("recovery that has not finished and logged no refusal is pending, not passed", () => {
	const decision = evaluateReadiness(expectations, { [HOST1]: healthyHost1(), [HOST2]: { ...healthyHost2(), ready: false } });
	assert.deepEqual(failuresOf(decision), [`${HOST2}/${CHECK_RECOVERY}`]);
	const recovery = decision.results.find(r => !r.ok);
	assert.equal(recovery.pending, true);
	assert.equal(recovery.blocked, undefined);
});

test("a stale module version fails only the version check", () => {
	const decision = evaluateReadiness(expectations, { [HOST1]: { ...healthyHost1(), version: "0.0.0-stale" }, [HOST2]: healthyHost2() });
	assert.deepEqual(failuresOf(decision), [`${HOST1}/${CHECK_VERSION}`]);
});

test("every shared throwaway prefix is detected as a leftover", () => {
	for (const prefix of throwawayPrefixes()) {
		const decision = evaluateReadiness(expectations, {
			[HOST1]: healthyHost1(),
			[HOST2]: probeReply({ surfaces: ["nauvis", "lab-gallery-index-v2"], platforms: [`${prefix}x1`], players: ["solarcloud7"] }),
		});
		assert.deepEqual(failuresOf(decision), [`${HOST2}/${CHECK_LEFTOVERS}`], prefix);
	}
});

test("only a refusal logged after the instance's latest start counts", () => {
	const line = (id, message, timestamp = "2026-09-28T00:00:00.000Z") => JSON.stringify({ instance_id: id, message, timestamp });
	const start = "Surface Export plugin initializing...";
	const refused = "Source recovery startup refused; platforms remain protected. Repair the cause and restart the instance: boom";
	assert.equal(latestRecoveryRefusal([line(1, start), line(1, refused, "T1")], 1), `T1 ${refused}`);
	assert.equal(latestRecoveryRefusal([line(1, refused), line(1, start)], 1), null);
	assert.equal(latestRecoveryRefusal([line(1, start), line(2, refused)], 1), null);
	assert.equal(latestRecoveryRefusal(["not json", "", line(1, start), "{", line(1, refused, "T2")], "1"), `T2 ${refused}`);
	assert.equal(latestRecoveryRefusal([], 1), null);
});

test("host logs are read only for instances whose recovery is not ready", () => {
	const asked = [];
	const probes = probeReadiness([HOST1, HOST2], {
		rcon: () => ({ [HOST1]: healthyHost1(), [HOST2]: { ...healthyHost2(), ready: false } }),
		logs: instances => { asked.push(...instances); return { [HOST2]: { refusal: REFUSAL } }; },
	});
	assert.deepEqual(asked, [HOST2]);
	assert.equal(probes[HOST2].recoveryRefusal, REFUSAL);
	assert.equal(probes[HOST1].recoveryRefusal, undefined);
	const unreadable = probeReadiness([HOST1, HOST2], {
		rcon: () => ({ [HOST1]: healthyHost1(), [HOST2]: { ...healthyHost2(), ready: false } }),
		logs: () => ({ [HOST2]: { error: "no such container" } }),
	});
	assert.equal(unreadable[HOST2].recoveryLogError, "no such container");
	assert.equal(probeReadiness([HOST1], { rcon: () => ({ [HOST1]: healthyHost1() }), logs: () => assert.fail("read logs") })[HOST1].ready, true);
});

function clock() {
	let now = 0;
	return { now: () => now, sleep: async ms => { now += ms; } };
}

test("the gate polls while recovery is only pending, then passes", async () => {
	let calls = 0;
	const decision = await runReadinessGate({ manifest, log: () => {}, ...clock(),
		probe: () => ++calls < 3 ? { [HOST1]: { ...healthyHost1(), ready: false }, [HOST2]: healthyHost2() } : healthy() });
	assert.equal(decision.ok, true);
	assert.equal(calls, 3);
});

test("the gate stops polling at once on a refusal or any identity failure, and at its deadline", async () => {
	for (const bad of [{ ...healthyHost1(), ready: false, recoveryRefusal: REFUSAL }, { ...healthyHost1(), iface: false },
		{ ...healthyHost1(), ready: false, iface: false }]) {
		let calls = 0;
		const decision = await runReadinessGate({ manifest, log: () => {}, ...clock(),
			probe: () => { calls++; return { [HOST1]: bad, [HOST2]: healthyHost2() }; } });
		assert.equal(decision.ok, false);
		assert.equal(calls, 1);
	}
	let calls = 0;
	const lines = [];
	const decision = await runReadinessGate({ manifest, log: line => lines.push(line), timeoutMs: 10_000, ...clock(),
		probe: () => { calls++; return { [HOST1]: healthyHost1(), [HOST2]: { ...healthyHost2(), ready: false } }; } });
	assert.equal(decision.ok, false);
	assert.equal(calls, 6);
	assert.ok(lines.some(l => l.startsWith("  FAIL") && l.includes(HOST2) && l.includes(CHECK_RECOVERY)));
});

test("runtime readiness requires finished recovery and fails at once with the refusal line", async () => {
	const runtime = (overrides = {}) => ({ [HOST1]: { ...healthyHost1(), ...overrides }, [HOST2]: healthyHost2() });
	assert.deepEqual(evaluateRuntime(runtime(), VERSION).filter(r => !r.ok), []);
	assert.deepEqual(evaluateRuntime(runtime({ ready: false }), VERSION).filter(r => !r.ok).map(r => `${r.instance}/${r.checkId}`),
		[`${HOST1}/${CHECK_RECOVERY}`]);
	let calls = 0;
	await assert.rejects(waitForRuntime({ expectedVersion: VERSION, ...clock(),
		probe: () => { calls++; return runtime({ ready: false, recoveryRefusal: REFUSAL }); } }),
	/host-1: startup recovery refused, exports fail until repaired: .*Unidentified platform in an older save/);
	assert.equal(calls, 1);
	calls = 0;
	const result = await waitForRuntime({ expectedVersion: VERSION, ...clock(),
		probe: () => ++calls < 4 ? runtime({ ready: false }) : runtime() });
	assert.equal(calls, 4);
	assert.ok(result.results.every(r => r.ok));
});
