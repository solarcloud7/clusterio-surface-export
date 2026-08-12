# Engineering FAQ — cross-instance platform transfer edge cases

> A **user-experience-first** checklist for the `surface_export` transfer pipeline: each row is *"What if the
> player/admin does X?"* answered with **how we engineer it TODAY**. Purpose — stop re-deriving edge cases ad hoc
> in every review. **Plan against this list**, and add a row the moment a new "what if" surfaces.
>
> Where there is **no shipped answer**, the row is flagged **⚠️ OPEN** — that decision belongs to a human
> engineer; do not invent an answer to close the gap. Keep this current as part of the `/di-change` gate.
>
> Related: [`TRANSFER_2PC.md`](TRANSFER_2PC.md) (the durable transfer design + current state — single source of
> truth), [`EXPORT_IMPORT_FLOW.md`](EXPORT_IMPORT_FLOW.md).

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
identity = `surface.index`, never the mutable name); source-dies-mid-transfer /
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
A: ⚠️ OPEN (policy DECIDED; the 2PC commit half — destination handshake before source delete — is designed but unwired).
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
A: ✅ / ⚠️ OPEN (handshake wiring queued). TODAY: the transfer is **refused up front**, twice over (owner ruling
2026-08-02: prevent the failure, don't build recovery for it). The web/ctl path preflights in
`handleStartPlatformTransferRequest` BEFORE the export request — nothing is locked or exported. The in-game
path preflights in `transferPlatform` before any transfer record exists; the refusal is printed IN GAME (red)
and the source is unlocked immediately — the refusal response carries `safeToUnlockSource`, the opt-in unlock
authority that is true only where the controller proved nothing was delivered (a post-acceptance failure must
keep the lock, or a validation success meets a delete gate with no lock and a duplicate survives). The
residual — an instance dying MID-transfer — still lands on the old path: the send rejects, the controller
rolls back and unlocks the source at once, and a retry is a NEW transfer. The "discard the staged copy if the
destination shook hands then failed by a deadline" half depends on the unbuilt handshake; until it lands, a
destination that goes live on its own validation is not deadline-discarded.

**Q: What if a controller persistence store (`exports.json` / `transactions.json`) becomes unreadable
(partial write, disk fault, hand-editing)?**
A: ✅ Fail-safe (persistence hardening, PR #81): the plugin **never overwrites a file it could not read** —
the load failure latches a degraded mode (`Refusing to persist …` / `skipping this write …` in the controller
log), the on-disk file is preserved byte-for-byte, and only records created *during* the degraded session are
at risk. **Recovery — never delete the damaged file** (that does by hand what the old bug did automatically):
stop the controller, back up the file (the log line names the path), repair it or move it aside, restart;
a clean load clears degraded mode and the UI tabs repopulate. The in-game `/transaction-dashboard` and banked
failure black boxes are independent stores and stay available throughout. These conditions are log-visible
only; there is no in-UI degraded banner.

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
(identity = surface.index). Fixed 2026-07-04.

**Q: What if a platform index is reused by a new platform during my transfer?**
A: ✅ The delete/unlock identity keys on `surface.index` (recorded at lock time): a reused per-force index points
at a DIFFERENT surface, so `transfer_delete_identity_ok` refuses ("surface identity mismatch") — a destructive op
is never resolved by a non-unique key alone.

## C. Failure & rollback

**Q: What if the destination rejects my platform (mod / prototype mismatch)?**
A: ✅ The single exact gate fails (`failedStage` = the mismatched category: `items`, `fluids`, or `belts` for a belt-census refusal). The **instance**
(Lua) then runs BLACK-BOX DISCARD: it banks an always-on forensic bundle to
`script-output/failure_black_box_<platform>_<tick>.json` (expected/actual/diff, dest force state, mods, a physical
entity scan of the dest), evacuates any passengers to Nauvis, and deletes the failed destination. The **controller**
unlocks the source **immediately** (`tryUnlockSource`). No loss; the source is restored, not trapped for the TTL.
(`import-completion.lua` bank+discard; the gate must count a complete state.) The unrelated
uploaded-JSON / clone import path still uses the loose tolerances — the exact gate is transfer-only.

**Q: What if a serializer bug forgets a whole container of state (like the burner-fuel incident) — does the exact gate catch it?**
A: ⚠️ Not by the frozen gate alone. It proves *serialized == restored*, not *source == destination* — an omission is
absent from both sides of that comparison, so the gate passes and the loss is silent. Top-level items and fluids are
protected in PRODUCTION by the **paired-reads source census** (SC-6, shipped): each entity's physical read is paired
with its serialized form in the same Lua execution, and any mismatch aborts the transfer fail-closed with the source
preserved and an entity-attributed forensic bundle banked. It is witnessed live by two pad fixtures through
`pad-transfer-suite` — `census-omission-abort` (the census refuses a forced omission) and `transfer-workhorse`
(the census ran + passed clean on a 1359-entity transfer). It replaced the old CI-only meter-drift sentinel.
Tier boundary: the census covers **top-level** items and fluids only — grid equipment and nested-inventory contents
are counted by neither meter, and non-countable state (circuit configs, crafting progress, schedules, spoilage) is
protected only by enumeration (per-category handlers plus the pad fixtures). See the tier table in the "guarantee
boundary" section of [testing.md](testing.md); never claim "100%" without scoping it to tier 1 (top-level items +
fluids) plus the enumerated tier-2 dimensions.

**Q: What if my platform is too big and the RCON / import send fails?**
A: ✅ A normal (non-session) error triggers controller rollback → source unlocked at once.

**Q: What if the network hiccups and we're unsure the import landed (`SessionLost`)?**
A: ✅ Deliberately does **not** unlock — the import may have landed, and unlocking could duplicate. The
transfer enters `awaiting_validation` and is resolved by the **validation timer** (next question); the
source-side TTL remains the backstop if the controller restarts. One interaction worth knowing: the
controller↔host reconnect backoff can reach **60 s** (`host.max_reconnect_delay`), which is longer than the
timer's 30 s default — a link blip that outlasts the timer settles the transfer as failed before the link
recovers, and the destination's verdict then arrives late (loudly refused and accounted, never silent). If
link blips are common on your network, set the validation timeout to 60 s or more to clear the backoff
window. A recoverable stuck-then-unlock beats a dup.

**Q: What if my import is slow and the validation timer expires before the destination reports?**
A: ✅ The transfer is rolled back on expiry: source unlocked and returned to you, nothing lost. The window
is the **"Transfer validation timeout (seconds)"** setting
(`surface_export.transfer_validation_timeout_seconds`, default 30 s, range 5–120 s — the ceiling protects
the source lock's 120 s validation budget — read per-transfer, no restart needed). The clock starts AFTER
the payload is delivered and accepted: it covers the destination's import + validation, not RCON delivery,
so size it to import time, not payload size. A **status guard** makes the short default safe: if the
destination finishes AFTER the timeout and sends its genuine verdict late, that verdict never drives a
source delete or a rollback — it is logged loudly as `validation_after_settle` and used only to correct the
record's leftover accounting. Outcomes from there: if the late verdict is a genuine FAILURE **and the
destination discarded itself cleanly**, a plain retry works; if that FAILURE reports `cleanup_failed` (the
discard itself failed) or `destinationPreserved` (the deliberate debug orphan), an orphan copy remains on
the target and the record is marked so the retry guard refuses until you remove it; if it is a late
SUCCESS, the destination went live before its verdict was refused, so a **live copy exists on the
destination alongside your restored source** — the transfer is re-marked `cleanup_failed` (its one meaning:
a platform was left behind), the retry guard refuses further attempts, and you delete the copy you don't
want before trying again. One sizing note: an import that genuinely needs more than the 120 s ceiling will
time out on every attempt — the handshake epic's hold-gated go-live is the real fix for imports that slow,
and it also removes the late-live residual entirely.

**Q: What if validation fails AND the rollback unlock also fails?**
A: ✅ The transfer is `failed`, the unlock error rides in the record, the observability intent is kept, and the
source-side TTL backstops the unlock. Nothing is left behind, so it does not wear `cleanup_failed` — that status
means exactly one thing: **a platform was left behind that automation could not remove** (a source that outlived
a committed transfer, or a failed destination whose delete the engine refused). On the destination side,
observability never gates the contract (owner ruling 2026-08-02): if the black-box *banking itself* fails, that
is a failure of our debugging — it is logged loudly and the discard proceeds anyway. No evidence is lost: on
failure the SOURCE is preserved (fail => revert), and the source is the authoritative copy of everything the
black box describes.

**Q: What happens to my platform if a transfer fails validation?**
A: ✅ You keep your original — nothing is lost. The single exact gate runs in a paused, deactivated destination
BEFORE activation, so a mismatch is caught before the destination ever goes live. On failure: the source stays
put (unlocked, restored to your list), and the half-built destination is banked to a forensic black box and then
discarded (`failedStage` in the transaction log names the stage that refused: items, fluids, or belts). There is no
"partial" platform to clean up and no duplicate — the discard is unconditional; the sole residual is the engine
itself refusing the delete (never observed), which is flagged loudly as `cleanup_failed` with the reason. (For
deliberate post-mortem, an admin can arm the one-shot, debug-gated `preserve_failed_destination` flag to keep the
failed surface paused instead of discarding it — it is consumed after a single use; mutating test hooks must be
fail-safe on leak.)

**Q: How should I triage a failure black box?**
A: Start with `failedStage`, then compare the expected/actual per-name rows. These signatures are known classes;
anything else stays unexplained until measured. Never loosen the exact gate to make a signature disappear.

| Failure signature | Known class | Operator action |
|---|---|---|
| `items`; one belt-attributed item name; small, single-digit `LOST` delta | Belt restoration stack-1/compression floor | Retry the transfer **once**. The source is preserved by the failed gate. If the same signature repeats, stop retrying and retain the new black box for the belt-loss rung. |
| `fluids`; mismatch is fusion plasma or another machine-buffered fluid | **Real fluid loss** — plasma is not special | Treat it as genuine loss, not a classification artifact. Do not compensate manually, do not relax the epsilon, and do not "exclude" the fluid. The gate refused correctly and the source is preserved; retain the black box and investigate the capture/restore path for that segment. |
| `items`; many unrelated names are `GAINED` together | Craft-window/non-frozen census | Treat this as an ordering or measurement failure, not created inventory. Check the black-box tick and paused/active state, and move the census back before any elapsed simulation tick. |

The belt class is fail-closed and remains mechanistically `UNEXPLAINED`; the deterministic replay and recovery
evidence live in the belt-lab NOTEBOOK (archived at git tag `labs-archive-2026-07-19`). Fluid handling — including
plasma, which rides a transfer like any other fluid — is covered by the `fluid-segment-law` selftest, the
`fusion-loop` pad, and the strict gate exercised by `pad-transfer-suite`. A retry is authorized only for the first
row and only once.

## D. Data fidelity

**Q: What if my belts are packed with items?**
A: Exact **global item conservation** is mandatory at the frozen `items` gate. When ordinary belt
restoration cannot reproduce a fully compressed state, the shipped hub/ground recovery may conserve the
deficit elsewhere and allow the transfer to pass. Exact whole-lane fidelity is therefore not yet guaranteed:
each continuous belt lane/side must retain its exact `(name, quality, stack count)` multiset and quantity,
while order, exact coordinate, and individual belt-tile window may change. BELT-R9 rejected cross-import
engine transport-line identity as a restoration key for the known DUP-233855 loss components. The proven
lab recipe is now side-scoped reverse first-fit with the `belt_speed` position floor (BELT-R10/R11/R12 —
243/243 and 431/431 with filtered purity preserved; production adoption pending the DUP-233855
kill-measurement). Belt physics facts live ONLY in the canonical belt section of
[factorio-2.0-api-notes.md](factorio-2.0-api-notes.md); do not restate them here. Preserve repeated small belt-loss black boxes
as described above rather than treating a globally green transfer as proof of whole-lane fidelity.

**Q: What if my inserters are holding items mid-swing?**
A: ✅ Restored via a pre-gate inserter-only activation pass so the strict gate counts a complete state.

**Q: What if the destination force has less inserter-capacity research than mine?**
A: ✅ Import replicates the source force's inserter bonuses onto the dest force (raise-only) so held items seat
(dest-force research governs hand capacity).

**Q: What if I have fluids (chemical plants, foundries, fusion plasma)?**
A: ✅ Measured exact and enforced exact. R10/R11 grounded aggregate-by-name conservation, including frozen-world
injection at 1,359 entities (historical pre-activation fluid loss). The single gate requires zero
volume drift within `1e-6`; fusion plasma is currently excluded on both sides (fusion plasma
handling — revision queued). Temperature remains
diagnostic fidelity data (temperature merge and key boundaries).

**Q: What if fluids are lost after the item check?**
A: There is no second check. Lua completes held items and fluid restoration while the destination is paused and
deactivated, then emits one exact item+fluid verdict before activation. Any mismatch banks an always-on physical
black box, discards the destination, reports `failedStage=items|fluids|belts`, and preserves/rolls back the source.
Post-activation recounts are reporting only and cannot rewrite the verdict.

**Q: What if I have circuit LATCHES, counters, or other circuit-network SIGNAL STATE?**
A: ✅ for self-feedback DECIDER latches; ⚠️ for everything else. Circuit STRUCTURE always arrives verbatim
(wires, combinator parameters, conditions). The decider's output register itself is not script-writable
(circuit-latch-rearm R1), so raw signal state cannot be restored — but since 2026-07-30 the
**post-activation latch re-arm pass** (`module/import_phases/latch_rearm.lua`) re-derives it for TRUE
latches only (deciders whose own output is wired back into their own input — ordinary deciders re-derive
naturally and are never touched): export captures the live register (`signals_last_tick`), and the import
preflights that the captured config writes, briefly forces the condition true for one evaluated tick,
restores it, then PHYSICALLY verifies the register against the capture (quality-keyed). On a count
mismatch (an output with `copy_count_from_input=false` emits 1, so a register holding e.g. 47 is not
reproducible) the pass first samples the register five times at pairwise-coprime gaps (13/17/19/23
ticks, `utils/signal-stability.lua`; uniform spacing would alias any register whose period divides the
gap) — wiring cannot distinguish a latch from a self-fed COUNTER, and a moving register is "not a
latch" and receives NO clearing write (it was still briefly forced and restored before classification,
like every scheduled decider). Only a register that held still across every sample is CLEARED back to
the pre-fix predictable 0, reported per decider — nothing fake stays in the network. The
`omnibus-decider-latch` pad asserts a transferred latch arrives ARMED on the destination board;
`tests/integration/latch-rearm-adversarial` asserts a latch and a counter on one platform get told
apart. Honest limits: an INDIRECT feedback loop (through a pole) is not detected and keeps the old
arrives-at-0 behavior; a register whose period exceeds the ~72-tick sampling window can still read
stable and be cleared. Gateway-parked transfers get the re-arm
— combinators evaluate on paused platforms (pause-rung, 2026-08-11; the old 30 s patience wait guarded
nothing and is deleted).

**A dark decider is not a still one.** The sampler compares registers and cannot see power, so an
unpowered decider — which returns an empty register on every sample — used to classify "stable",
license the clear, and then be recorded `cleared to 0 (verified)` on a read that returned nothing.
Since 2026-08-12 liveness is required at both moments a decider can be dark. Before the force write the
job DEFERS on a bounded deadline (1800 ticks, polled every 60) and on timeout finalizes
`unpowered — re-arm not evaluated` with the captured parameters preflight already wrote — no force, no
clear, and never a `rearmed` claim for a decider that never evaluated. During sampling, a decider that
stops evaluating is excluded from the clear entirely. Only `status == "working"` counts as a live
instrument.

Measured on 2.1.11 and **asserted by `tests/integration/latch-rearm-liveness` rather than recorded
here**: a powered decider reports `working` including while its platform is PAUSED — which is why this
gate does not break parked transfers — and a dark one reports `no_power` when the platform never had a
producer, or `low_power` when its producer was removed. That test also mutation-kills the guard:
rebinding `status_is_live` to always-true reproduces the false `cleared to 0 (verified)` on a real
unpowered decider.

Non-latch signal state (accumulated counters in networks, arithmetic-combinator
derived values) still re-derives or resets after transfer — engine simulation state with no
capture/restore API.

**Q: What if some entities fail to place on the destination (missing mod)?**
A: ✅ Their items/fluids are tallied as failed-entity-loss and subtracted from expected totals so validation is
not falsely failed; each failure is logged per entity (failed-entity loss attribution).

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
