import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	CHECK_INTERFACE, CHECK_PLATFORMS, CHECK_RCON, CHECK_ROSTER, CHECK_SURFACES,
	evaluateReadiness, expectationsFor, loadReadinessManifest, runReadinessGate, toList,
} from "../../tools/tests/cluster-readiness.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST1 = "clusterio-host-1-instance-1";
const HOST2 = "clusterio-host-2-instance-1";

const manifest = loadReadinessManifest(repoRoot);
const expectations = expectationsFor(manifest);

function luaJsonList(list) {
	return list.length ? list : {};
}

function probeReply({ surfaces, platforms, players, tick = 1, iface = true }) {
	return {
		surfaces: luaJsonList(surfaces), surfaceCount: surfaces.length,
		platforms: luaJsonList(platforms), platformCount: platforms.length,
		players: luaJsonList(players), playerCount: players.length,
		tick, iface,
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
		`${HOST2}/${CHECK_INTERFACE}`, `${HOST2}/${CHECK_RCON}`,
		`${HOST2}/${CHECK_ROSTER}`, `${HOST2}/${CHECK_SURFACES}`,
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

test("the gate reports per-instance per-check lines and never probes on a healthy verdict twice", () => {
	const lines = [];
	let probeCalls = 0;
	const decision = runReadinessGate({
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
