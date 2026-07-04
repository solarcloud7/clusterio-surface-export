# Engineering FAQ — cross-instance platform transfer edge cases

> A **user-experience-first** checklist for the `surface_export` transfer pipeline: each row is *"What if the
> player/admin does X?"* answered with **how we engineer it TODAY**. Purpose — stop re-deriving edge cases ad hoc
> in every review. **Plan against this list**, and add a row the moment a new "what if" surfaces.
>
> Where there is **no shipped answer**, the row is flagged **⚠️ OPEN** — that decision belongs to a human
> engineer; do not invent an answer to close the gap. Keep this current as part of the `/di-change` gate.
>
> Related: [`TRANSFER_2PC_DESIGN.md`](TRANSFER_2PC_DESIGN.md) (Phase-2 failure-mode table),
> [`TRANSFER_2PC_PHASE1_REAUDIT.md`](TRANSFER_2PC_PHASE1_REAUDIT.md) (the `R#` fix references below),
> [`TRANSFER_WORKFLOW_GUIDE.md`](TRANSFER_WORKFLOW_GUIDE.md), and CLAUDE.md "Common Pitfalls" (`#NN`).

## Status legend
- ✅ **Handled** — shipped behavior today.
- 🔧 **Gap, fix planned** — known gap with a fix in flight (`R#` = the `feat/106` re-audit plan).
- ⚠️ **OPEN** — no engineered answer; needs a human-engineer decision.
- ❓ **Unverified** — behavior is believed but not empirically confirmed; needs a live test.

## The core invariant
The **source** platform is the at-risk resource. One rule governs everything below: **never delete the source
unless a validated copy exists on the destination AND the source is still the frozen thing we exported.** When
forced to choose, a **recoverable dup or stuck-lock always beats an unrecoverable deletion.**

## Open items needing a human-engineer decision (the "we don't have an answer" list)
- ⚠️ **Cargo-pod `awaiting_launch` item loss** (§D) — the one real *unresolved* data-loss path.
- ❓ **Can a hidden/frozen platform be renamed mid-transfer?** (§B) — needs a ~2-minute live test; the answer
  decides whether R9's rename-robustness is load-bearing or belt-and-suspenders.
- 🔧 **Export/file-lock strand policy** (§G) — accept manual-unlock recovery, or give transient export locks
  their own TTL?

---

## A. Interruptions & durability

**Q: What if the controller crashes / redeploys while my platform is mid-transfer?**
A: ✅ The source heals itself. The transfer lock carries a game-tick expiry (`kind="transfer"`, `expires_tick`)
in the source instance's own save, so it auto-**unlocks** (never deletes) after ~10 min and the platform
reappears in your list — no admin action. *(Before Phase 1: stuck locked-and-hidden forever until a manual
`/unlock-platform`.)*

**Q: What if my transfer takes longer than the 10-minute TTL (huge / laggy platform)?**
A: 🔧 The TTL fires mid-flight and the source goes live again. Today that risks the later success-delete
destroying a now-live source (re-audit R7). **Planned (R9):** the delete gate refuses to delete a source that is
no longer locked-for-transfer → a recoverable **dup** instead of loss. Eliminating the mid-flight unlock entirely
(controller heartbeat + canonical transfer id) is Phase 2.

**Q: What if the source server is down for a while during my transfer?**
A: ✅ The expiry clock is game-ticks, which do not advance while the host is down — downtime never causes a
spurious expiry.

## B. Concurrency

**Q: What if I start a transfer of the same platform twice?**
A: 🔧 In-game (`/transfer-platform`, `/gateway-transfer`) currently lets the 2nd command through (the F2 lock
backfill returns success) → dup. **Planned (R1):** transfer-trigger refuses if the platform is already locked;
**R9** delete-gate backstops it. The web/controller path was already permissive here (unchanged by this work; also
backstopped by R9).

**Q: What if I rename my platform (Space Platforms GUI) while it's transferring?**
A: 🔧 / ❓ Today the delete path cross-checks the mutable *name* and would **refuse** to delete the renamed source
→ dup. **Planned (R9):** key the delete's identity on the stable `surface.index` (a rename keeps it). ❓ Whether a
hidden+frozen platform can even be renamed in-GUI is **unverified** — needs a live test.

**Q: What if a platform index is reused by a new platform during my transfer?**
A: ✅ The name tripwire (and, post-R9, `surface.index`) refuses to unlock/delete the wrong platform — a
destructive op is never resolved by a non-unique key alone.

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
A: ✅ ~100% preserved; fluids injected **after** activation (segment ghost-buffer fix, Pitfall #17); fusion-output
rejections tracked and subtracted (#21); high-temperature fluids validated on thermal energy (#23).

**Q: What if some entities fail to place on the destination (missing mod)?**
A: ✅ Their items/fluids are tallied as failed-entity-loss and subtracted from expected totals so validation is
not falsely failed; each failure is logged per entity (Pitfall #20).

**Q: What if I have cargo pods waiting to launch (`awaiting_launch`) when I transfer?**
A: ⚠️ **OPEN — human call.** `complete_cargo_pods` currently `pod.destroy()`s them ("items stay in origin"); if
items were already loaded into the pod's `cargo_unit` inventory, `destroy()` deletes them = potential loss
(pre-existing; not introduced by #106). **Not handled.** Decision needed: recover the pod inventory into the hub
before destroy (mirroring the descending-pod path)?

## E. Passengers

**Q: What if a player is standing on my platform when it transfers?**
A: ✅ They (and abandoned character bodies) are evacuated to Nauvis at the sole delete chokepoint
(`Gateway.evacuate_passengers`) **before** teardown — never orphaned, never duplicated.

**Q: What if I'm connected and piloting the platform during the transfer?**
A: 🔧 The transfer is lossless, but the heavy export tick-stall heartbeat-drops your client (you reconnect and
land on Nauvis). "Ride with your platform to the next server" (Layer 2) is unbuilt.

## F. Locks & admin

**Q: What if I manually `/lock-platform` a platform — will the TTL auto-unlock it?**
A: ✅ No. Manual locks are kind-less; the expiry scan only touches `kind="transfer"` locks. Your admin lock stays
until you `/unlock-platform`.

**Q: What if I try to transfer a platform I've manually locked?**
A: ✅ Refused ("already locked by a non-transfer lock"); the admin lock is left intact.

**Q: What if a transfer lock is stranded and I want it back now, not in 10 minutes?**
A: ✅ `/unlock-platform <index>` frees it immediately.

## G. Non-transfer export / import

**Q: What if I export a platform to a file and the server crashes mid-export?**
A: 🔧 The export lock is kind-less → no TTL → the platform strands frozen until a manual `/unlock-platform`
(Gemini #2). No data loss (export deletes nothing). Follow-up: give transient export locks their own expiring
kind.

**Q: What if I import the same export JSON twice?**
A: ✅ You get two platforms — import is not deduped, by design. Caveat: a stranded-then-committed transfer's export
can linger in the Exports tab and be re-imported into a 3rd copy (re-audit R5 — documented Phase-1 corner).

---

## How to extend this doc
When any review, incident, or "huh, what happens if…" surfaces a new case: add a **"What if …"** row in the right
section, answer it with the **current** behavior, and mark the status honestly. If you cannot answer it from the
code, mark it **⚠️ OPEN** and raise it — an unanswered row is a real finding, not a formatting gap. The value of
this file is that the gaps are visible *before* a player hits them.
