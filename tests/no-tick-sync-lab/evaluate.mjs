const REQUIRED_RUNGS = ["strict_gate_pass"];

function fail(checks, failures, name, reason) {
	checks[name] = checks[name] || { ok: true, reasons: [] };
	checks[name].ok = false;
	checks[name].reasons.push(reason);
	failures.push(`${name}: ${reason}`);
}

function pass(checks, name) {
	checks[name] = checks[name] || { ok: true, reasons: [] };
}

function sameJson(a, b) {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function validateStrictGatePass(rung, checks, failures) {
	const name = "strict_gate_pass";
	if (!rung || typeof rung !== "object") {
		fail(checks, failures, name, "missing required rung result");
		return;
	}
	if (rung.status !== "passed") {
		fail(checks, failures, name, `status ${rung.status || "missing"}${rung.reason ? ` (${rung.reason})` : ""}`);
		return;
	}
	if (rung.tick_before !== rung.tick_after) {
		fail(checks, failures, name, `tick advanced from ${rung.tick_before} to ${rung.tick_after}`);
	}
	if (rung.crafting_progress_before !== rung.crafting_progress_after) {
		fail(checks, failures, name, `crafting_progress changed from ${rung.crafting_progress_before} to ${rung.crafting_progress_after}`);
	}
	if (!sameJson(rung.held_item_after_restore, rung.held_item_after_validation)) {
		fail(checks, failures, name, `held item changed after restore: ${JSON.stringify(rung.held_item_after_restore)} -> ${JSON.stringify(rung.held_item_after_validation)}`);
	}
	if (rung.held_item_intentional_restore !== true) {
		fail(checks, failures, name, "runner did not prove the held-item delta was the intended restore write");
	}
	if (rung.validation_called !== true) {
		fail(checks, failures, name, "strict validation was not called");
	}
	if (rung.validation_success !== true) {
		fail(checks, failures, name, `validation did not succeed: ${rung.validation_message || "no message"}`);
	}
	pass(checks, name);
}

export function evaluateNoTickSyncResults(results) {
	const checks = {};
	const failures = [];
	const rungs = results?.rungs || {};
	for (const name of REQUIRED_RUNGS) {
		if (name === "strict_gate_pass") validateStrictGatePass(rungs[name], checks, failures);
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
