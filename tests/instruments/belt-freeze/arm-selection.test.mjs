// arm-selection.test — the circuit arm's selection and retry decisions, driven by measured counts
//
// requires: nothing (pure module; every count below is quoted from a named CI run)
// produces: the incident run's own counts routed to a retry, healthy runs routed to a first-try
//           selection, the INVALID guard still firing once the retry budget is spent, and a
//           discriminator control showing the stall threshold separates the measured populations
// does not: run the instrument, contact a cluster, or claim the retry path was exercised live —
//           a CI run that selects first try never reaches it, and these stubs are its only evidence

import { test } from "node:test";
import assert from "node:assert/strict";

import {
	ARM_ATTEMPT_LIMIT, ARM_FAILURES, STALL_MOVED_FRACTION, buildCandidatePool, planNextAttempt,
} from "./arm-selection.mjs";

// ARM D control counts, read from the "ARM D armed, no wire" line of each run's Integration Tests job.
const INCIDENT_ARM_D = { run: "31920202572 attempt 1 (FAILED)", moved: 8, tracked: 433 };
const GREEN_ARM_D = [
	{ run: "31923281551", moved: 296, tracked: 432 },
	{ run: "31921375896", moved: 300, tracked: 431 },
	{ run: "31916072275", moved: 297, tracked: 432 },
	{ run: "31915165158", moved: 221, tracked: 425 },
];

function control({ moved, tracked }) {
	return { moved, tracked };
}

test("the retry budget is one attempt, bounded", () => {
	assert.equal(ARM_ATTEMPT_LIMIT, 2,
		"the arm gets one retry; a larger budget turns a jammed clone into minutes of CI time");
});

test("the incident's own counts route to a fresh clone", () => {
	const plan = planNextAttempt({ attempt: 1, failure: "armed-set-still", control: control(INCIDENT_ARM_D) });
	assert.equal(plan.action, "reclone", `run ${INCIDENT_ARM_D.run} must not be answered by re-selecting on a ` +
		"clone whose whole belt population measured still");
	assert.equal(plan.stalled, true);
	assert.match(plan.reason, /8\/433/);
});

test("a healthy clone with a still armed set re-selects in place, on every green run's counts", () => {
	for (const run of GREEN_ARM_D) {
		const plan = planNextAttempt({ attempt: 1, failure: "armed-set-still", control: control(run) });
		assert.equal(plan.action, "reselect", `run ${run.run}: ${run.moved}/${run.tracked} control belts moved — ` +
			"the world is alive, so the armed set going still is a selection draw, not a jam");
		assert.equal(plan.stalled, false);
	}
});

test("the stall threshold separates the measured populations, with margin on both sides", () => {
	const incidentFraction = INCIDENT_ARM_D.moved / INCIDENT_ARM_D.tracked;
	const greenFractions = GREEN_ARM_D.map(run => run.moved / run.tracked);
	assert.ok(incidentFraction < STALL_MOVED_FRACTION / 2,
		`incident fraction ${incidentFraction.toFixed(4)} must sit well below ${STALL_MOVED_FRACTION}`);
	assert.ok(Math.min(...greenFractions) > STALL_MOVED_FRACTION * 10,
		`the lowest green fraction ${Math.min(...greenFractions).toFixed(4)} must sit well above ` +
		`${STALL_MOVED_FRACTION}; a threshold inside the green population would retry healthy runs`);
});

test("the INVALID guard still fires once the retry is spent, jammed or healthy", () => {
	for (const counts of [INCIDENT_ARM_D, ...GREEN_ARM_D]) {
		for (const failure of ARM_FAILURES) {
			const plan = planNextAttempt({ attempt: ARM_ATTEMPT_LIMIT, failure, control: control(counts) });
			assert.equal(plan.action, "invalid", `run ${counts.run}, failure ${failure}: a second still arm is the ` +
				"state the rung must refuse to conclude from");
			assert.match(plan.reason, /no retry left/);
		}
	}
});

test("a healthy clone with no wireable pair is refused, not retried", () => {
	const plan = planNextAttempt({ attempt: 1, failure: "no-selection", control: control(GREEN_ARM_D[0]) });
	assert.equal(plan.action, "invalid",
		"a pair that cannot be formed while the clone measures moving is geometry — a retry draws the same belts");
});

test("a jammed clone with no candidate at all still gets its fresh clone", () => {
	const plan = planNextAttempt({ attempt: 1, failure: "no-selection", control: control(INCIDENT_ARM_D) });
	assert.equal(plan.action, "reclone");
});

test("the pool puts belts that moved in BOTH windows ahead of one-window movers", () => {
	const built = buildCandidatePool({ priorMovers: [9], freshMovers: [5, 9] });
	assert.deepEqual(built.pool, [9, 5],
		"belt 9 moved in both windows and belt 5 only in the fresh one — selecting 5 first is the draw that " +
		"put a belt one window from stillness into the armed set");
	assert.equal(built.persisted, 1);
	assert.equal(built.freshOnly, 1);
});

test("a belt that moved only in the STALE window never enters the pool", () => {
	const built = buildCandidatePool({ priorMovers: [7, 8], freshMovers: [8] });
	assert.deepEqual(built.pool, [8]);
	assert.equal(built.staleDropped, 1);
	assert.equal(buildCandidatePool({ priorMovers: [7], freshMovers: [] }).pool.length, 0,
		"a pool built from stale movers alone is empty — the vacuity control for the ordering above");
});

test("the pool de-duplicates and refuses a unit list that is not numeric", () => {
	assert.deepEqual(buildCandidatePool({ priorMovers: [4, 4], freshMovers: [4, 4, 6] }).pool, [4, 6]);
	assert.throws(() => buildCandidatePool({ priorMovers: ["4"], freshMovers: [] }), /non-numeric unit/);
	assert.throws(() => buildCandidatePool({ priorMovers: 4, freshMovers: [] }), /not an array/);
});

test("unreadable inputs throw rather than resolving to a plan", () => {
	assert.throws(() => planNextAttempt({ attempt: 1, failure: "belts-are-sad", control: { moved: 1, tracked: 2 } }),
		/unknown arm failure/);
	assert.throws(() => planNextAttempt({ attempt: 1, failure: "armed-set-still", control: { moved: 0, tracked: 0 } }),
		/control counts are unreadable/,
		"a zero population must not read as a stall — that is a broken measurement, not a jammed clone");
	assert.throws(() => planNextAttempt({ attempt: 0, failure: "armed-set-still", control: { moved: 1, tracked: 2 } }),
		/attempt must be a positive integer/);
});
