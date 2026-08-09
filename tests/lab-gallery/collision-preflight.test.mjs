import { test } from "node:test";
import assert from "node:assert/strict";

import { checkTransferIdCollisions, predictCanonicalIds } from "./batch-lifecycle.mjs";

const CANDIDATES = predictCanonicalIds({
	instanceId: 2, counter: 1785604898997, platformName: "lab-omnibus-state-v1", count: 3,
});

const summary = (transferId, registrySource, status = "completed") => ({
	transferId, status, registrySource, platformName: "lab-omnibus-state-v1", startedAt: 1,
});

test("an active FAILED record is NOT fatal — the orchestrator replaces it", () => {
	const verdict = checkTransferIdCollisions({
		candidates: CANDIDATES,
		summaries: [summary(CANDIDATES[1], "active", "failed")],
	});
	assert.equal(verdict.fatal, false);
	assert.equal(verdict.status, "replaceable");
	assert.match(verdict.message, /does NOT refuse/);
});

test("an active LIVE record is NOT fatal — the orchestrator dedupes", () => {
	for (const status of ["transporting", "awaiting_validation", "awaiting_completion", "in_progress"]) {
		const verdict = checkTransferIdCollisions({
			candidates: CANDIDATES,
			summaries: [summary(CANDIDATES[0], "active", status)],
		});
		assert.equal(verdict.fatal, false, `status=${status} returns idempotent success, it does not refuse`);
		assert.equal(verdict.status, "replaceable");
	}
});

test("an UNRECOGNISED registrySource is UNKNOWN, not history", () => {
	const verdict = checkTransferIdCollisions({
		candidates: CANDIDATES,
		summaries: [summary(CANDIDATES[0], "both")],
	});
	assert.equal(verdict.status, "unknown");
	assert.equal(verdict.fatal, false);
	assert.match(verdict.message, /provenance unknown/);
});

test("an ACTIVE hit is fatal and names the restart remedy", () => {
	const verdict = checkTransferIdCollisions({
		candidates: CANDIDATES,
		summaries: [summary(CANDIDATES[1], "active")],
	});
	assert.equal(verdict.status, "collision");
	assert.equal(verdict.fatal, true, "an activeTransfers hit WILL refuse the run — it must stop it up front");
	assert.match(verdict.message, /restart surface-export-controller/,
		"the remedy must be in the message; it was folklore derived from reading source for weeks");
	assert.match(verdict.message, /NOT consulted by the guard/,
		"must say the persisted log does not need clearing, or the operator chases the wrong store");
});

test("a PERSISTED-only hit is NOT fatal and says so", () => {
	const verdict = checkTransferIdCollisions({
		candidates: CANDIDATES,
		summaries: [summary(CANDIDATES[0], "persisted")],
	});
	assert.equal(verdict.status, "historical");
	assert.equal(verdict.fatal, false,
		"the retry guard never reads the persisted log — failing here would block runs on history, and a "
		+ "restart would not clear it, so the run could never proceed");
	assert.match(verdict.message, /no action needed/);
});

test("an UNKNOWN-provenance hit warns loudly but does not fail", () => {
	const verdict = checkTransferIdCollisions({
		candidates: CANDIDATES,
		summaries: [{ transferId: CANDIDATES[2], status: "completed", startedAt: 1 }],
	});
	assert.equal(verdict.status, "unknown");
	assert.equal(verdict.fatal, false);
	assert.match(verdict.message, /provenance unknown/);
	assert.match(verdict.message, /may or may not be refused/,
		"must not claim certainty it does not have");
});

test("ACTIVE wins when several candidates hit different registries", () => {
	const verdict = checkTransferIdCollisions({
		candidates: CANDIDATES,
		summaries: [summary(CANDIDATES[0], "persisted"), summary(CANDIDATES[2], "active")],
	});
	assert.equal(verdict.status, "collision");
	assert.equal(verdict.fatal, true);
	assert.match(verdict.message, new RegExp(CANDIDATES[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		"the fatal message must name the ACTIVE id, not the persisted one");
});

test("a CLEAR result never claims the IDs are free", () => {
	const verdict = checkTransferIdCollisions({
		candidates: CANDIDATES,
		summaries: [summary("2:999_something-else", "active")],
		limit: 200,
	});
	assert.equal(verdict.status, "clear");
	assert.equal(verdict.fatal, false);
	assert.match(verdict.message, /BEST-EFFORT/,
		"the query is windowed at `limit` and activeTransfers is pruned above 100, so absence proves "
		+ "nothing — a clear result that reads as a guarantee is how a check becomes trusted wrongly");
	assert.match(verdict.message, /pruned above 100/);
});

test("an UNAVAILABLE query is SKIPPED, not passed, and never fatal", () => {
	const verdict = checkTransferIdCollisions({ candidates: CANDIDATES, summaries: null });
	assert.equal(verdict.status, "skipped");
	assert.equal(verdict.fatal, false, "a diagnostic must never be able to fail the run it diagnoses");
	assert.match(verdict.message, /SKIPPED \(not passed\)/,
		"skipped must be visually distinct from clear — a silent skip reads as a passing check");
});

test("every branch produces a DISTINCT message", () => {
	const verdicts = [
		checkTransferIdCollisions({ candidates: CANDIDATES, summaries: [summary(CANDIDATES[0], "active")] }),
		checkTransferIdCollisions({ candidates: CANDIDATES, summaries: [summary(CANDIDATES[0], "active", "failed")] }),
		checkTransferIdCollisions({ candidates: CANDIDATES, summaries: [summary(CANDIDATES[0], "persisted")] }),
		checkTransferIdCollisions({ candidates: CANDIDATES, summaries: [{ transferId: CANDIDATES[0], status: "completed" }] }),
		checkTransferIdCollisions({ candidates: CANDIDATES, summaries: [] }),
		checkTransferIdCollisions({ candidates: CANDIDATES, summaries: null }),
	];
	const messages = verdicts.map(v => v.message);
	assert.equal(new Set(messages).size, messages.length, "two branches share a message");
	assert.equal(new Set(verdicts.map(v => v.status)).size, verdicts.length, "two branches share a status");
	assert.equal(verdicts.filter(v => v.fatal).length, 1, "exactly one branch may be fatal");
});
