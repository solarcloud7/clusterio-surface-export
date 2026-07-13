# Engineering FAQ — cross-instance platform transfer edge cases

> A **user-experience-first** checklist for the `surface_export` transfer pipeline: each row is *"What if the
> player/admin does X?"* answered with **how we engineer it TODAY**. Purpose — stop re-deriving edge cases ad hoc
> in every review. **Plan against this list**, and add a row the moment a new "what if" surfaces.
>
> Where there is **no shipped answer**, the row is flagged **⚠️ OPEN** — that decision belongs to a human
> engineer; do not invent an answer to close the gap. Keep this current as part of the `/di-change` gate.
>
> Related: [`TRANSFER_2PC.md`](TRANSFER_2PC.md) (the durable transfer design + current state — single source of
> truth), [`TRANSFER_WORKFLOW_GUIDE.md`](TRANSFER_WORKFLOW_GUIDE.md), and CLAUDE.md "Common Pitfalls" (`#NN`).

## Status legend
- ✅ **Handled** — shipped behavior today.
- 🔧 **Gap, fix planned** — known gap with a fix in flight (`R#` = the `feat/106` re-audit plan).
- ⚠️ **OPEN** — no engineered answer; needs a human-engineer decision.
- ❓ **Unverified** — behavior is believed but not empirically confirmed; needs a live test.

## The core invariant
The contract is **NO DUPLICATES** — never two live copies. Not transfer-at-any-cost. Side-scoped failsafes
enforce it by construction (DECIDED 2026-07-06):
- **Source (the original):** never deleted without a confirmed handshake (validated dest copy + identity
  intact). Failsafe: **unlock-only** — a stuck lock beats deleting the original.
- **Destination (staged copy, pre-handshake):** never goes live without a completed handshake. Failsafe:
  **discard-only** — at the deadline the staged artifact is deleted, whatever the failure reason. The handshake
  either completed or it did not; we do not invent a recovery flow per failure reason.

Duplication needs a live source AND a live dest copy — the symmetric failsafes make that impossible without a
completed handshake.

## Open items needing a human-engineer decision (the "we don't have an answer" list)
- ✅ **Export/file-lock strand policy** (§G, Non-transfer export/import) — transient export/file locks now use `kind="export"` with the same
  source-side TTL scan as transfer locks; manual kind-less locks remain manual.

*Resolved since first draft:* cargo-pod `awaiting_launch` loss → **fixed** zero-loss (§D, Data fidelity); rename-mid-transfer →
**confirmed a real duplication exploit + fixed** via `surface.index` identity, lint-enforced (§B Concurrency;
Pitfall #31, identity = `surface.index`, never the mutable name); source-dies-mid-transfer /
unrecoverable-counterpart policy → **DECIDED** handshake-or-discard, no force-resolve,
no admin recovery console (§A Interruptions & durability; TRANSFER_2PC.md core invariant).

---

## A. Interruptions & durability

**Q: What if the controller crashes / redeploys while my platform is mid-transfer?**
A: ✅ The source heals itself. The transfer lock carries a game-tick expiry (`kind="transfer"`, `expires_tick`)
in the source instance's own save, so it auto-**unlocks** (never deletes) after ~10 min and the platform
reappears in your list — no admin action. *(Before Phase 1: stuck locked-and-hidden forever until a manual
`/unlock-platform`.)*

**Q: What if my transfer takes longer than the 10-minute TTL (huge / laggy platform)?**
A: ✅ The TTL fires mid-flight and the source goes live again, but the delete gate now REFUSES to delete a source
that is no longer locked-for-transfer: `SurfaceLock.transfer_delete_identity_ok` requires the lock to still be
present with `kind="transfer"` (a TTL/admin release makes the platform live again ⇒ not deletable), AND correlates
the delete request to that lock by a name-free `transfer_job_id` + `surface.index`. Worst case is a recoverable
**dup**, never an unrecoverable deletion. Eliminating the mid-flight unlock entirely is **Phase 2**; both
prerequisites are now done (canonical transfer id SHIPPED #62; destination-hold primitive PROVEN #63), and the
decided failure contract is handshake-or-discard (see the §A Interruptions & durability source-dies entry +
TRANSFER_2PC.md core invariant).

**Q: What if the source server is down for a while during my transfer?**
A: ✅ The expiry clock is game-ticks, which do not advance while the host is down — downtime never causes a
spurious expiry.

**Q: What if the source instance dies (or goes permanently unreachable) while the destination is reconstructing
the platform?**
A: ⚠️ OPEN (policy DECIDED, wiring queued). 2PC wiring queued: `docs/superpowers/plans/2026-07-10-pr-3-executor-brief.md`.
TODAY the destination goes live on its OWN validation passing (the single exact gate — it is not held pending a
source-delete handshake), and the source is deleted only after. A source that dies inside that window can leave a
live destination — a **recoverable dup** (the source's own TTL failsafe unlocks the original whenever that save
next runs), never an unrecoverable deletion. The DECIDED (2026-07-06) end-state, once the handshake is wired: the
transfer **fails — black and white**; the destination discards its staged copy at the handshake deadline (a staged
copy never goes live without a completed handshake). We do not care WHY the handshake failed — host death,
partition, timeout — and there is deliberately **no force-resolve, no operator attestation, no "is the host
coming back" tracking**: a dest copy that never outlives a failed handshake can never collide with a resurrected
source, so the entire recovery-console problem vanishes by construction. Accepted residual: a source that
processed COMMIT and died inside the ack window loses the platform with the host — the same category as that
host dying with no transfer in flight, and rightable the same way: Clusterio's ops layer (dashboard save
download/upload, backups, logs) already provides disaster recovery. The transfer protocol does not re-implement
it. Inventing a solution per failure reason is over-engineering: the contract is either fulfilled or it is not.

**Q: What if the destination host/instance isn't ready (offline, stopped, still booting) when the transfer needs
it?**
A: ✅ / ⚠️ OPEN (handshake wiring queued). TODAY: the `sendTo`/`sendRequest` to an unreachable destination
instance rejects, the controller rolls back and unlocks the source at once (`tryUnlockSource`), and a retry is a
NEW transfer — no resume machinery. The "discard the staged copy if the destination shook hands then failed by a
deadline" half depends on the unbuilt handshake (2PC wiring queued:
`docs/superpowers/plans/2026-07-10-pr-3-executor-brief.md`); until it lands, a destination that goes live on its
own validation is not deadline-discarded.

## B. Concurrency

**Q: What if I start a transfer of the same platform twice?**
A: ✅ Defended at THREE layers, all SHIPPED. (1) The universal lock path refuses a second transfer's backfill
(`SurfaceLock.is_same_transfer_upgrade` — a different/token-less second attempt cannot overwrite the first
transfer's correlation token; covers in-game AND web/ctl routes). (2) The in-game front door refuses up front
(R1, `transfer-trigger.lua` — "already locked/transferring"). (3) The delete-gate backstop:
`transfer_delete_identity_ok`'s name-free `transfer_job_id` correlation refuses a stale/duplicate delete aimed
at a DIFFERENT transfer. (The on-arrival gateway chooser additionally blocks its own double-fire via
`GatewayGuard` IN_FLIGHT.)

**Q: What if I rename my platform (Space Platforms GUI) while it's transferring?**
A: ✅ Handled — and it was a real **duplication exploit**: renaming mid-transfer made the old name-based delete
check refuse the delete → source survived + dest committed = two copies. Renaming is a standard hub-GUI action
(wiki-confirmed). The transfer/delete identity now keys on the STABLE `surface.index` (never the mutable name), so
a rename is correctly IGNORED — same surface ⇒ same platform ⇒ the delete proceeds. Enforced by `lint:lua`
(Pitfall #31, identity = surface.index). Fixed 2026-07-04.

**Q: What if a platform index is reused by a new platform during my transfer?**
A: ✅ The delete/unlock identity keys on `surface.index` (recorded at lock time): a reused per-force index points
at a DIFFERENT surface, so `transfer_delete_identity_ok` refuses ("surface identity mismatch") — a destructive op
is never resolved by a non-unique key alone.

## C. Failure & rollback

**Q: What if the destination rejects my platform (mod / prototype mismatch)?**
A: ✅ The single exact gate fails (`failedStage` = the mismatched category, `items` or `fluids`). The **instance**
(Lua) then runs BLACK-BOX DISCARD: it banks an always-on forensic bundle to
`script-output/failure_black_box_<platform>_<tick>.json` (expected/actual/diff, dest force state, mods, a physical
entity scan of the dest), evacuates any passengers to Nauvis, and deletes the failed destination. The **controller**
unlocks the source **immediately** (`tryUnlockSource`). No loss; the source is restored, not trapped for the TTL.
(`import-completion.lua` bank+discard; Pitfall #28, the gate must count a complete state.) The unrelated
uploaded-JSON / clone import path still uses the loose tolerances — the exact gate is transfer-only.

**Q: What if a serializer bug forgets a whole container of state (like the burner-fuel incident) — does the exact gate catch it?**
A: ⚠️ Not by itself. The gate proves *serialized == restored*, not *source == destination* — an omission is absent
from both sides of the comparison, so the gate passes and the loss is silent. Items and fluids are protected today
by the CI meter-drift sentinel (`transfer-fidelity` compares the validator's expected counts against an independent
physical count of the source) and by the owner-approved paired-reads source census (in progress), which converts
any omission into a loud pre-transfer abort with the source preserved. Non-countable state (circuit configs,
crafting progress, schedules, spoilage) is protected only by enumeration — per-category handlers plus per-dimension
roundtrip fixtures. See the tier table in [parity-verification-model.md](parity-verification-model.md); never claim
"100%" without scoping it to tier 1 plus the enumerated tier-2 dimensions.

**Q: What if my platform is too big and the RCON / import send fails?**
A: ✅ A normal (non-session) error triggers controller rollback → source unlocked at once.

**Q: What if the network hiccups and we're unsure the import landed (`SessionLost`)?**
A: ✅ Deliberately does **not** unlock — the import may have landed, and unlocking could duplicate. Falls to the
TTL backstop instead. A recoverable stuck-then-unlock beats a dup.

**Q: What if validation fails AND the rollback unlock also fails?**
A: ✅ Marked `cleanup_failed`, the observability record is kept, and the source-side TTL backstops the unlock.
Symmetric on the destination side: if the black-box *banking itself* fails, the instance does NOT delete the
destination — it preserves the failed surface paused (also `cleanup_failed`) rather than destroy the only
remaining evidence.

**Q: What happens to my platform if a transfer fails validation?**
A: ✅ You keep your original — nothing is lost. The single exact gate runs in a paused, deactivated destination
BEFORE activation, so a mismatch is caught before the destination ever goes live. On failure: the source stays
put (unlocked, restored to your list), and the half-built destination is banked to a forensic black box and then
discarded (`failedStage` in the transaction log tells you whether items or fluids didn't reconcile). There is no
"partial" platform to clean up and no duplicate. (For deliberate post-mortem, an admin can arm the one-shot,
debug-gated `preserve_failed_destination` flag to keep the failed surface paused instead of discarding it — it is
consumed after a single use; Pitfall #30, mutating test hooks must be fail-safe on leak.)

## D. Data fidelity

**Q: What if my belts are packed with items?**
A: ✅ 100% preserved. The source uses an atomic single-tick belt scan, and the historical restore-time
residual once described as cosmetic ±4–8 drift has been fixed to zero (Pitfall #16, Verification Counts From Live Scan vs Serialized Data).

**Q: What if my inserters are holding items mid-swing?**
A: ✅ Restored via a pre-gate inserter-only activation pass so the strict gate counts a complete state (Pitfall
#28, the gate must count a complete state).

**Q: What if the destination force has less inserter-capacity research than mine?**
A: ✅ Import replicates the source force's inserter bonuses onto the dest force (raise-only) so held items seat
(Pitfall #29, dest-force research governs hand capacity).

**Q: What if I have fluids (chemical plants, foundries, fusion plasma)?**
A: ✅ Measured exact and enforced exact. R10/R11 grounded aggregate-by-name conservation, including frozen-world
injection at 1,359 entities (Pitfall #17, historical pre-activation fluid loss). The single gate requires zero
volume drift within `1e-6`; only engine-rejected fusion output writes are subtracted (Pitfall #21, fusion outputs
are engine-managed). Temperature remains diagnostic fidelity data (Pitfall #23, temperature merge and key boundaries).

**Q: What if fluids are lost after the item check?**
A: There is no second check. Lua completes held items and fluid restoration while the destination is paused and
deactivated, then emits one exact item+fluid verdict before activation. Any mismatch banks an always-on physical
black box, discards the destination, reports `failedStage=items|fluids`, and preserves/rolls back the source.
Post-activation recounts are reporting only and cannot rewrite the verdict.

**Q: What if I have circuit LATCHES, counters, or other circuit-network SIGNAL STATE?**
A: ⚠️ Circuit-network SIGNAL STATE does NOT survive a transfer — only circuit STRUCTURE does (wires,
combinator parameters, conditions all arrive verbatim). Measured live (2.0.77, `circuit-latch-state`): a
self-feeding SR latch holding signal-S=1 on the source (verified holding with its seed removed, two reads
apart) arrived with signal-S=0 — the latch RESETS. The serializer captures structure and parameters only
(connection-scanner); network signal values are engine simulation state with no capture/restore API used.
Any base whose behavior depends on a held latch value or an accumulated counter must expect that state to
re-derive or reset after transfer. (An earlier "latch value survived" reading was an instrument bug — the
seed combinator was never actually removed and kept feeding the latch; retracted in
`tests/state-dimensions-lab/NOTEBOOK.md`.)

**Q: What if some entities fail to place on the destination (missing mod)?**
A: ✅ Their items/fluids are tallied as failed-entity-loss and subtracted from expected totals so validation is
not falsely failed; each failure is logged per entity (Pitfall #20, failed-entity loss attribution).

**Q: What if I have cargo pods waiting to launch (`awaiting_launch`) when I transfer?**
A: ✅ Zero loss. `complete_cargo_pods` (during the lock step, before the export scan) recovers the pod's loaded
`cargo_unit` inventory into the hub, and **spills any overflow the hub can't hold onto the surface** (item-on-
ground is scanned/exported with the platform), THEN destroys the pod. So the items always stay on the platform
and transfer with it — even when the hub is full or absent. (Fixed 2026-07-04. Previously a bare `pod.destroy()`
deleted any already-loaded items; the first fix still lost a full-hub remainder until the spill was added.)

**Q: What if my platform's train/space schedule points at stations (space locations) that don't exist on the destination?**
A: ✅ On import, unroutable stops are filtered out — `PlatformSchedule.filter_for_import` drops any record whose
`station` isn't a routable `space_location` on the destination (`prototypes.space_location[station] == nil`) and
resumes the cursor at the first surviving stop. Guard: it **never strips to empty** — if EVERY stop is unroutable
it returns the original schedule untouched (an empty `records={}` is engine-rejected), leaving a lone dead stop
rather than an invalid schedule; a record with no string `station` is kept (never strip what we don't understand).
(WS1, #72.)

## E. Passengers

**Q: What if a player is standing on my platform when it transfers?**
A: ✅ They (and abandoned character bodies) are evacuated to Nauvis at the sole delete chokepoint
(`Gateway.evacuate_passengers`) **before** teardown — never orphaned, never duplicated.

**Q: What if I'm connected and piloting the platform during the transfer?**
A: 🔧 The transfer is lossless, but the heavy export tick-stall heartbeat-drops your client (you reconnect and
land on Nauvis). Since the post-export evacuate notice fires after you've already been dropped, each connected
passenger is now WARNED up front — before the export begins — that they're transferring and will return to Nauvis
(#86). "Ride with your platform to the next server" (Layer 2) is still unbuilt.

## F. Locks & admin

**Q: What if I manually `/lock-platform` a platform — will the TTL auto-unlock it?**
A: ✅ No. Manual locks are kind-less; the expiry scan only touches transient `kind="transfer"` and `kind="export"` locks. Your admin lock stays
until you `/unlock-platform`.

**Q: What if I try to transfer a platform I've manually locked?**
A: ✅ Refused ("already locked by a non-transfer lock"); the admin lock is left intact.

**Q: What if a transfer lock is stranded and I want it back now, not in 10 minutes?**
A: ✅ `/unlock-platform <index>` frees it immediately.

## G. Non-transfer export / import

**Q: What if I export a platform to a file and the server crashes mid-export?**
A: ✅ A non-issue. A crash rolls the instance back to its **last valid save**, where the platform is in a good
state (the in-flight export simply didn't happen — just re-run it); export deletes nothing. The narrower "save
taken while locked" case is also closed: export/file locks carry `kind="export"` + `expires_tick`, so a restored
locked platform **self-unlocks via the same TTL scan as transfer locks** — no manual `/unlock-platform` needed.
(Resolved 2026-07: formerly kind-less/OPEN.)

**Q: What if I import the same export JSON twice?**
A: ✅ You get two platforms — import is not deduped, by design. Caveat: a stranded-then-committed transfer's export
can linger in the Exports tab and be re-imported into a 3rd copy (re-audit R5 — documented Phase-1 corner).

## H. Gateways

**Q: What if my platform arrives at a gateway — does it auto-transfer?**
A: ✅ No. It routes to and **parks** at the gateway (`waiting_at_station`, paused; gateways have no `fly_condition`)
and NEVER auto-fires a transfer. On arrival, if that gateway has configured destinations, an on-arrival chooser
GUI opens for everyone currently VIEWING the platform (`control.lua` gateway-arrival detection); the transfer
itself is the player's explicit Transfer click inside that GUI, on a later tick. If the gateway has no configured
destinations, the platform just sits parked (no chooser).

**Q: What if I click Transfer twice, or a passenger is aboard, at the gateway?**
A: ✅ The chooser's Transfer is gated by `GatewayGuard`: the platform must be docked and NOT already in-flight, so
a double-click can't double-fire. Passengers do not block — they're evacuated to Nauvis at the delete chokepoint
(same answer as §E, Passengers — evacuation at the sole delete chokepoint).

## I. Persistence & degraded mode

**Q: What do I do if the Exports tab is suddenly empty?**
A: ✅ First check the controller log. The stored-exports file (`platformStorage`) is loaded once at controller
startup; if it is present but unreadable/corrupt (a genuinely absent file is a normal fresh start, not degraded),
the controller latches **degraded mode** — it keeps the existing
file **untouched** and DISABLES persistence for the session rather than overwrite your exports with an empty set
(the old wipe-on-read-failure bug, fixed in PR #81; guarded by the catch-swallow lint in PR #82). The log emits an
actionable `error` line with the exact file path, the root read error, and the recovery steps. To recover: stop
the controller, back up that file, repair it or move it aside, then restart so the load succeeds and your exports
reappear. Heads-up: exports you CREATE while degraded will not survive a restart (persistence is off) — recover
first.

**Q: The Transaction Logs tab is empty after a restart — did I lose my history?**
A: ✅ Same protection, different file. The transaction-history file is separate from stored exports; an unreadable
history file is left **untouched** (never truncated) and the tab simply appears empty for that session, with an
actionable `error` line naming the file and the recovery steps (restore from backup, or repair/move it aside, then
restart). Nothing is overwritten, so the on-disk history is recoverable. (PR #81 persistence hardening;
`lib/transaction-logger.ts`.)

---

## How to extend this doc
When any review, incident, or "huh, what happens if…" surfaces a new case: add a **"What if …"** row in the right
section, answer it with the **current** behavior, and mark the status honestly. If you cannot answer it from the
code, mark it **⚠️ OPEN** and raise it — an unanswered row is a real finding, not a formatting gap. The value of
this file is that the gaps are visible *before* a player hits them.
