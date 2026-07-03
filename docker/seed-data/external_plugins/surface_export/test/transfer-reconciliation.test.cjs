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

test("!found + !inProgress → NEVER unlock: retry when fresh, escalate when stale (!found is not authoritative)", () => {
	// #106 review: `!found` can be wrong three ways (evicted / unwritten / mid-delivery), so auto-unlocking on
	// it could free a source whose dest committed = dup. It must retry then escalate, never unlock.
	assert.equal(act({ found: false, success: false, inProgress: false }, true), "retry"); // fresh → wait
	assert.equal(act({ found: false, success: false, inProgress: false }, true, STALE), "escalate"); // aged out → admin
	assert.equal(act({ found: false, success: false, inProgress: false }, false), "retry"); // source offline too → wait
});

test("!found + inProgress → retry; a recorded outcome takes precedence over inProgress", () => {
	assert.equal(act({ found: false, success: false, inProgress: true }, true), "retry"); // no outcome yet, still importing
	assert.equal(act({ found: false, success: false, inProgress: true }, true, STALE), "retry"); // never escalates while importing
	// A recorded terminal outcome resolves even if an import job lingers/finalizes (found is authoritative) —
	// else a committed transfer would retry forever.
	assert.equal(act({ found: true, success: true, inProgress: true }, true), "complete");
	assert.equal(act({ found: true, success: false, inProgress: true }, true), "unlock");
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
				// The ONLY allowed destructive outcome across the entire space: an authoritative recorded
				// success, source reachable. (inProgress does NOT gate it — a recorded outcome is terminal.)
				const allowedComplete = outcome && outcome.found && outcome.success && sourceOnline;
				if (isDestructive) {
					assert.ok(allowedComplete, `complete must require found+success+sourceOnline; got ${JSON.stringify({ outcome, sourceOnline })}`);
				}
				// unlock fires ONLY on an authoritative found+!success (dest imported then failed → discarded).
				if (kind === "unlock") {
					assert.ok(outcome !== null && outcome.found && !outcome.success && sourceOnline, `unlock only on found+!success+sourceOnline; got ${JSON.stringify({ outcome, sourceOnline })}`);
				}
				// #106 review invariant: `!found` is NOT authoritative, so it must NEVER produce a
				// source-freeing (unlock) or source-destroying (complete) action — only retry/escalate.
				if (outcome !== null && !outcome.found) {
					assert.ok(kind === "retry" || kind === "escalate", `!found must be retry/escalate only, got '${kind}' for ${JSON.stringify({ outcome, sourceOnline })}`);
				}
			}
		}
	}
});
