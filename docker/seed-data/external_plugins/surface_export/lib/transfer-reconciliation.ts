/**
 * @file lib/transfer-reconciliation.ts
 * @description Pure decision core for reconciling a persisted `awaiting_validation` transfer after a
 * controller restart (#106). A transfer in that state relies on the in-memory activeTransfers record + the
 * validation timeout, both lost on a controller restart — so the source platform stays locked-and-hidden
 * until an admin `/unlock-platform`. On boot we re-load the persisted intents and reconcile each against the
 * DESTINATION's authoritative, `transferId`-keyed outcome record.
 *
 * This module is PURE (no I/O) so the safety-critical branch — the only path that DELETES a source platform
 * automatically — is exhaustively unit-tested. The controller feeds it the dest query result + liveness and
 * acts on the returned action. See CLAUDE.md Pitfall #28/#29 and the transfer two-phase-commit invariant:
 * a source is deleted ONLY on an authoritative "dest committed + validated success"; ANY ambiguity is never
 * resolved destructively.
 */

/**
 * The destination's authoritative answer for a transferId (from its persisted `transfer_outcomes` record +
 * a scan of its active import jobs). `null` means the query could not be completed (dest offline / errored).
 */
export interface DestTransferOutcome {
	/** The dest recorded a terminal outcome for this transferId (import ran to completion + validation). */
	found: boolean;
	/** When `found`: did the destination's validation PASS (i.e. it committed the platform)? */
	success: boolean;
	/** The dest currently has an in-flight import job for this transferId (still importing — not terminal). */
	inProgress: boolean;
}

export interface ReconcileInputs {
	/** The dest's outcome, or `null` when the dest could not be queried (offline / error). */
	outcome: DestTransferOutcome | null;
	/** Is the SOURCE instance online (needed to actually delete/unlock the source)? */
	sourceOnline: boolean;
	/** Age of the pending intent (now − startedAt), ms. Old + still-ambiguous ⇒ escalate to an admin warning. */
	ageMs: number;
	/** Ambiguity older than this escalates from silent `retry` to a loud `escalate`. */
	escalateAfterMs: number;
}

export type ReconcileAction =
	/** Dest committed + validated success ⇒ finish the two-phase commit: DELETE the source. */
	| { kind: "complete"; reason: string }
	/** Dest authoritatively holds nothing for this transfer ⇒ roll back: UNLOCK the source. */
	| { kind: "unlock"; reason: string }
	/** Not yet resolvable (dest offline/mid-import, or source offline) ⇒ leave persisted, try again later. */
	| { kind: "retry"; reason: string }
	/** Ambiguous for too long ⇒ leave the source locked but surface a LOUD admin warning (never auto-destroy). */
	| { kind: "escalate"; reason: string };

/**
 * Decide what to do with one persisted `awaiting_validation` intent. PURE + total over the input space.
 *
 * Safety invariants (the whole point of this being a tested pure function):
 * - `complete` (deletes the source) fires ONLY on `found && success` — an authoritative, transferId-keyed
 *   "the destination committed + validated" signal. Never on a name match, never on ambiguity.
 * - `unlock` (rolls back the source) fires ONLY on `found && !success` — the dest authoritatively imported
 *   then FAILED validation, so it holds no committed copy (matching the normal handleValidationFailure path).
 *   `!found` is NOT treated as authoritative (the record can be evicted / never-written / mid-delivery — see
 *   the #106 review), so it NEVER auto-unlocks.
 * - Any inability to be sure (dest offline, query failed, still importing, or a non-authoritative `!found`)
 *   ⇒ `retry`, escalating to `escalate` once it has been ambiguous longer than `escalateAfterMs`.
 */
export function resolvePendingTransfer(inputs: ReconcileInputs): ReconcileAction {
	const { outcome, sourceOnline, ageMs, escalateAfterMs } = inputs;
	const staleAmbiguous = ageMs > escalateAfterMs;

	// Dest could not be queried (offline or error) — cannot be sure of anything. Wait, then warn if stale.
	if (outcome === null) {
		return staleAmbiguous
			? { kind: "escalate", reason: "destination unreachable and pending has aged out — needs admin review" }
			: { kind: "retry", reason: "destination not reachable yet" };
	}

	// An authoritative terminal outcome takes precedence over `inProgress` — the outcome is recorded at
	// import-completion (after validation), so `found` means the destination is DONE with this transfer; a
	// lingering/finalizing import job must NOT keep us retrying forever on a transfer that already committed.
	if (outcome.found) {
		if (outcome.success) {
			// Dest committed + validated. Complete the two-phase commit by deleting the source — but only if
			// the source is reachable to delete; otherwise wait (never leave a committed dest with a live source
			// beyond what we can act on this pass).
			return sourceOnline
				? { kind: "complete", reason: "destination committed + validated (found+success)" }
				: { kind: "retry", reason: "source offline — cannot delete it yet (dest committed)" };
		}
		// Dest imported but validation FAILED → it discarded its copy (two-phase commit) → roll back the source.
		return sourceOnline
			? { kind: "unlock", reason: "destination validation failed (found, !success) — dest discarded its copy" }
			: { kind: "retry", reason: "source offline — cannot unlock it yet (dest failed)" };
	}

	// !found: no terminal outcome recorded. If the dest is still importing this transfer, wait.
	if (outcome.inProgress) {
		return { kind: "retry", reason: "destination has no outcome yet and is still importing" };
	}

	// !found and NOT in progress: `!found` is NOT authoritative — the outcome can be ABSENT even though the
	// destination committed a copy (record evicted by the bounded prune; a no-verification transfer that never
	// wrote one; a chunked payload still assembling before its import job exists — code-review #106 findings
	// 0/1/2). Auto-unlocking here would re-activate a source whose destination holds a committed copy =
	// DUPLICATION. So NEVER unlock on `!found`: keep retrying (the dest may still be mid-delivery), and once it
	// has aged past escalateAfterMs, ESCALATE — leave the source locked (recoverable) with a loud admin
	// warning rather than risk a duplicate.
	return staleAmbiguous
		? { kind: "escalate", reason: "no destination outcome and not importing, but `!found` is not authoritative (evicted / unwritten / mid-delivery) — leaving source locked for admin review" }
		: { kind: "retry", reason: "no destination outcome yet — `!found` is not authoritative; waiting for the dest" };
}
