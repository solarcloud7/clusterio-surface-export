const REQUIRED_RUNGS = ["spoilage", "damage", "cargo_pods"];
const DRIFT_EPSILON = 1e-9;

function fail(checks, failures, name, reason) {
	checks[name] = checks[name] || { ok: true, reasons: [] };
	checks[name].ok = false;
	checks[name].reasons.push(reason);
	failures.push(`${name}: ${reason}`);
}

function pass(checks, name) {
	checks[name] = checks[name] || { ok: true, reasons: [] };
}

function asNumber(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
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
	}
	const liveDrift = asNumber(rung.live_drift);
	const heldDrift = asNumber(rung.held_drift);
	if (liveDrift === null || heldDrift === null) {
		fail(checks, failures, name, "missing numeric live_drift/held_drift meters");
	} else if (heldDrift - liveDrift > DRIFT_EPSILON) {
		fail(checks, failures, name, `held drift ${heldDrift} exceeded live-control drift ${liveDrift}`);
	}
	const damage = asNumber(rung.platform_damage ?? 0);
	if (damage === null || damage !== 0) {
		fail(checks, failures, name, `platform damage was ${rung.platform_damage}`);
	}
	if (rung.nothing_left_platform !== true) {
		fail(checks, failures, name, "something left the platform or the runner did not prove platform containment");
	}
	if (name === "cargo_pods") {
		if (rung.staged_pod_free !== true) {
			fail(checks, failures, name, "staged platform was not pod-free after DestinationHold.stage()");
		}
		if (rung.overflow_preserved !== true) {
			fail(checks, failures, name, "overflow branch did not prove preservation");
		}
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
