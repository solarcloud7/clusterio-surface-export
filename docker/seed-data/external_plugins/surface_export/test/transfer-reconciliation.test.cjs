"use strict";
/**
 * Exhaustive safety test for the #106 restart-reconciliation decision core.
 *
 * The load-bearing invariant: `complete` (which DELETES a source platform automatically on controller boot)
 * fires ONLY on an authoritative, transferId-keyed "destination committed + validated" signal
 * (found && success) with the source reachable. Every other combination must resolve non-destructively
 * (unlock only when the dest authoritatively holds nothing; otherwise retry/escalate). This test enumerates
 * the whole input space so a future edit that widens the destructive branch goes RED.
 *
 * Runs against the COMPILED output (dist/node); `npm test` builds it first.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolvePendingTransfer } = require(path.join(__dirname, "..", "dist", "node", "lib", "transfer-reconciliation.js"));

const FRESH = { ageMs: 1_000, escalateAfterMs: 600_000 };
const STALE = { ageMs: 3_600_000, escalateAfterMs: 600_000 };

function act(outcome, sourceOnline, age = FRESH) {
	return resolvePendingTransfer({ outcome, sourceOnline, ageMs: age.ageMs, escalateAfterMs: age.escalateAfterMs }).kind;
}

test("complete (deletes source) fires ONLY on found+success+sourceOnline", () => {
	// The single destructive branch.
	assert.equal(act({ found: true, success: true, inProgress: false }, true), "complete");
	// Same authoritative success but source offline → must WAIT, never delete blindly.
	assert.equal(act({ found: true, success: true, inProgress: false }, false), "retry");
});

test("found + validation failed → unlock the source (dest discarded its copy)", () => {
	assert.equal(act({ found: true, success: false, inProgress: false }, true), "unlock");
	assert.equal(act({ found: true, success: false, inProgress: false }, false), "retry"); // source offline → wait
});

test("!found + !inProgress + dest online → unlock (dest never committed)", () => {
	assert.equal(act({ found: false, success: false, inProgress: false }, true), "unlock");
	assert.equal(act({ found: false, success: false, inProgress: false }, false), "retry"); // source offline → wait
});

test("inProgress → always retry (dest still importing — not terminal)", () => {
	assert.equal(act({ found: false, success: false, inProgress: true }, true), "retry");
	assert.equal(act({ found: true, success: true, inProgress: true }, true), "retry"); // inProgress wins over a stale record
	assert.equal(act({ found: false, success: false, inProgress: true }, true, STALE), "retry"); // never escalates while importing
});

test("dest unreachable (outcome null) → retry when fresh, escalate when stale — never destructive", () => {
	assert.equal(act(null, true, FRESH), "retry");
	assert.equal(act(null, true, STALE), "escalate");
	assert.equal(act(null, false, STALE), "escalate");
});

test("no destructive action on any non-authoritative or ambiguous input", () => {
	// Enumerate: outcome ∈ {null, all 8 boolean combos}, sourceOnline ∈ {t,f}, age ∈ {fresh, stale}.
	const bools = [true, false];
	const outcomes = [null];
	for (const found of bools) for (const success of bools) for (const inProgress of bools) {
		outcomes.push({ found, success, inProgress });
	}
	for (const outcome of outcomes) {
		for (const sourceOnline of bools) {
			for (const age of [FRESH, STALE]) {
				const kind = act(outcome, sourceOnline, age);
				const isDestructive = kind === "complete"; // unlock is non-destructive (frees a stuck source)
				// The ONLY allowed destructive outcome across the entire space:
				const allowedComplete = outcome && outcome.found && outcome.success && !outcome.inProgress && sourceOnline;
				if (isDestructive) {
					assert.ok(allowedComplete, `complete must require found+success+!inProgress+sourceOnline; got ${JSON.stringify({ outcome, sourceOnline })}`);
				}
				// unlock must never fire while the dest is still importing or unreachable.
				if (kind === "unlock") {
					assert.ok(outcome !== null && !outcome.inProgress && sourceOnline, `unlock only when dest reachable, not importing, source online; got ${JSON.stringify({ outcome, sourceOnline })}`);
				}
			}
		}
	}
});
