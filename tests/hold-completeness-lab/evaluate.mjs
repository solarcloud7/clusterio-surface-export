const REQUIRED_RUNGS = ["spoilage", "damage", "cargo_pods"];

function fail(checks, failures, name, reason) {
	checks[name] = { ok: false, reason };
	failures.push(`${name}: ${reason}`);
}

function pass(checks, name) {
	checks[name] = { ok: true };
}

function validateRung(name, rung, checks, failures) {
	if (!rung || typeof rung !== "object") {
		fail(checks, failures, name, "missing required rung result");
		return;
	}
	if (rung.status !== "passed") {
		fail(checks, failures, name, `status ${rung.status || "missing"}${rung.reason ? ` (${rung.reason})` : ""}`);
		return;
	}
	if (rung.live_changed !== true) {
		fail(checks, failures, name, "live control did not move, so the rung did not prove the hold stopped anything");
		return;
	}
	if (rung.held_changed !== false) {
		fail(checks, failures, name, "held specimen changed while destination hold was active");
		return;
	}
	if (name === "cargo_pods" && rung.overflow_preserved !== true) {
		fail(checks, failures, name, "overflow branch did not prove preservation");
		return;
	}
	pass(checks, name);
}

export function evaluateHoldCompletenessResults(results) {
	const checks = {};
	const failures = [];
	const rungs = results?.rungs || {};
	for (const name of REQUIRED_RUNGS) {
		validateRung(name, rungs[name], checks, failures);
	}
	const reset = results?.final_reset;
	if (!reset || reset.zero_storage !== true || reset.zero_surfaces !== true || reset.game_paused !== false) {
		fail(checks, failures, "cleanup", `zero_storage=${reset?.zero_storage} zero_surfaces=${reset?.zero_surfaces} game_paused=${reset?.game_paused} leftovers=${JSON.stringify(reset?.leftovers || [])}`);
	} else {
		pass(checks, "cleanup");
	}
	return { ok: failures.length === 0, checks, failures };
}

export { REQUIRED_RUNGS };
