import { test } from "node:test";
import assert from "node:assert/strict";

import {
	ABSENT, DEFAULT_TIMEOUT_MS, EXIT_PROBE_ERROR, EXIT_SEEDED, EXIT_TIMEOUT, PRESENT, SEED_MARKER,
	awaitSeeding, decideSeedWait, exitCodeFor,
} from "../../tools/clusterio/ci-await-seeding.mjs";

const TIMEOUT_MS = 60_000;

test("an absent marker inside the deadline keeps waiting", () => {
	const decision = decideSeedWait({ probe: { token: ABSENT }, elapsedMs: 12_000, timeoutMs: TIMEOUT_MS });
	assert.equal(decision.status, "waiting");
	assert.match(decision.detail, /still seeding after 12s/);
});

test("a present marker ends the wait and reports how long it took", () => {
	const decision = decideSeedWait({ probe: { token: PRESENT }, elapsedMs: 43_000, timeoutMs: TIMEOUT_MS });
	assert.equal(decision.status, "seeded");
	assert.match(decision.detail, /observed after 43s/);
	assert.equal(exitCodeFor(decision.status), EXIT_SEEDED);
});

test("an absent marker at the deadline fails loud instead of proceeding", () => {
	const decision = decideSeedWait({ probe: { token: ABSENT }, elapsedMs: TIMEOUT_MS, timeoutMs: TIMEOUT_MS });
	assert.equal(decision.status, "timeout");
	assert.match(decision.detail, /never appeared within 60s/);
	assert.match(decision.detail, /golden save/);
	assert.equal(exitCodeFor(decision.status), EXIT_TIMEOUT);
});

test("a docker-level failure is NOT folded into 'still waiting' — it exits on its own code", () => {
	const decision = decideSeedWait({
		probe: { error: "Error: No such container: surface-export-controller" },
		elapsedMs: 1_000, timeoutMs: TIMEOUT_MS,
	});
	assert.equal(decision.status, "probe-error");
	assert.match(decision.detail, /No such container/);
	assert.equal(exitCodeFor(decision.status), EXIT_PROBE_ERROR);
	assert.notEqual(EXIT_PROBE_ERROR, EXIT_TIMEOUT);
});

test("an unrecognised reply is a probe error, not a silent absent", () => {
	for (const token of ["", "OCI runtime exec failed", undefined]) {
		const decision = decideSeedWait({ probe: { token }, elapsedMs: 1_000, timeoutMs: TIMEOUT_MS });
		assert.equal(decision.status, "probe-error", `token ${JSON.stringify(token)} must not read as absent`);
	}
});

test("the marker path and default deadline are the ones the controller entrypoint writes to", () => {
	assert.equal(SEED_MARKER, "/clusterio/data/.seed-complete");
	assert.ok(DEFAULT_TIMEOUT_MS >= 300_000, "the seed's own start budget is 120s per instance for two instances");
});

test("awaitSeeding polls until the marker appears, then stops", async () => {
	const tokens = [ABSENT, ABSENT, PRESENT];
	let clock = 0;
	const slept = [];
	const decision = await awaitSeeding({
		probe: () => ({ token: tokens.shift() }),
		log: () => {},
		sleep: async ms => { slept.push(ms); clock += ms; },
		now: () => clock,
		timeoutMs: TIMEOUT_MS,
		pollIntervalMs: 4_000,
	});
	assert.equal(decision.status, "seeded");
	assert.deepEqual(slept, [4_000, 4_000]);
	assert.equal(tokens.length, 0);
});

test("awaitSeeding gives up loudly once the deadline passes", async () => {
	let clock = 0;
	const decision = await awaitSeeding({
		probe: () => ({ token: ABSENT }),
		log: () => {},
		sleep: async ms => { clock += ms; },
		now: () => clock,
		timeoutMs: 12_000,
		pollIntervalMs: 4_000,
	});
	assert.equal(decision.status, "timeout");
	assert.equal(exitCodeFor(decision.status), EXIT_TIMEOUT);
});

test("awaitSeeding stops on the first docker failure rather than burning the deadline", async () => {
	let probes = 0;
	let clock = 0;
	const decision = await awaitSeeding({
		probe: () => { probes += 1; return { error: "Cannot connect to the Docker daemon" }; },
		log: () => {},
		sleep: async ms => { clock += ms; },
		now: () => clock,
		timeoutMs: TIMEOUT_MS,
		pollIntervalMs: 4_000,
	});
	assert.equal(decision.status, "probe-error");
	assert.equal(probes, 1);
});
