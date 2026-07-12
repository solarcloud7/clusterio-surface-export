# Belt Lab — Notebook (append-only)

Isolated, same-surface belt capture/restore experiments on the pinned **2.0.76** engine. Goal: literal-zero
belt fidelity. Nothing durable lives in chat — every experiment is a saved script + a notebook entry here.

> **UNTRACKED** by git until a conclusion is worth committing (user policy). Do not `git add` this dir.

## TRIED & SETTLED (the empirical DO-NOT-REPEAT ledger — consult before trying anything)

| Claim / approach | Verdict | Evidence |
|---|---|---|
| Ground-spill unplaceable belt items to the floor | ❌ REJECTED (user) | items on belts must stay on belts |
| Silently drop the residual (`failed_count`) | ❌ REJECTED (user) | no silent loss |
| Per-line `insert_at_back` back-fill while-loop | ❌ DUPLICATES on segments | this session: +40/+56 GAIN (railgun-ammo/explosive-rocket) |
| Predict-and-subtract held items from expected | ❌ silent loss | PR #25 (closed) |
| Move validation after activation | ❌ craft-gain false failures | Pitfall #15 |
| Loosen tolerance to pass the gate | ❌ masks loss | whack-a-mole |
| Trust one meter / "green locally" | ❌ local ≠ CI; meters disagree | segment_delta −11 vs gate −8, same run |
| `line[i]` index op as capture/restore primitive | ❌ ruled out by docs | LuaItemStack, no position; can't place on empty line |
| Engine-native `clone` as lossless control | ❌ loses underground buried items | forum t=98221; +1-tick active drift |
| `get_detailed_contents()` element has `.name/.count/.quality` | ❌ FALSE | fields are `{stack, position, unique_id}` (2.0.76 docs) |
| Single-pass create+restore | ❌ undergrounds fail (line not merged yet) | merged line incomplete until all ends exist → must two-pass |
| Merged-line double-read causes undergrounds export double-count | ❌ REFUTED | R0: line_equals all-false, DUP_UIDS none, capture sound |
| insert_at loses items via micro-collision on dense mid-motion belts | ❌ REFUTED | R1b dense: 112=112, 0 drops on jam-packed corner loop |
| capture→sorted insert_at + two-pass is item-lossless (single + chained corner segment) | ✅ PROVEN | R1a (40=40), R1b sparse (24=24), R1b dense (112=112), all 0 drops |
| ...also undergrounds, splitters, and across a live-tick gap | ✅ PROVEN | R1c (128=128, 0 drift), R1d (80=80 splitter), R1e (24=24, 10-tick gap) |
| Production belt export/serialize/import diverges from the proven algorithm | ❌ does NOT diverge | Explore audit: position captured atomically, JSON-preserved, sorted, two-pass |
| **The belt subsystem is the source of production item loss** | ❌ **EXONERATED** | entire R0+R1 ladder lossless + production matches → the −8 is NOT belts |

## ⚠️ LAB HAZARD (learned the hard way — cost a crash-loop + patch-and-reset)

**NEVER `script.on_event(defines.events.on_tick, fn)` from `/sc` on the live dev cluster.** `/sc` runs in the
**level** script context — the SAME context the surface_export module uses — so registering an on_tick handler
**CLOBBERS the production async-processor's handler** (only one handler per event). Symptoms cascade:
1. Async export/import jobs stop progressing (`phase=nil, done=nil`) → clone/transfer **timeouts**.
2. When my lab handler self-unregisters (`on_event(on_tick, nil)`), the production handler is gone too.
3. On instance restart the async processor resumes a half-stuck export job and calls `complete()` →
   `scan_items_on_ground(job.surface)` on a surface that was meanwhile DELETED → "LuaSurface API call when
   LuaSurface was invalid" → **non-recoverable on_tick error → the save CRASH-LOOPS on load** →
   only fixable via `patch-and-reset` (reset saves to seed).

**Safe lab patterns instead:** (a) do everything in a SINGLE `/sc` call (same-tick — no event registration);
(b) if multi-tick is required, run on a throwaway SEPARATE instance, not the shared cluster; (c) never leave
queued async jobs referencing surfaces you will delete. The R0/R1 traces that used on_tick were the cause —
re-do any future multi-tick lab work off the shared cluster.

## 🎯 PRODUCTION LOSS LOCATED (tripwire fired) — restore-time, short-dest-line overflow

The bucket ledger put the −8 on belts; a `insert_at`-returned-false TRIPWIRE in `belt_restoration.lua` caught
it exactly:
```
VOID DROP turbo-transport-belt line 2: rejected 4 x iron-plate at pos=1.125 (line_length=1.15234375, over_by=-2.734e-02)
VOID DROP turbo-transport-belt line 2: rejected 4 x iron-plate at pos=0.875 (line_length=1.0,         over_by=-1.250e-01)
```
- 2 hits × 4 = −8 (the whole loss). Located at the `insert_at` call (RESTORE-time, not active-gap).
- **JSON boundary-jitter REFUTED:** `over_by` NEGATIVE both times → positions are IN BOUNDS (0.027 / 0.125
  *below* `line_length`). Not an out-of-bounds float wobble. (No epsilon clamp — that fix is wrong.)
- **Mechanism:** `insert_at` rejects a FULL 4-stack near the end of a SHORT line — no physical room for 4
  items (~0.25 lengthwise needed) in the remaining ~0.13/0.03. Total rejection → 4 items silently dropped.
- **ROOT (confirmed from serialized data):** a BACKED-UP belt packs items TIGHTER and FULLER than `insert_at`
  can reproduce. Culprit belt `(3.5,18.5)` line 2, length 1.0: stacks at `0.0, 0.25, 0.5, 0.75, 0.875` — the
  5th is only **0.125** from the 4th (compression < insert_at's ~item-width min). Belts that did NOT drop had
  clean 0.25 spacing (e.g. `(3.5,19.5)`: 0.125/0.375/0.625/0.875, 4 stacks). The `pos=1.125` drops = same at
  the line END (`1.125 + item_width > 1.15`). insert_at places the first N stacks then REJECTS the
  over-compressed / past-end last stack → 4 items lost. **The belt physically holds MORE than insert_at can
  re-place.**
- **Why the lab missed it:** R1b "dense" was packed BY insert_at itself → can't exceed insert_at's own density.
  Real gameplay belts back up against bottlenecks and compress past that limit. NOT boundary-jitter (positions
  in-bounds), NOT active-gap (this fires at restore time) — a THIRD mechanism: insert_at can't reconstruct
  maximal belt compression.
- **REPRODUCED in lab** (single `/sc`, connected 3-belt segment + exact production positions): `expected=56
  actual=52 delta=−4`, reject `@1.125 len=1.0`. The captured position doesn't fit the dest line (source line
  longer — corner outside-lane ~1.15 vs straight 1.0). **`insert_at_back` FALLBACK FAILS to recover**
  (recovered=0, still_lost=1, delta still −4): the dest line, via ANY insert method, holds FEWER items than the
  source belt did.
- **FUNDAMENTAL LIMITATION:** `insert_at` cannot reconstruct a maximally-compressed/backed-up belt. Source
  packs items tighter (natural compression) and/or on a longer corner lane than `insert_at` can place; the last
  stack(s) overflow and are unrecoverable by insert_at / insert_at_back. Scales with how backed-up the factory
  is (−8 settled test platform, −143 busy CI). DEAD fixes: epsilon clamp (positions in-bounds), force_insert_at
  (squashes), insert_at_back (proven here it can't compress tighter), insert_at_back WHILE-loop (dup).
- **Open fix directions (all non-trivial — needs user/advisor):** (a) MULTI-TICK restore — place what fits,
  let the belt advance/compress, top up the remainder over ticks; (b) preserve exact dest belt GEOMETRY so
  line_length matches source (fixes the corner/straight-mismatch subset); (c) buffer overflow recoverably
  (chest/loader), not ground; (d) accept+report as an engine limit (violates literal-zero). The loss is now
  LOCATED, REPRODUCED, and CHARACTERIZED — fix is a design decision, not a mystery.

## OPTION R (upstream recursion) — TESTED: insufficient alone (bottoms out on the real loss case)

Reproduced 3-belt fixture (production positions, fully-packed), two-pass: insert_at all → collect overflow →
recurse `input_lines` placing at first upstream line with room. Result: `expected=56 actual=52 delta=−4
overflow_stacks=1 terminal_homeless=1` — recursion placed **ZERO** of the overflow.
- **WHY:** a genuinely over-compressed segment is fully-packed END-TO-END → NO upstream slack → recursion hits
  `#input_lines==0` immediately. Upstream recursion ONLY helps PARTIALLY-backed-up segments (slack at input).
  But the segments that actually OVERFLOW are the saturated ones (that's WHY they overflow) → recursion can't
  help the real loss case. Production's lossy belts WERE fully-packed.
- Organic-jam fixture attempt: a single burner-inserter CANNOT saturate a turbo belt (items flow free at ~4/
  tile, never compress) → couldn't easily build a partial-jam profile; conclusion stands from synthetic+prod data.
- **⇒ Recursion alone ≠ literal-zero.** A terminal fallback IS required, and the residual is COMMON (every
  saturated overflow), not rare → the fallback must be good, not hacky.

## 🎯 ENRICHED TRIPWIRE — both VOID DROPs classified: FIXABLE ARTIFACTS, not a real limit

Enriched tripwire (src/dst line_length + in/out links + can_insert + nearest) on a real transfer (settled, −8 =
2 drops):
```
Drop 1: Pos1.125 SrcLen1.152=DstLen1.152 SrcLinks2/1=DstLinks2/1 CanIns:false ItemsOnLine:20 Nearest:0.125
Drop 2: Pos0.875 SrcLen1.0  =DstLen1.0   SrcLinks2/0≠DstLinks1/0 CanIns:false ItemsOnLine:16 Nearest:0.125
```
- **Drop 2 = MISSING NEIGHBOR (confirmed).** Source belt had **2 input lines, dest has 1** — a feeder belt
  failed to CONNECT at the dest (created but mis-oriented / wrong order / not adjacent). The "two-pass" audit
  proved all entities are CREATED before restore, but NOT that they all CONNECT. Entity-creation/connection
  bug. Fixable. No handler.
- **Drop 1 = BOUNDARY HANDOFF.** Geometry AND links MATCH (1.152=1.152, 2/1=2/1). Item at pos 1.125 = the line's
  output EDGE (len 1.152), line has downstream (out_links=1). It's the FRONT item mid-handoff to the next belt;
  insert_at won't place a full item past the line edge, but source had it there (half on next belt). Fix =
  route boundary item to the DOWNSTREAM belt's input (where it flows). No handler.
- **⇒ NEITHER is "belt over-full beyond possible." Overflow design (queue/hub/multi-tick) DROPPED.** The two
  fixes are: (1) entity-creation/connection (missing input neighbor), (2) boundary-handoff routing.

## ROOT NAILED (after 3 hypotheses) — connected-belt insert_at edge-rejection; fix = SYNCHRONOUS routing

GEOMETRY DEFECT locator → belt @(8.5,35.5) dir=east, tripwire saw in_links 2→1. Inspection + retests:
- **Entity defect REFUTED:** src & dst junction geometry IDENTICAL (same entities/positions/directions).
- **Connection-timing REFUTED:** dst NOW == src NOW (in_links=2, line_length=1, items=16). Cleared the
  fully-connected dst belt + re-inserted source's 5 stacks 0.0/0.25/0.5/0.75/**0.875** → `0.875=FALSE` STILL
  rejected. So a settled, fully-connected belt rejects the edge item.
- **Standalone vs connected:** an ISOLATED belt accepts 0.875 (16→20); this MERGE-FED belt rejects it. The
  CONNECTION changes insert_at's boundary behavior. The source held 0.875 via natural FLOW; insert_at can't.
- **Slack EXISTS upstream:** belt's `input_lines` = in1(splitter line, items=12, canback=false) +
  **in2(splitter line, items=0, canback=TRUE)**. Earlier Option-R "bottoms out" was a fully-packed SYNTHETIC
  fixture artifact — the real segment has room (that's why the source held the item).
- **⇒ FIX = synchronous routing of the rejected edge item to a connected line WITH ROOM:** out_links>0 →
  downstream input (0.0, handoff); out_links=0 (dead-end) → UPSTREAM, try ALL input_lines + recurse; terminal
  fallback only if the whole connected component is full (rare). NO on_tick, NO gate tension, NO queue/hub.
  This unifies the user's recursion + Gemini's handoff, with the FIFO directional rules.

## ⚠️ ROUTING UNSOUND UNDER LOAD (v2) — duplication resurfaced (the recurring belt-dup class)

v2 (physical-delta per-line + budget + two-pass + downstream-then-upstream) PASSED adversarial V0/V1/V2/V3
(loop terminates, budget bounds, jam→routed 0, no dup IN A FULL LOOP). But the real **BUSY** transfer (255
overflow ≈ the −143 case) FAILED: `expected=8299 placed=8044 routed=95 terminal_failed=160`, gate shows GAINS
(+52 piercing-rounds, +16 carbonic, …). So under load the routing BOTH duplicates AND mis-counts terminal.
- **Root:** per-line `get_item_count` delta is UNRELIABLE on CONNECTED segment lines — `input_lines` can repeat
  the same physical line (`line_equals`), and the downstream-then-upstream double-attempt double-places. Items
  get placed AND counted terminal; others duplicate. Same dead-end as the old insert_at_back back-fill.
- **V1 only passed because the loop was FULLY jammed (no room → no placement → no dup); a PARTIALLY backed-up
  real segment has room, and that's where the double-place fires.**
- ⇒ Routing onto connected belt lines is duplication-prone; need a SOUND approach (whole-segment/platform
  measurement, or an off-belt sound sink) or accept+report. CONSULT before more thrashing.

## ✅ FIX SHIPPED + VERIFIED (settled) — unified synchronous routing → LITERAL ZERO [SUPERSEDED by the v2-under-load failure above]

`belt_restoration.lua` `route_overflow`: when `insert_at` refuses an output-edge item, route it to a connected
line WITH ROOM — downstream input (0.0) if `pos > line_length-0.25` & `out_links>0` (handoff), else UPSTREAM
recursion via `input_lines`/`can_insert_at_back` (dead-ends). `terminal_failed` (logged loud) only if the whole
connected component is full. Synchronous: NO on_tick, NO gate tension, NO queue/hub.
- **Verified transfer (settled):** `expected=8255, routed_edge_items=8, terminal_failed=0`; gate
  **ALL 25 item types delta=0 (exact conservation)**. The −8 is GONE. (segment_delta=−17 = the approximate
  internal scan, which doesn't enumerate routed-to lines; the gate's find_entities count is authoritative.)
- REMAINING: verify the BUSY/CI case (−143) via CI; codify belt-engine-fidelity test; /code-review; commit.

## FIX SPECTRUM (superseded — kept for history) — all achieve COUNT literal-zero; differ in fidelity + complexity

- **Recursion + overflow→HUB inventory (SYNCHRONOUS, simplest):** on terminal, put overflow in the space
  platform hub inventory (always exists, gate counts inventory). No on_tick, no gate tension, no foreign
  entity, no ground litter. Cost: overflow relocates to the hub, NOT back on the belt (count-conserved,
  position lost). Possibly violates "items on belts stay on belts" in spirit.
- **Option A multi-tick (queue + module on_tick injector + gate-counts-queue + TTL):** conserves count AND
  returns items to the belt as it DRAINS post-activation (belts backed up against WORKING bottlenecks drain).
  Cost: real complexity + the gate-accounting tension; TTL fallback for never-draining belts.
- **Accept + report:** loud-log the residual (0.04% settled / 0.75% busy), don't fix. Violates literal-zero.

## VERIFIED API FACTS (2.0.76)

- `get_detailed_contents()` → array of `DetailedItemOnLine = {stack::LuaItemStack, position::float, unique_id::uint32}`.
  Read identity via `item.stack.name` / `item.stack.count` / `item.stack.quality.name`.
- `insert_at(position, items, belt_stack_size?)` → bool; **bool returns true on PARTIAL placement** (it lies).
- `line[i]` → `LuaItemStack` (no position); `#line` → item count.
- `line_equals(other)` true ⇒ same internal merged line (undergrounds); false across a chained segment.
- Segment is read-spanning (`input_lines`/`output_lines`/`total_segment_length`) but **all writes are per-line**.
- `unique_id` identifies an item *while on transport lines*; it does NOT survive destroy/recreate.

---

## Experiments

<!-- Append one entry per experiment. Template:
### <ID> — <short title>  (<date>)
- **Hypothesis:**
- **Method:** script `tests/belt-lab/<file>` · cmd `<exact>`
- **Raw:** `tests/belt-lab/results/<id>.txt`
- **VERDICT:** <PASS/FAIL + key numbers>
- **Implication:**
-->

### R0 — merged-line / double-read probe (turbo underground pair)  (2026-06-26)
- **Hypothesis:** undergrounds expose ONE merged line via multiple windows → per-entity scan double-reads the
  same items (`line_equals` TRUE) → structural export double-count, motion-independent.
- **Method:** script `tests/belt-lab/rung0_setup.lua` (+ matrix + insert/read variants) · run via `tools/rcon.ps1 11`
  on nauvis: build input@(100,100)→output@(103,100) turbo undergrounds; map 4×4 `line_equals`; insert 1 item
  on each of e1's 4 lines; read all 8 windows; tally `unique_id`s.
- **Raw:** `tests/belt-lab/results/rung0-merged-line-probe.txt`
- **VERDICT:** ❌ HYPOTHESIS REFUTED. Underground = **4 lines/end**; `line_equals` FALSE for ALL e1↔e2 pairs
  (chained, not merged); inserted items appear only in their own window; **DUP_UIDS: NONE** → no double-read.
  Capture DOES expose buried items (on e1's len-3 lines L3/L4).
- **Implication:** the +40/+56 export GAIN was the `insert_at_back` back-fill (already removed), NOT export
  double-counting. `line_equals` de-dup is moot for undergrounds (never fires). The open question is now
  purely RESTORE fidelity → Rung 1. (Also: a content-overlap de-dup, if ever needed, must key on `unique_id`,
  not `line_equals`.)

### R1b — mid-motion corner-loop relocate (sparse + DENSE)  (2026-06-26)
- **Hypothesis (user threat model):** `insert_at(float)` snaps captured mid-motion floats to an internal grid →
  could collapse a gap below min item separation → collision → drop (fatal), or position drift.
- **Method:** `tests/belt-lab/rung1b_corner_loop.lua` (+dense variant) · `tools/rcon.ps1 11`. 2×2 turbo CORNER
  loop, spin 300 ticks, atomic capture → two-pass rebuild offset → rank-matched diff (count drop = collision; Δ
  = quantization). Sparse (single items, 0.3 gap) and DENSE (fed to gridlock).
- **Raw:** `tests/belt-lab/results/rung1b-corner-loop.txt`
- **VERDICT:** ✅ Sparse 24=24, 0 drops, maxΔ=0.125. **DENSE 112=112, 0 drops**, maxΔ=0.039. **NO item loss, NO
  collision even fully packed.** `insert_at` quantizes positions to a 1/8 grid (harmless sub-tile drift) but
  never drops an item — belt items are always ≥ min separation, so snapping preserves distinctness.
- **Implication:** the capture→sorted-`insert_at`+two-pass ALGORITHM is **item-lossless** for single belts AND
  4-belt chained corner segments. Production residual is NOT insert_at fidelity → suspect undergrounds
  (relocate untested), splitters, or the EXPORT side (multi-tick scan / JSON float / cross-instance). Next: R1c.

### R0d — underground dynamics: hand-off / exit-buffer / capacity  (2026-06-26)
- **Hypothesis:** since `line_equals` is false, items must physically transition e1→e2; is there a blind tick
  (capture miss) or duplication tick (double-count) at the boundary? Does the exit buffer hold items? Capacity?
- **Method:** `tests/belt-lab/rung0_handoff_trace.lua` (on_tick logger, 70 ticks) + fill probes · `tools/rcon.ps1 11`.
- **Raw:** `tests/belt-lab/results/rung0-handoff-trace.txt`
- **VERDICT:** ✅ Engine conserves PERFECTLY at the hand-off — **every tick total=3, dup=0** (no blind tick, no
  duplication tick); `unique_id` stable across e1→e2 (tunnel lane e1.L3 → exit hood e2.L1). Exit buffer
  e2.L3/L4 (len 1) **does hold items** (dense ~20 each) → capture must/does read all 8 lines. A 4-distance
  turbo pair holds ~176 items; entrance tunnel lines (48 each) hold the bulk.
- **Implication:** **CAPTURE for undergrounds is SOUND** — a same-tick `get_detailed_contents` over all lines
  is always exact. Bonus durable fact: **`insert_at_back` fills only ONE slot per tick** (items don't advance
  within a tick) → a belt cannot be filled via `insert_at_back` in one tick; **restore MUST use
  `insert_at(position)`** at captured positions. The remaining risk is RESTORE fidelity only → Rung 1.

---

## DECISIVE A/B (2026-06-27) — ROUTING IS THE DUPLICATION ENGINE. Architectural STOP.

Clean, post-recovery A/B (host-1 had crashed on an unrelated `game.write_file` export-to-file bug —
the broken `/export-platform-file` queued a pending write that fires on_tick; `game.write_file` does
not exist on 2.0 (it's `helpers.write_file`) → instance Failed → stopped → run B never ran, the earlier
"+93 both" reading was run A's STALE file). Recovered host-1, re-ran both halves fresh:

| Run  | `disable_belt_routing` | NET items | per-item                                   | gate     | belt summary            |
|------|------------------------|-----------|--------------------------------------------|----------|-------------------------|
| A'   | false (routing ON)     | **+108**  | piercing+60 carbonic+21 metallic+14 +4s    | FAILED   | routed=107 termfail=256 |
| B'   | true  (routing OFF)    | **−8**    | iron-plate −8 only                          | SUCCESS  | routed=0  termfail=507  |

`totalItemLoss` on A' = 0 → the +108 is PURE duplication, not mismeasured loss.

**Why routing duplicates (root, now proven):** the per-window `get_item_count()` delta is unreliable on
CONNECTED segments. Routing-OFF logged `terminal_failed=507` but only −8 actually went missing — those 507
were physically placed by the BASE insert; the per-line delta just couldn't see them (belts are windows onto
a shared merged internal line, so `before`/`after` on one window also captures a sibling window's change).
That same under-count inflates `overflow.count`, so with routing ON the post-pass re-places already-placed
items → +108 gain. You cannot reliably measure per-window placement on merged segments → routing has no sound
foundation. (Routing has now failed 4 distinct ways: back-fill→dup, recursion→bottoms-out, v1→light-only,
v2/v5→dup-under-load. This A/B is the definitive arbiter.)

**SHIPPABLE = routing OFF.** −8 (iron-plate only) is the documented irreducible belt floor (insert_at can't
reconstruct max-compression: the output-edge item on a connected belt). It is WELL within the strict gate
(tol = max(20, 1.5%·1584 ≈ 24) → 24; |−8| < 24 → SUCCESS) — no duplication, no crash, no silent loss.

**DECISION FOR USER:** literal-zero is NOT achievable via insert_at routing (proven). Ship routing-OFF
(clean −8, gate SUCCESS) and accept the documented sub-0.1% belt floor, OR keep chasing literal-zero down a
different axis (would NOT be routing). Recommend: ship routing-OFF, codify the loss-injection guard, close.

---

## CI BUSY-CASE RESULT (2026-06-27, commit 38d5e66, routing REMOVED) — losses, not gains

Settled (local): −8 iron-plate, gate SUCCESS. Busy (CI PR #30, run 28282680823): gate FAILED, but with
LOSSES not gains — confirming the duplication is GONE:

    copper-cable:  expected 1068, got 1046  (lost 22 > tol 20)
    copper-plate:  expected  494, got  461  (lost 33 > tol 20)
    iron-plate:    expected 1578, got 1545  (lost 33 > tol 23)
    railgun-ammo:  expected  286, got  239  (lost 47 > tol 20)
    (~135 total; per-item 22–47 each exceed the strict per-item tol max(20,1.5%·exp))

So: routing removal achieved its goal (no more +108 dup). Residual = real belt-floor loss that SCALES with
belt density (−8 settled → ~−135 busy). On busy platforms it exceeds the strict gate → CI red, source PRESERVED
(no silent delete — gate working as designed).

OPEN QUESTION before the user decision (real loss vs inflated baseline): is "expected N" a true physical
source count, or is it the SERIALIZED export total which may DOUBLE-COUNT merged-window belt items (the same
merged-line problem that broke the per-line counter, but on the EXPORT side → Pitfall #16 territory)? If
expected is inflated, part of "−135" is phantom and literal-zero is reachable via an EXPORT-side fix (don't
over-capture), NOT routing. Must reconcile source-physical vs dest-physical directly to tell.

---

## GEOMETRY-vs-COMPRESSION DIAGNOSIS (2026-06-27, gated belt_diag on a real settled transfer)

Classified every insert_at drop at restore time (pos vs dest line_length; nearest existing item):

    unplaced=283  ->  geometry=0   compression=16   other=267   nopos=0

1. **geometry=0** — NOT a single off-end drop (pos > dest_len never happened). Dest belts rebuild geometry
   FAITHFULLY (log shows dest_len=1.1523 curve outside-lanes present). => GEOMETRY PRESERVATION IS NOT THE FIX.
   (Corrects the earlier read of the pos=1.125 drop: it's on a dest_len=1.1523 CURVE => in-bounds compression,
   not off-end geometry.)
2. **Real loss = COMPRESSION.** Every genuine drop is iron-plate at pos=0.875 nearest=0.125 (straight) or
   pos=1.125 dest_len=1.1523 nearest=0.125 (curve) — the 5th stack packed tighter than insert_at's 0.25 min.
   This is exactly multi-tick's target => MULTI-TICK IS THE RIGHT AXIS.
3. **The 267 "other" are MEASUREMENT PHANTOMS, proven.** They are items at pos~0.0 nearest=999 (EMPTY line)
   that "failed" — impossible for a real insert. Proof: the gate flagged ONLY iron-plate −8, yet "other" spans
   piercing-rounds/metallic/carbonic/copper-cable/iron-ore — none of which the gate reports lost. Those 267
   ARE placed (on connected sibling windows); per-window get_item_count can't see it. Same merged-window
   unreliability that drove the +108 duplication.

**Design lock for any multi-tick attempt:** drive the topup off the WHOLE-SEGMENT DEDUPED DEFICIT
(expected − actual, the gate's instrument), NEVER per-line "did it place?" deltas (267 false positives here →
re-placing → duplication). Feed the segment input, let flow compress, re-check the deduped deficit each tick,
stop at 0 or TTL.

---

## BREAKTHROUGH (2026-06-27): belt slots accept OVERSIZED stacks → single-tick fix for over-compression

User asked "how high can items stack on a belt? did we hard code 4?" — we do NOT hardcode 4 (we pass the
captured stack.count as belt_stack_size). Empirical probe on 2.0.76:
- `force.belt_stack_size_bonus = 3` → the GAME-BALANCE max is 4 (1 + bonus). BUT:
- `insert_at(pos, {iron-plate, count=N}, N)` ACCEPTS arbitrary N — tested 1,2,4,8,16,20 — each lands as a
  SINGLE slot with that full count (`slots=[16]`, `[20]`). The 4-cap is NOT an engine storage limit.
- **Persistence (the safety question): a 20-item single slot SURVIVES belt flow** — chain_total=20, ground=0,
  flowed across a 3-belt chain to jam at the wall as `belt3 L1[20@0.00]`, STABLE over multiple real-time
  reads. No clamp-to-4, no shed-to-ground. (Contrast: force_insert_at SQUASHES/loses — this does NOT.)

**IMPLICATION — over-compression is fixable SINGLE-TICK (no async/multi-tick/gate-tension):** the loss is the
5th 4-stack rejected at 0.125 spacing. Instead, CONSOLIDATE each line's items per (name,quality) into one tall
stack via insert_at with belt_stack_size = group total → all items fit → ZERO loss. Belt count is preserved;
appearance self-heals as the factory pulls items (re-stacking to the normal 4-max). Positions are cosmetic
(CLAUDE.md accepts belt drift). This BEATS multi-tick (simpler, synchronous, no gate restructuring).

**STILL TO VALIDATE before shipping:** (a) over-stack survives SAVE/LOAD (transfer crosses a save); (b) the
gate counts it correctly (get_detailed_contents sums stack.count — should be fine); (c) no bad interaction
when inserters/machines pull from an over-stack; (d) real-transfer end-to-end = literal zero on the gate.

## SAVE/LOAD GATE: PASSED — oversized stack survives reload

Walled 20-stack on an isolated lab surface → real `instance stop` (saves) + `instance start` (reloads from
that save, NOT patch-and-reset) → re-acquired by surface name + position:
    AFTER LOAD: line_total=20 ground=0 slots=[20@0.00]
Fully intact. The engine does NOT clamp the illegal over-stack to 4 on save/load (the one fatal mode: green
pre-save gate → silent post-save loss). => oversized-stack restore is save/load-safe. Cleared to implement.

DESIGN (deterministic targeted consolidation, no measurement → no duplication trap): per line, decide from the
CAPTURED positions + dest line_length whether it places slot-by-slot at >=0.25 spacing. Legal lines: unchanged
(exact layout). Over-compressed lines only: group items by (name,quality), place each group as ONE oversized
stack at its min captured position (always fits; count exact). Validate end-to-end on a real transfer: gate
clean (no GAINS = no double-place) AND post-activation loss-analysis conserved (interaction/drain safe).

## 2026-07-11 - BELT-R1 exact-gate anomaly: OPEN-INSTRUMENTED

Prediction: replacing per-insert `get_item_count()` deltas with a complete post-restoration census keyed by
physical entity `unit_number` plus transport-line index would reconcile exactly with the frozen gate, and a
bounded randomized run would reproduce the intermittent four-item belt loss for replay and minimization.

### Trigger and instrument correction

Main post-merge run `29175561208` reproduced the known fail-safe signature while running the unrelated plasma
fixture: `piercing-rounds-magazine expected=7886 actual=7882 delta=-4`. Fluid parity passed, the destination was
discarded, and the source was unlocked. The pre-BELT-R1 meter had previously reported `unplaced_diag=347` for
a real four-item deficit, so it was not admissible attribution.

BELT-R1 now censuses every serialized belt entity and line after all inserts complete, using the same physical
`get_detailed_contents()` stack counts the exact gate trusts. A healthy 1,359-entity production transfer
measured `expected=8134 actual=8134 delta=0`; the exact gate also passed. The instrument therefore reconciles
on its control. Insert return values and per-insert window deltas no longer contribute to the diagnostic total.

### Permanent trap

Every failed transfer black box now carries:

- restore-time and frozen-gate per-line expected/actual/delta rows;
- entity unit number, entity id/name/type, position, direction, line index/length, neighbours, and compression;
- serialized and physical positioned stacks for each line;
- the complete imported `replay_payload` needed to repeat the exact input.

This remains always-on under Black-Box Discard and does not alter the exact gate or failure disposition.

### Bounded fishing verdict

Forty fresh production-shaped transfers ran with randomized live-belt intervals. Result: `40/40` exact-gate
green; no second loss class and no capture under the new trap. Per the rung contract, the anomaly is
**OPEN-INSTRUMENTED**, not fixed and not explained. Replay, topology minimization, and a restoration change are
not licensed until a natural recurrence supplies the new black box. LAB-TAIL certification remains held
pending owner sign-off on this OPEN-INSTRUMENTED disposition.