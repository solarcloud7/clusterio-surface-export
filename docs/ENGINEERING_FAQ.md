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
- ✅ **Export/file-lock strand policy** (§G) — transient export/file locks now use `kind="export"` with the same
  source-side TTL scan as transfer locks; manual kind-less locks remain manual.

*Resolved since first draft:* cargo-pod `awaiting_launch` loss → **fixed** zero-loss (§D); rename-mid-transfer →
**confirmed a real duplication exploit + fixed** via `surface.index` identity, lint-enforced (§B, Pitfall #31);
source-dies-mid-transfer / unrecoverable-counterpart policy → **DECIDED** handshake-or-discard, no force-resolve,
no admin recovery console (§A, TRANSFER_2PC.md core invariant).

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
decided failure contract is handshake-or-discard (see §A source-dies entry + TRANSFER_2PC.md core invariant).

**Q: What if the source server is down for a while during my transfer?**
A: ✅ The expiry clock is game-ticks, which do not advance while the host is down — downtime never causes a
spurious expiry.

**Q: What if the source instance dies (or goes permanently unreachable) while the destination is reconstructing
the platform?**
A: ✅ DECIDED (2026-07-06): the transfer **fails — black and white**. The destination discards its staged copy at
the handshake deadline (a staged copy never goes live without a completed handshake); the source's own TTL
failsafe unlocks the original whenever that save next runs. We do not care WHY the handshake failed — host death,
partition, timeout — and there is deliberately **no force-resolve, no operator attestation, no "is the host
coming back" tracking**: a dest copy that never outlives a failed handshake can never collide with a resurrected
source, so the entire recovery-console problem vanishes by construction. Accepted residual: a source that
processed COMMIT and died inside the ack window loses the platform with the host — the same category as that
host dying with no transfer in flight, and rightable the same way: Clusterio's ops layer (dashboard save
download/upload, backups, logs) already provides disaster recovery. The transfer protocol does not re-implement
it. Inventing a solution per failure reason is over-engineering: the contract is either fulfilled or it is not.

**Q: What if the destination host/instance isn't ready (offline, stopped, still booting) when the transfer needs
it?**
A: ✅ Fail fast. The controller already has the observability (host connected, instance running, healthchecks).
If the destination can't shake hands by the deadline, the transfer fails: staged copy discarded if one exists,
source unlocks via its TTL. A retry is a NEW transfer — no resume machinery.

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
(Pitfall #31). Fixed 2026-07-04.

**Q: What if a platform index is reused by a new platform during my transfer?**
A: ✅ The delete/unlock identity keys on `surface.index` (recorded at lock time): a reused per-force index points
at a DIFFERENT surface, so `transfer_delete_identity_ok` refuses ("surface identity mismatch") — a destructive op
is never resolved by a non-unique key alone.

## C. Failure & rollback

**Q: What if the destination rejects my platform (mod / prototype mismatch)?**
A: ✅ Validation fails → the controller unlocks the source **immediately** (`tryUnlockSource`) and discards the
dest copy. No loss; the source is restored, not trapped for the TTL.

**Q: What if my platform is too big and the RCON / import send fails?**
A: ✅ A normal (non-session) error triggers controller rollback → source unlocked at once.

**Q: What if the network hiccups and we're unsure the import landed (`SessionLost`)?**
A: ✅ Deliberately does **not** unlock — the import may have landed, and unlocking could duplicate. Falls to the
TTL backstop instead. A recoverable stuck-then-unlock beats a dup.

**Q: What if validation fails AND the rollback unlock also fails?**
A: ✅ Marked `cleanup_failed`, the observability record is kept, and the source-side TTL backstops the unlock.

## D. Data fidelity

**Q: What if my belts are packed with items?**
A: ✅ ~100% preserved via an atomic single-tick belt scan (±4–8 items is cosmetic redistribution, not loss —
Pitfall #16).

**Q: What if my inserters are holding items mid-swing?**
A: ✅ Restored via a pre-gate inserter-only activation pass so the strict gate counts a complete state (Pitfall
#28).

**Q: What if the destination force has less inserter-capacity research than mine?**
A: ✅ Import replicates the source force's inserter bonuses onto the dest force (raise-only) so held items seat
(Pitfall #29).

**Q: What if I have fluids (chemical plants, foundries, fusion plasma)?**
A: ✅ ~100% preserved; fluids injected **after** activation (the empirical inject-after-activation rule, Pitfall #17); fusion-output
rejections tracked and subtracted (#21); high-temperature fluids validated on thermal energy (#23).

**Q: What if some entities fail to place on the destination (missing mod)?**
A: ✅ Their items/fluids are tallied as failed-entity-loss and subtracted from expected totals so validation is
not falsely failed; each failure is logged per entity (Pitfall #20).

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
(same as §E).

---

## How to extend this doc
When any review, incident, or "huh, what happens if…" surfaces a new case: add a **"What if …"** row in the right
section, answer it with the **current** behavior, and mark the status honestly. If you cannot answer it from the
code, mark it **⚠️ OPEN** and raise it — an unanswered row is a real finding, not a formatting gap. The value of
this file is that the gaps are visible *before* a player hits them.
