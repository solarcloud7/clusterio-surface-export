# Factorio 2.0 (Space Age) API & Simulation Notes

**Charter — what belongs here, and what does NOT.** This file records **only simulation behavior we had to
measure ourselves because Wube does not document it.** It is deliberately *not* a second copy of the Factorio
API reference.

- **If [lua-api.factorio.com](https://lua-api.factorio.com/latest/) documents it, it does not belong here** —
  link the official docs instead. We do not maintain prose that Wube already maintains, and a stale local copy
  of a documented signature is worse than no copy.
- **If it is no longer true of the pinned engine, delete it** — do not keep it as history. A retired law lives
  in git history and, where a lesson is load-bearing, as a *pitfall*. Superseded prose in a reference doc gets
  read as current.
- **What earns a place:** behavior discovered by measurement — segment semantics, belt transport-line laws,
  counting completeness, ordering/freeze effects — i.e. the things that cost us a bug to learn.

**The one test for inclusion: does this help us transfer a platform between instances with ZERO loss and
ZERO gain?** If it does not serve that goal, it does not belong here — however interesting it is. Feature
behavior, dashboards, CI forensics, and passenger mechanics all live elsewhere.

Every entry must carry a citation that **resolves to something checkable**: an integration test or pad
(`tests/integration/<name>`, `pad <fixture-id>`), or a lab NOTEBOOK rung at tag `labs-archive-2026-07-19`
*qualified by lab* (`fluid-lab R12` — bare `R12` is ambiguous across labs). **There is no [hypothesis] tier.**
A claim whose only evidence is an undocumented one-off probe gets **deleted**, not demoted: an unprovable
claim in a reference doc is a liability, and the git history keeps it if anyone ever needs it.

The only tag is **[empirical, `<pin>`, `<citation>`]**, and it covers **exactly one claim**. A bullet that
states a measurement and then draws a "so/therefore" consequence is two claims wearing one citation — that is
how a false `set_stack` cap rationale rode a real `crafting_speed` measurement (retracted 2026-07-31).

Two owner deletion rules (2026-07-31), both absolute:
- **If <https://lua-api.factorio.com/> documents it, this file does not.** The abolished **[API]** tier existed
  to mirror upstream, and mirroring is how a doc rots: the upstream page moves, our copy doesn't. Link the
  upstream page where the code needs it. An `[empirical]` claim that merely restates upstream is presumed
  copied from the docs and dressed as an experiment — delete it.
- **Documentation citing documentation is a feedback loop.** Evidence is a measurement or an upstream source,
  never another of our docs. "See our other doc" is not support; such a claim is deleted, not re-pointed.

What survives here is only what the docs do NOT tell you and a measurement had to: timing, ordering, what
survives a save/load, how the engine answers a write. When upstream and our pinned engine disagree, the
pinned-engine measurement wins — and that disagreement is exactly the kind of claim worth keeping.

## Contents

- [Fluid model at 2.1.11](#fluid-model-at-2111)
- [Item counting (get_item_count includes belts)](#item-counting)
- [Belt transport-line laws (CANONICAL)](#belt-transport-line-laws-canonical--2026-07-17-recreation)
- [Space platform deletion](#space-platform-deletion)
- [Hub item requests: proxies vs manual logistic sections](#hub-item-requests-proxies-vs-manual-logistic-sections)
- [Deactivated-entity state writes and control-behavior / equipment restore](#deactivated-entity-state-writes-and-control-behavior--equipment-restore)

## Fluid model at 2.1.11

> The dev cluster and the plugin's fluid layer run **Factorio 2.1.11** (all instances since 2026-07-21).
> The laws below were measured by live fluid-law experiments on 2.1.11; the running instrument is
> `tests/instruments/fluid-segment-law/run-tests.mjs`, which re-measures them on demand.

- **Segment getters THROW on a segmentless fluid box** (2.0 returned `nil`) — always guard with
  `has_fluid_segment(i)` before any `get_fluid_segment_*` call.
  **[empirical, 2.1.11, tests/instruments/fluid-segment-law]** (rung: segment getters throw on segmentless)
- **The buffer/window duality is GONE.** **[empirical, 2.1.11, tests/instruments/fluid-segment-law]**
  `get_fluid_segment_fluid(i)` returns the EXACT single-fluid segment total from ANY member box at ANY
  instant — a thruster fuel box read 500 exact, and a fusion-reactor coolant box read 300→450 exact both
  mid-transient and settled. There is no order-dependent claim, no mixed-regime "contents + Σ locals" law, and
  no `production_type` classifier needed. `get_fluid(i)` instead returns the box's own **capacity share** of
  the segment (float32: 12 pipes on one 1000-unit segment summed to `999.9999997615814`; a thruster:pipe share
  ratio was 10:1 by capacity), which the registry keeps for census attribution and split-segment
  proportioning.
- **Plasma writes STICK, clamped to box capacity.** **[empirical, 2.1.11, tests/instruments/fluid-segment-law]**
  `set_fluid` of 50 plasma onto a fusion-reactor OUTPUT box read back 10 (capacity clamp); 25 onto a
  fusion-generator INPUT box read back 10. **Fusion-generator boxes are segmentless.** Plasma rides transfers
  like any fluid — the `engine_owned` connection-category classification is deleted (owner ruling
  2026-07-20/21); the only lawful fluid subtraction from expected counts is a physically-measured
  `write_rejected`, never a category prediction.

### Prototype fluid-box coverage sweep

**[empirical, 2.1.11, tests/instruments/fluid-segment-law]** One live instance per prototype slot; each box was measured for
`production_type`, segment presence (`has_fluid_segment`), and the segment-total law. The sweep drives the
permanent coverage matrix — a new prototype fluid-box slot without a row is a finding.

| Prototype | Box(es) | production_type | Segment present |
| --- | --- | --- | --- |
| boiler | box1 input / box2 output | input / output | box1 YES / box2 NO |
| steam-engine | input | input | YES |
| pump (standalone) | 1 | none | NO |
| pipe-to-ground | 1 | none | YES |
| chemical-plant | 4 (in, in, out, out) | input/input/output/output | all NO |
| flamethrower-turret | internal | none | YES |
| big-mining-drill (off-patch) | 0 (dynamic count) | — | — |
| offshore-pump | output | output | NO |
| valve | 1 | none | YES |
| maraxsis fluid-burner | input | input | YES |

Notes: the big-mining-drill's fluidbox count is **dynamic** — 0 when off a resource patch. FluidEnergySource
("burner fluid") boxes ARE runtime-enumerable and index-reachable (the maraxsis fluid-burner input box carries
a segment) — they are not a capture blind spot at 2.1.11.

## Item counting

- **`LuaEntity.get_item_count(item)` is a per-entity total that INCLUDES that entity's belt-line and
  inserter-held items, and summing it over every entity does NOT double-count shared belt runs** —
  each belt exposes its own per-tile transport lines, so adjacent belts on one run report independent
  counts. Grounded against an independent physical truth: the count of unique
  `get_detailed_contents().unique_id` stacks (which a whole-line counting change cannot inflate), plus
  inserter `held_stack` inclusion.
  **[empirical, 2.1.11, tests/instruments/engine-invariants — re-run 2026-08-03: Σ get_item_count over
  77 belts == 1178 == the unique-physical-stack total; held hands included across 102 holding inserters]**
- **So a physical total computed as `get_item_count` over every entity is complete** — inventories **+** belt
  lines **+** inserter-held. NOTE: the production paired-reads source census does NOT use
  `get_item_count` as its physical oracle — it reads through `InventoryScanner.extract_all_inventories`
  (the same primitive the serializer uses); this completeness fact is what a `get_item_count`-based meter
  would rely on, retained here as engine truth.
- **Do NOT add a separate `get_transport_line` pass on top of a `get_item_count` total — that double-counts the
  belts** (`get_item_count` already includes them).
- **`line_equals` is neither identity nor content equality — but it IS the same-execution side partition
  on a populated source.** It has been observed returning `true` for two belts whose lines hold
  different counts (2026-07-17 measurement), so never ground belt TOTALS on `line_equals` dedup (use
  `get_item_count` or unique `get_detailed_contents().unique_id` stacks). Grouping a POPULATED surface's
  transport lines by `line_equals` within ONE Lua execution, however, partitions them into physical lane
  sides (left/right lanes never merge) — the partition the production belt restore stands on
  (`belt_restoration.lua` groups source lines by it, then places items at captured positions). The grouping
  is state-dependent (an empty, topologically identical target groups differently) and is only valid
  same-execution, same-surface, populated; it is NOT a cross-import key.
  **[empirical, 2.1.11, every green belt-carrying pad/workhorse transfer — a wrong side partition places
  items onto the other lane and fails the per-side census, so the standing suites re-assert it]**
## Belt transport-line laws (CANONICAL — 2026-07-17 recreation)

> This section is the single source of truth for belt insertion/restoration physics. Other docs must POINT
> here, not restate. Every law carries its rung; the full ledgers are in the belt-lab NOTEBOOK
> (archived at git tag `labs-archive-2026-07-19`), including the same-day RETRACTIONS entry
> (a briefly-held "frozen platform" claim and an "insert_at duplication" claim were instrument artifacts —
> the RCON-global lab hazard — and never reached law).

- **[empirical, 2.1.11, BELT-R16 — live workhorse transfer 2026-07-27] BOUNDARY HANDOFF: an `insert_at`
  near the TOP of a line (within one write-frame of `line_length`) seats the item ACROSS the piece
  boundary on the downstream entity's line** — measured landings: turbo-underground-belt INTERNAL lines
  (3/4) at k=31 ≈ one write-frame, for placements requested at feeding-line tops (k 255/294). Item count
  conserves per handoff, but position and line do not. When the landing line is in the SAME side, a
  side-census validation passes (wrong-position only: 248 born = 248 vanished pairs per key in the
  placement-ledger reconciliation); when it crosses SIDES, the census reads "nothing landed". Consequence: never write at line tops near piece boundaries — the production restore is
  placement at captured source positions (below) precisely to avoid this class.
- **[empirical, 2.1.11, black box on the passenger-evacuate refusal 2026-07-27] IN-TRANSIT BOUNDARY
  ITEM: a line captured MID-MOTION can carry ONE MORE item than its rest capacity.** Measured from the banked black
  box: a 1-tile turbo line (rest capacity 4) captured with FIVE items, the front one at position
  0.9375 only 14/256 behind its neighbour (overlapping by rest-spacing rules). That fifth item
  cannot be placed at any free position on its captured line. **Production behavior (owner ruling
  2026-07-27 — a platform must transfer WHENEVER, mid-motion included): the OVER-COMPRESSION MERGE**
  — the slot merges into an already-placed stack of the SAME (name, quality) on its OWN captured
  line, as ONE oversized stack (the established oversized-stack law: insert_at accepts an arbitrary
  belt_stack_size and the engine keeps it), validated by the side census with a partner-restore
  recovery on failure. Same line, no cross-side placement. **The merge REQUIRES a same-key partner
  on the line**: a mid-hop slot that is the only item of its (name, quality) on its line — e.g. a
  mixed-content lane — has no merge target and stays honest unplaced loss (exact gate refuses,
  fail => revert, retry captures a different instant). That partner-less corner is the one known
  remaining refusal on live sources. Frozen sources (paused platforms, frozen-feed fixtures) never
  produce the class at all. Kill-measured: 6/6 consecutive live-clone transfers with the merge
  witness firing.
- **`LuaEntity.active` is READ-ONLY at 2.1.11 — assignment throws `LuaEntity::active is read only.`**
  **[empirical, 2.1.11, direct probe 2026-07-31: assembling-machine-3 and loader on a scratch surface]**
  It was `RW` at 2.0.77. Write `disabled_by_script = true` instead (measured: `active` then reads false).
  This retires the BELT-R13 rider "loaders' flag IS writable — freeze feeders by deactivating loaders":
  the loader throws exactly like every other entity, so any instrument built on that recipe is broken at
  this pin. No production write sites exist (`.active =` appears only on `LuaLogisticSection`, still RW).
- **Import-side single-tick belt restore is the current conservative implementation, not a proven
  requirement.** Movement within a lane side between restore batches is contract-harmless (multiset unit);
  the untested risk is items crossing SIDE boundaries (through splitters/sideloads) mid-restore before the
  gate. Incremental (multi-tick) belt restore is a design candidate gated on that rung — do not assert
  either "must be single-tick" or "safe to batch" beyond this.
- **Standard fill instrument**: infinity chest (filtered, at-least N) + filtered loader saturates a belt
  circuit to a deterministic steady state; loaders stay active on paused platforms (deactivate them to
  freeze the feed). See the Physical Truth Lab Standard's fixture-contract section.
- **A paused platform's transport lines keep advancing.** **[empirical, 2.1.11, freeze-probe
  2026-08-09 — four-arm live probe on an omnibus clone (control arm proved the instrument sees
  motion first); committed instrument owed with the incremental-restore work]** With
  `platform.paused = true`, item positions kept moving over 120-tick windows; belt `status` stayed
  `working`, `frozen` stayed false. Consistent with the property's own doc ("paused thrust and does
  not advance its schedule" — thrust and schedule only).
- **`disabled_by_script = true` on a transport-belt is a SILENT NO-OP.** **[empirical, 2.1.11,
  freeze-probe 2026-08-09 (same probe)]** Written on 118 belt entities: readback `false`, lines kept
  moving, `status` stayed `working`. Separately observed in the same probe: a belt reading
  `active == false` still moved items — belt line simulation is independent of entity active state.
  Consequence: the import's frozen window (`disabled_by_script` on every entity) has NEVER frozen
  belts; single-tick belt restore is what stands between placement and drift.
- **The one measured belt freeze is circuit enable/disable — and it needs a REAL wire.**
  **[empirical, 2.1.11, freeze-probe 2026-08-09 (same probe)]** `circuit_enable_disable = true` plus
  a false condition with NO wire connection is ignored (`status` stays `working`); with a red wire
  connected (belt↔belt suffices) the condition evaluates on the NEXT tick, `status` becomes
  `disabled_by_control_behavior`, and the wired belts' lines measured 0 moved. Hazard observed in
  the same probe: freezing belts while feeders stay live compacts a circulating loop to zero gaps —
  a gap-free loop is permanently deadlocked even after re-enable (vanilla mechanic; absent during
  import, where nothing feeds and items restore with captured gaps).

## Space platform deletion

- **This project uses
  [`game.delete_surface(platform.surface)`](https://lua-api.factorio.com/latest/classes/LuaGameScript.html#method_delete_surface)**
  for immediate, deterministic teardown of a platform and all its entities. Route all platform
  removal through `GameUtils.delete_platform` (`module/utils/game-utils.lua`); a lint guard
  (`npm run lint:lua`) blocks direct `*platform*.destroy()` calls.

## Hub item requests: proxies vs manual logistic sections

These are why the export carries the hub's pending item requests as **manual logistic sections**
(`entity_data.logistic_sections`) and why no proxy record for the hub can ever exist to carry.

- **A hub-targeted `item-request-proxy` is destroyed by the engine within a few ticks of creation,
  and its request is annihilated — no items delivered, nothing merged into the hub's manual
  sections; paused platform or unpaused, frozen (`disabled_by_script`) hub or live.**
  **[empirical, 2.1.11, tests/instruments/engine-invariants `hub-proxy-annihilation`]** The proxy
  creates `valid == true` and is gone by the next execution with the hub's iron count and
  manual-section filter count unchanged. Consequence for serialization: there is no persistent
  hub-targeted proxy state — an export that runs even one tick after such a proxy is created is
  faithfully serializing a world that no longer contains it.
- **An otherwise-identical proxy targeting a container or crafter persists indefinitely.**
  **[empirical, 2.1.11, tests/instruments/engine-invariants `hub-proxy-annihilation` (the in-probe
  control)]** The annihilation is hub-specific, not a general property of script-created proxies.
- **Manual (`is_manual == true`) sections on the hub's requester logistic point — the hub GUI
  "Requests" tab — are fully writable while the hub is `disabled_by_script` on a paused platform,
  including grouped sections, `multiplier`, `active = false`, slot gaps, `min`/`max`, and
  `import_from`.** **[empirical, 2.1.11, tests/integration/hub-request-sections — the destination
  restore runs inside the frozen import window and every field arrives intact]** `import_from`
  reads back as a `LuaSpaceLocationPrototype`; its `name` is the portable form.
- **`LuaLogisticPoint.add_section(<group>)` with a group name that already exists on the force
  ADOPTS the group's existing filters — the new section arrives pre-populated.**
  **[empirical, 2.1.11, tests/integration/hub-request-sections adoption cases]** Writing slots into
  such a section mutates the group force-wide, which is why the import writes filters only into a
  group it just CREATED — pre-existence checked against `LuaForce.get_logistic_groups()` before the
  `add_section`, never against `filters_count`, because a pre-existing group can be legitimately
  EMPTY (a placeholder other platforms reference). The destination's groups win over the payload's,
  populated or empty.
- **A logistic group persists in the force's registry after the last entity referencing it is
  gone.** **[empirical, 2.1.11, tests/integration/hub-request-sections pre-state + cleanup
  asserts]** Test-created groups are therefore leftovers to sweep
  (`LuaForce.delete_logistic_group`), the same zero-leftover class as `storage.*` records — and an
  import that ran `add_section` before its destination was gate-refused must sweep the groups it
  created at the discard (the refusal leg of the same test asserts this).
- **`LuaForce.delete_logistic_group(name)` succeeds while live sections still reference the group;
  the sections' group link clears (reads back `""`).** **[empirical, 2.1.11, direct probe
  2026-08-04 on a requester chest; exercised by the discard sweep in
  tests/integration/hub-request-sections refusal leg]** The discard-path sweep therefore does not
  depend on end-of-tick surface-teardown ordering.

The non-manual section observed on the hub requester point (`type == 3`, `is_manual == false`)
tracked the surface's pending construction requests in probes (its `min` fell when a pending proxy
was destroyed) and is engine-owned; the export serializes only manual sections, so it regenerates
from the destination surface instead of double-counting.

## Deactivated-entity state writes and control-behavior / equipment restore

These drive the import restore path (all measured by the state-dimensions closer run; see the
state-dimensions-lab NOTEBOOK, archived at git tag `labs-archive-2026-07-19`, and the matching integration tests).

- **A drill's `mining_progress` is defined RELATIVE TO `mining_target`, which is read-only and nil
  until the drill's first update — so restore must be deferred until the target binds.**
  **[empirical, 2.1.11, gallery acid-drill pad + marker transfers 2026-07-29]** The clause is in
  `LuaControl.mining_progress`: "For mining drills the number is with the range
  [0, mining_target.prototype.mineable_properties.mining_time]." A write before the target exists
  reads back but is unanchored and is replaced at cycle start (three same-execution restore points
  all landed-then-lost this way); a write to a drill whose target is bound sticks permanently.
  `update_connections()` does NOT bind the target. Production defers the write via a pending queue
  serviced on_tick (`active_state_restoration.lua`).
- **A BLOCKED mining drill holds its finished product in an engine-internal slot with NO API
  accessor, so the held product cannot ride a transfer — the destination re-mines it, spending
  exactly one cycle's fluid and one patch unit.**
  **[empirical, 2.1.11, gallery acid-drill pad 2026-07-29]** The slot is in no inventory (a big
  mining drill exposes only its module inventory). Proof it exists and is the payer: clearing the
  destination drill's occupied drop tile made an ore appear instantly with the acid pool AND the
  patch total both unchanged — it came from the held slot, not a new cycle. The measured transfer
  delta is exactly one refill cycle per blocked drill: −10 sulfuric acid and −1 patch ore for
  uranium, after which the drill blocks identically to the source. No duplication (the source's held
  product is destroyed with the source platform), and the exact gate is blind to it SYMMETRICALLY —
  held drill output is census-invisible on both sides, the same non-conserved class as inserter
  hands. Pads shipping a blocked fluid-drill allow one refill cycle in their acid AND patch pins and
  no more (`mining-drill-acid-feed`); topping either back up would manufacture resources the source
  never sent. A blocked drill's terminal `mining_progress` is engine-settled (the refill cycle wraps
  past the restored value), so progress on a blocked drill is not a fidelity axis.
- **Most entity types are natively `active == false`, so "active" is not a fidelity axis for them.**
  **[empirical, 2.1.11, gallery source-vs-destination control 2026-07-28]** On the untouched gallery
  source, 486 of 542 entities read `active == false`: pipes, pipe-to-grounds, belts, splitters,
  containers, storage tanks, electric poles, solar panels, accumulators, lamps, display panels,
  combinators, resources, ground items — and the space-platform-hub itself. These are passive
  entities with no per-tick update. Never diff raw `active` counts between source and destination and
  read the difference as damage; diff them PER TYPE against the source control, or the ~490 natively
  inactive entities swamp the handful that matter.
- **Disable sets DRIFT: any restore pass that filters by a type list will strand the difference
  between that list and what upstream passes actually disabled.** **[empirical, 2.1.11, gallery
  whole-platform transfer 2026-07-28 — product defect, FIXED same day]** Measured before the fix:
  `entity_creation.lua` disabled everything except beacon/radar/item-request-proxy while the restore
  woke only `ACTIVATABLE_ENTITY_TYPES`, so infinity-pipe x2 and spider-vehicle x2 arrived permanently
  disabled (a spidertron riding a transferred platform arrived dead); the first attempted fix swapped
  one filter for another and stranded a beacon instead. The durable form: the restore pass has NO
  type filter (it restores captured state, so it must cover anything any pass disabled), and the
  `active-state-parity` fixture pins the corner classes with totals on both boards. The gate cannot
  see this class — it counts items and fluids, not activity.
- **`disabled_by_script` does NOT stop a combinator evaluating.** **[empirical, 2.1.11,
  circuit-latch-rearm R2 (behavioral rewrite 2026-07-30)]** Measured as a TRANSITION, not a property
  readback: a decider with condition `A > 0` and empty output was set `disabled_by_script = true`,
  its input raised 0→5, and the output FIRED (`signal-S=1`). Combinators cannot be script-disabled.
  (The first version of this rung wrote
  the property and read it back — confounded, since combinators are natively `active == false`, so a
  readback cannot distinguish "ignored" from "already off". Retracted 2026-07-28; re-established
  behaviorally with a pre-write baseline.)
- **Combinators EVALUATE on a PAUSED platform.** **[empirical, 2.1.11, circuit-latch-rearm
  pause-rung P0–P3, 2026-08-11]** With `platform.paused = true` on a powered platform: the input
  wire network propagated a fresh value (P1), the decider's own register (`signals_last_tick`, output
  connector deliberately unwired to exclude the network-sum confound) fired on that input (P1),
  CLEARED when the input dropped (P2a — ongoing evaluation, not a held value), and re-fired from an
  empty register when the condition was rewritten always-true and cleared again on restore (P2 — the
  exact production force→restore mechanism), bracketed by unpaused control arms (P0, P3). The prior
  claim that platform pause stops combinator evaluation was an inference never measured; it is
  retracted, consistent with the paused-platform freeze-probe above (pause suspends thrust and
  schedule only). Consequence: the latch re-arm pass runs regardless of pause — the former 30 s
  patience wait guarded nothing, and gateway-parked transfers get the re-arm.
- **A cleared latch CAN be re-armed by temporarily rewriting the decider's CONDITION.**
  **[empirical, 2.1.11, circuit-latch-rearm R3]** Control behaviour IS writable: forcing the condition
  true, letting it evaluate, then restoring the captured condition leaves the latch holding itself
  (measured `(empty)` → `signal-S=1` → `signal-S=1` after restore). IMPLEMENTED in production as the
  post-activation latch re-arm pass (`module/import_phases/latch_rearm.lua`; export captures the live
  register via `signals_last_tick`, decider-only) — first live kill-measurement 2026-07-30: the
  `omnibus-decider-latch` pad's anti-rot exemption tripped "KNOWN GAP NOW PASS" on a real transfer,
  `rearmed=1` with zero mismatches. Scope and caveats (owner-adjudicated 2026-07-30): the pass touches
  ONLY true latches — deciders whose captured connections show a direct output→own-input loop;
  ordinary deciders re-derive from live inputs and are never forced (an INDIRECT loop through a pole
  is not detected and keeps the pre-fix arrives-at-0 behavior, logged at schedule time). (a) It runs
  post-activation as a deferred multi-tick stage machine, preflighting that the captured parameters
  WRITE before any force (never force what you cannot restore); circuit signals are not part of the
  exact gate, so nothing can touch the verdict. It runs regardless of platform pause (pause-rung
  above); gateway-parked transfers get the re-arm. (b) An output with
  `copy_count_from_input=false` emits its constant (usually 1), so a source register holding another
  count is not reproducible — the pass VERIFIES `signals_last_tick` against the captured register
  (quality-keyed). A mismatch alone no longer licenses the clear: wiring cannot distinguish a latch
  from a self-fed COUNTER (measured live 2026-08-06 — a counter's moving register can never match
  its capture snapshot, and the old pass wrote clearing parameters onto healthy state), so the pass
  samples the register five times at pairwise-coprime gaps (13/17/19/23 ticks, ~72-tick window;
  uniform spacing would alias any register whose period divides the gap —
  `utils/signal-stability.lua`) and clears ONLY a register that held still across every sample — a
  moving register is classified "not a latch" and receives NO clearing write (`moving` bucket in
  `storage.latch_rearm_results`; like every scheduled decider it was still briefly forced and
  restored before classification). Residual: a register whose period exceeds the sampling window can
  hold still across all five samples and read stable. The force write is a
  shallow copy of the captured parameters with only `conditions` overridden — `cb.parameters` emits
  `else_outputs` at this pin **[empirical, 2.1.11, else-outputs-rung E1]** and the old table rebuild
  wiped it **[E2]**; the clearing write deliberately KEEPS else_outputs stripped, because under its
  always-false condition a preserved else_outputs would fire for the whole clear window.
- **Decider and arithmetic combinators DRAW POWER (16.67 J/tick); constant combinators do not.**
  **[empirical, 2.1.11, circuit-latch-rearm build guard]** Read off the prototypes:
  `prototypes.entity["decider-combinator"].electric_energy_source_prototype` is non-nil with
  `energy_usage = 16.666…`, while the constant combinator's is nil. An unpowered decider reports
  `status = no_power` and never evaluates, so any circuit probe built without a power source measures
  a vacuous zero — the rung asserts `status == "working"` before trusting a single later reading.
