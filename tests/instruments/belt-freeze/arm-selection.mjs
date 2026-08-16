// arm-selection — which belts the circuit arm tries, and what a still armed set means
//
// requires: mover unit lists and control moved/tracked counts the instrument measured itself
// produces: a candidate pool ordered by motion that PERSISTED across two windows, and a bounded
//           next-attempt plan (reselect / reclone / invalid) for the two PRE-WIRE failure points
// does not: measure anything, decide a verdict, or apply after the wire exists — a wired arm's
//           control count is zero in every green run, so a stall branch downstream of the wire
//           would read every one of them as a stall

export const ARM_ATTEMPT_LIMIT = 2;
export const STALL_MOVED_FRACTION = 0.05;
export const ARM_FAILURES = ["no-selection", "armed-set-still"];

function uniqueUnits(units, label) {
	if (!Array.isArray(units)) throw new Error(`${label} is not an array: ${JSON.stringify(units)}`);
	const seen = new Set();
	const out = [];
	for (const unit of units) {
		if (!Number.isFinite(unit)) throw new Error(`${label} carries a non-numeric unit: ${JSON.stringify(unit)}`);
		if (seen.has(unit)) continue;
		seen.add(unit);
		out.push(unit);
	}
	return out;
}

export function buildCandidatePool({ priorMovers = [], freshMovers = [] } = {}) {
	const prior = uniqueUnits(priorMovers, "priorMovers");
	const fresh = uniqueUnits(freshMovers, "freshMovers");
	const priorSet = new Set(prior);
	const freshSet = new Set(fresh);
	const persisted = fresh.filter(unit => priorSet.has(unit));
	const freshOnly = fresh.filter(unit => !priorSet.has(unit));
	const staleDropped = prior.filter(unit => !freshSet.has(unit)).length;
	return { pool: [...persisted, ...freshOnly], persisted: persisted.length, freshOnly: freshOnly.length, staleDropped };
}

export function planNextAttempt({ attempt, attemptLimit = ARM_ATTEMPT_LIMIT, failure, control } = {}) {
	if (!ARM_FAILURES.includes(failure)) {
		throw new Error(`unknown arm failure '${failure}' — expected one of ${ARM_FAILURES.join(", ")}`);
	}
	if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt must be a positive integer: ${attempt}`);
	if (!Number.isInteger(attemptLimit) || attemptLimit < 1) {
		throw new Error(`attemptLimit must be a positive integer: ${attemptLimit}`);
	}
	const moved = control?.moved;
	const tracked = control?.tracked;
	if (!Number.isFinite(moved) || !Number.isFinite(tracked) || tracked <= 0) {
		throw new Error(`control counts are unreadable: ${JSON.stringify(control)}`);
	}
	const movedFraction = moved / tracked;
	const stalled = movedFraction < STALL_MOVED_FRACTION;
	const measured = `control ${moved}/${tracked} moved (${movedFraction.toFixed(4)}), ` +
		`stall threshold ${STALL_MOVED_FRACTION}`;
	if (attempt >= attemptLimit) {
		return { action: "invalid", stalled, movedFraction,
			reason: `attempt ${attempt} of ${attemptLimit} — no retry left; ${measured}` };
	}
	if (stalled) {
		return { action: "reclone", stalled, movedFraction,
			reason: `the whole clone measured still, not just the armed set; ${measured}` };
	}
	if (failure === "armed-set-still") {
		return { action: "reselect", stalled, movedFraction,
			reason: `the clone kept moving while the armed set went still; ${measured}` };
	}
	return { action: "invalid", stalled, movedFraction,
		reason: `no wireable pair while the clone measured moving; ${measured} — a retry draws the same geometry` };
}
