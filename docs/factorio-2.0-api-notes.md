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
claim in a reference doc is a liability, and the git history keeps it if anyone ever needs it. Tags are
**[API]** (Wube-documented, kept only where a subtlety bites us) and **[empirical, `<pin>`, `<citation>`]**.
When the official docs and our pinned engine disagree, the pinned-engine measurement wins.

## Contents

- [Fluid model at 2.1.11](#fluid-model-at-2111)
- [Inventory sizing](#inventory-sizing)
- [Item counting (get_item_count includes belts)](#item-counting)
- [Belt transport-line laws (CANONICAL)](#belt-transport-line-laws-canonical--2026-07-17-recreation)
- [Space platform deletion](#space-platform-deletion)
- [Read-only entity properties](#read-only-entity-properties)
- [Deactivated-entity state writes and control-behavior / equipment restore](#deactivated-entity-state-writes-and-control-behavior--equipment-restore)
- [Read-only entity properties](#read-only-entity-properties)

## Fluid model at 2.1.11

> The dev cluster and the plugin's fluid layer run **Factorio 2.1.11** (all instances since 2026-07-21),
> and `tests/labs-certified.json` is certified at 2.1.11 (`certified_at` 2026-07-21) — the
> re-certification campaign landed, so `lint:version-certification` is green rather than pending.
> The laws below were measured by live fluid-law experiments on 2.1.11; the running instrument is
> `tests/instruments/fluid-segment-law/run-tests.mjs`, which re-measures them on demand.

- **`entity.fluidbox` is HARD-REMOVED — reading the attribute THROWS.** **[API]** Fluid access is index-based LuaEntity/LuaFluidBox methods: `fluids_count`, `get_fluid(i)`,
  `set_fluid(i, fluid)`, `has_fluid_segment(i)`, `get_fluid_segment_id(i)`, `get_fluid_segment_fluid(i)`,
  `set_fluid_segment_fluid(i, fluid)`, `get_fluid_segment_capacity(i)`, `get_fluid_box_prototype(i)`,
  `fluidbox_neighbours`. **Segment getters THROW on a segmentless box** (2.0 returned `nil`) — always guard
  with `has_fluid_segment(i)` before any `get_fluid_segment_*` call.
  **[empirical, 2.1.11, tests/instruments/fluid-segment-law]** (rung: segment getters throw on segmentless)
- **The buffer/window duality is GONE.** **[empirical, 2.1.11, tests/instruments/fluid-segment-law]**
  `get_fluid_segment_fluid(i)` returns the EXACT single-fluid segment total from ANY member box at ANY
  instant — a thruster fuel box read 500 exact, and a fusion-reactor coolant box read 300→450 exact both
  mid-transient and settled. There is no order-dependent claim, no mixed-regime "contents + Σ locals" law, and
  no `production_type` classifier needed. `get_fluid(i)` instead returns the box's own **capacity share** of
  the segment (float32: 12 pipes on one 1000-unit segment summed to `999.9999997615814`; a thruster:pipe share
  ratio was 10:1 by capacity), which the registry keeps for census attribution and split-segment
  proportioning.
- **`set_fluid_segment_fluid(i, fluid)` writes a WHOLE segment in one call.** **[empirical, 2.1.11, tests/instruments/fluid-segment-law]** Writing 400 coolant to a segment read back 400 exact — no highest-capacity-member
  workaround. A segmentless storage is written with `set_fluid(i, fluid)`, which returns the accepted amount.
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

## Inventory sizing

- **[`LuaInventory.resize(size)`](https://lua-api.factorio.com/latest/classes/LuaInventory.html#method_resize)
  works only on inventories created by `create_inventory`** — not entity inventories. **[API]**
- **Entity inventory size override is partial — it does NOT help crafter inputs.**
  `LuaEntity.set_inventory_size_override` / `get_inventory_size_override` exist, but verified on **2.0.76**:
  the runtime arg order is `(inventory_index, size_override, overflow)` — the
  [latest docs](https://lua-api.factorio.com/latest/classes/LuaEntity.html#method_set_inventory_size_override)
  show `(inventory_index, overflow, size_override)`, so the order changed post-2.0.76 — and `overflow` must
  be a real `LuaInventory` (e.g. from `create_inventory`). It overrides **container** inventory sizes
  (iron-chest 32→48, `get_inventory_size_override`→48) but is a **no-op for crafting-machine input
  inventories** (the call returns ok, yet size and override stay unchanged). So it is **not** a lever for the
  overloaded-crafter-input item loss — that case is already handled by the beacon-first `set_stack` ordering.
  **[empirical, 2.0.76]**

## Item counting

- **`LuaEntity.get_item_count(item)` is a per-entity total that INCLUDES that entity's belt-line and
  inserter-held items.** Verified on **2.0.76**:
  - On a belt it returns *exactly* that belt's `Σ get_transport_line(i).get_item_count(item)` (measured
    104=104, 4=4, 8=8). Each belt exposes its **own per-belt** transport line, so it counts only **its own
    tile** — adjacent belts on the same run report **independent** counts (measured 8 vs 16 on two neighbours).
    Therefore **summing `get_item_count` over every belt entity does NOT double-count** a shared run; each belt
    contributes only its own items. Cross-checked against an independent physical total (the count of unique
    `get_detailed_contents().unique_id` stacks): `Σ get_item_count` over 193 belts = 5277 = the unique-stack
    total, exactly.
  - On an inserter it **includes the held hand** (`held_stack`): measured `get_item_count(held.name) == held.count`
    across 8 holding inserters.
- **So a physical total computed as `get_item_count` over every entity is complete** — inventories **+** belt
  lines **+** inserter-held — and is not inflated by shared belt runs (a general engine fact, guarded by
  `tests/instruments/engine-invariants`). NOTE: the production paired-reads source census does NOT use
  `get_item_count` as its physical oracle — it reads through `InventoryScanner.extract_all_inventories`
  (the same primitive the serializer uses); this completeness fact is what a `get_item_count`-based meter
  would rely on, retained here as engine truth.
- **Do NOT add a separate `get_transport_line` pass on top of a `get_item_count` total — that double-counts the
  belts** (`get_item_count` already includes them).
- **`line_equals` is neither identity nor content equality — but it IS the same-execution side partition
  on a populated source.** At 2.0.76 it was observed returning `true` for two belts whose lines hold
  different counts, so never ground belt TOTALS on `line_equals` dedup (use `get_item_count` or unique
  `get_detailed_contents().unique_id` stacks). At 2.0.77, however, grouping a POPULATED surface's transport
  lines by `line_equals` within ONE Lua execution partitions them into physical lane sides (left/right lanes
  never merge) — the partition that BELT-R11/R12 reconstruction is built on. The grouping is state-dependent
  (an empty, topologically identical target groups differently) and is only valid same-execution,
  same-surface, populated; it is NOT a cross-import key (see BELT-R9 below).
- **[empirical, 2.0.77, BELT-R9] Engine transport-line identity is not a durable cross-import restoration
  key.** On five DUP-233855 baseline replays, the known belt-phase deficit was exactly five items before
  recovery. Owner-narrowed `line_equals` resolution produced multiple matches on both known loss components,
  and three identical imports produced different component/ambiguity/resolved-edge counts. This does not
  invalidate `get_item_count` or unique-ID enumeration as physical meters; it invalidates using the engine
  line graph to certify that a source and imported line represent the same continuous physical lane/side. See
  BELT-R9 in the belt-lab NOTEBOOK (archived at git tag `labs-archive-2026-07-19`).
- **[empirical, 2.0.76]** `tests/instruments/engine-invariants` grounds the belt meter against the unique-stack
  physical total (catches both belt-item drop → meter < physical and a whole-line double-count → meter >
  physical) and asserts held-item inclusion whenever an inserter is holding.

## Belt transport-line laws (CANONICAL — 2026-07-17 recreation)

> This section is the single source of truth for belt insertion/restoration physics. Other docs must POINT
> here, not restate. Every law carries its rung; the full ledgers are in the belt-lab NOTEBOOK
> (archived at git tag `labs-archive-2026-07-19`), including the same-day RETRACTIONS entry
> (a briefly-held "frozen platform" claim and an "insert_at duplication" claim were instrument artifacts —
> the RCON-global lab hazard — and never reached law).

- **[empirical, 2.0.77, BELT-R10] `insert_at`'s write frame is offset from the `get_detailed_contents` read
  frame by exactly one tick of that entity's `belt_speed`** (transport 1/32, fast 2/32, express 3/32, turbo
  4/32 — `prototypes.entity[name].belt_speed` exactly; tier-parametric, NEVER a constant). Writing below
  `belt_speed` returns TRUE and lands the item clamped at `max(0, write − belt_speed)` on a fresh separate
  line (measured; fresh adjacent belts do NOT merge lines) — while in aged/merged-handle frames the landing
  can be attributed to a downstream window (the BELT-R11 leak class; regime-dependent, do not conflate).
  Writing beyond `line_length` honestly rejects. Any belt write must therefore use positions
  `>= belt_speed` (in /256 grid: `k >= belt_speed*256`).
- **[empirical, 2.1.11, BELT-R16 — live workhorse transfer 2026-07-27] BOUNDARY HANDOFF: an `insert_at`
  near the TOP of a line (within one write-frame of `line_length`) seats the item ACROSS the piece
  boundary on the downstream entity's line** — measured landings: turbo-underground-belt INTERNAL lines
  (3/4) at k=31 ≈ one write-frame, for placements requested at feeding-line tops (k 255/294). Item count
  conserves per handoff, but position and line do not. When the landing line is in the SAME side, a
  side-census validation passes (wrong-position only: 248 born = 248 vanished pairs per key in the
  placement-ledger reconciliation); when it crosses SIDES, the census reads "nothing landed" and a
  retry loop DUPLICATES (net +34 items across exactly the 6 bracket-mismatch keys). The cross-side
  retry-duplication step is a strong inference fitting all data (an underground-free fixture measured
  exact in every leg; the underground-riddled workhorse always drifted), not yet isolated as its own
  rung. Consequence: never write at line tops near piece boundaries — the production restore is
  placement at captured source positions (below) precisely to avoid this class.
- **[empirical, 2.1.11, black box on the passenger-evacuate refusal 2026-07-27] IN-TRANSIT BOUNDARY
  ITEM: a line captured MID-MOTION can carry ONE MORE item than its rest capacity** — the front item
  is in transit across the piece boundary at the capture instant. Measured from the banked black
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
- **[empirical, 2.0.77, BELT-R11/R12] Side-scoped reverse first-fit reconstructs belt contents exactly**
  — on underground-free topologies; at scale the top-of-line writes it leans on trip BELT-R16 handoffs,
  so production placement puts each slot back onto its captured entity/line/position (via the payload's
  compact per-side `item_source_positions` array, requesting `src.k − belt_speed·256` per R10).
  `item_source_positions` is REQUIRED and there is NO fallback placement (owner order 2026-07-27: the
  reverse first-fit fallback, the legacy consolidation restore, and hub-deficit recovery are DELETED; a
  payload without it is refused at import; a slot whose captured position cannot place is honest
  unplaced loss the exact gate refuses — the
  BELT-R3/R5 hub-recovery lesson, anything inserted into the hub before inventory Pass 2 is wiped by the
  clear()+refill, is retained here). Measured captured-source-position placement at
  workhorse scale [empirical, 2.1.11, 2026-07-27]: 5777/5777 stacks traced same-line, BORN 0, VANISHED 0,
  source-position offset avg 19.3/256, full frozen-world exact gate PASS. The rest of the R11/R12 recipe is
  unchanged and load-bearing: the fidelity unit is the continuous lane side (owner contract:
  `(name, quality, stack count)` multiset; position/order/window are NOT invariants —
  restoring position is a COURTESY and a handoff-avoidance measure, not a new invariant). Partition
  the populated source by same-execution `line_equals` (= the lane sides); bridge to the destination by
  belt ordinal + line index (no engine graph — the empty target's input/output_lines BFS shatters on
  real topologies); validate every placement by physical side-census delta, never return values.
  Measured: 243/243 (saturated mixed omnibus) and 431/431 with **21/21 filtered-pure sides staying
  pure** (purity holds by construction). Splitter filter/priorities, loader filters, and infinity-chest
  settings all copy cleanly entity-to-entity.
- **[empirical, 2.0.77, BELT-R11] Fetch transport-line handles in the SAME execution that writes them.**
  On an aged clone, writes through stale window handles landed li-preserving in a downstream window's frame
  (864 detected-and-undone events); fresh same-execution handles produced zero. Same-side landing makes the
  class contract-benign, but production code must not cache line handles across ticks.
- **[empirical, 2.0.77, BELT-R13] Paused-platform belt physics: belts MOVE (items flow; there is no frozen
  regime — saturated lanes are still only jam-stable), belt-class `active=true`/`false` writes are REJECTED
  (reads stay false; loaders' flag IS writable — freeze feeders by deactivating loaders), and `insert_at`
  conserves exactly (distinct-unique_id controls on platform and nauvis; no duplication).** This re-confirms
  the long-standing "belts keep moving" law and is why the export-side atomic single-tick belt scan
  (atomic belt scan) remains REQUIRED.
- **Import-side single-tick belt restore is the current conservative implementation, not a proven
  requirement.** Movement within a lane side between restore batches is contract-harmless (multiset unit);
  the untested risk is items crossing SIDE boundaries (through splitters/sideloads) mid-restore before the
  gate. Incremental (multi-tick) belt restore is a design candidate gated on that rung — do not assert
  either "must be single-tick" or "safe to batch" beyond this.
- **[empirical, 2.0.77, BELT-R15] AGED-TARGET leak class: `insert_at` onto belt targets created in a
  PRIOR Lua execution enters the leak-undo path; identical fresh same-execution targets measure zero
  leaks (BELT-R14 2x green, R11/R12 — same topology/basis, target age the only variable).** The
  "fresh same-execution targets" precondition in belt_restoration.lua is LOAD-BEARING: any restore
  design must create its belts and write their lines in the SAME execution (per batch, side-closed,
  for incremental shapes). R15 also exposed a LATENT crash in `undo_inserted_delta`
  (belt_restoration.lua:506): it iterates stack handles fetched before `remove_item` invalidates
  them — a hard crash the first time a real leak fires; unreachable on shipped fresh-target paths,
  MUST be fixed (/di-change) before any design that can reach the leak path.
- **Standard fill instrument**: infinity chest (filtered, at-least N) + filtered loader saturates a belt
  circuit to a deterministic steady state; loaders stay active on paused platforms (deactivate them to
  freeze the feed). See the Physical Truth Lab Standard's fixture-contract section.

- **[empirical, 2.0.77, no-tick-sync-lab PR-0B/LAB-B5]** The strict-gate synchronous pass
  (`restore_held_items_only` → `validate_import(..., strict=true)`) does not advance `game.tick`, does not move
  a deactivated assembler's `crafting_progress`, and does not change the restored inserter hand before the strict
  count. Measured by the no-tick-sync-lab PR0b runner (archived at git tag `labs-archive-2026-07-19`): tick 187755→187755, crafting_progress
  0.42000000000000004→0.42000000000000004, held `iron-plate x1` unchanged after restore, strict validation green.
  LAB-B5 repeated the boundary on a mid-craft furnace: reactivation plus an immediate read in one Lua execution
  kept tick, progress, input, and output identical; progress and output changed only after ticks elapsed.

- **[empirical, 2.0.77, inserter-lab B1-B4]** A player-force control and an adversarial platform containing a
  legendary bulk inserter on a destination force initialized at bonus 0 both transferred a physical held stack
  of 8 exactly. Phase-0 raised that entity force to source bonus 11 before restoration. Separately, an already
  seated hand stayed at 8 when its force bonus dropped 11→0, through elapsed ticks and
  `reset_technology_effects()`; no items appeared on the ground. Raise-only remains the import policy because
  an import should not lower unrelated destination state, not because a seated hand was observed ejecting.

- **[empirical, 2.0.77, inserter-lab B6 + pad inserter-held-capacity]** `held_stack.set_stack()` seating is **activation-independent**:
  a DEACTIVATED inserter (freshly created AND after 300+ ticks of settled deactivation) seats a full hand
  when force capacity allows (legendary bulk 8/8 at bulk bonus 11; plain 4/4 at stack bonus 3), and on a
  bonus-0 force the clamp is IDENTICAL inactive vs active (both 8→1). The prior lore — "set_stack silently
  fails/under-fills on a settled-deactivated inserter", "bulk capacity only applies when active" — is
  REFUTED; no rung had ever isolated activation as its own variable (D3 ran briefly-active; B1-B4 isolated
  force bonus). The historical missing-held phantom traces to the deserializer's DEAD held-restore
  (unreachable behind `restore_inventories`' has_inventories early-return) plus the force-bonus clamp.

## Space platform deletion

- **`LuaSpacePlatform.destroy()` behavior changed between 2.0.76 and 2.0.77.** At 2.0.76, `destroy()`,
  `destroy(0)`, and `destroy(60)` all returned success but remained valid after 100+ ticks. **[empirical, 2.0.76]**
  LAB-I B7 on 2.0.77 measured `destroy()` with no argument still as a no-op, while `destroy(0)` deleted after
  an elapsed tick and `destroy(60)` deleted on schedule. **[empirical, 2.0.77, engine-repin-lab B7]** Use
  `game.delete_surface` through `GameUtils.delete_platform` for deterministic project teardown.
  The [latest docs](https://lua-api.factorio.com/latest/classes/LuaSpacePlatform.html#method_destroy) show
  `destroy(ticks)` scheduling deferred deletion, matching the measured 2.0.77 ticked forms. **[API, latest]**
- **This project uses
  [`game.delete_surface(platform.surface)`](https://lua-api.factorio.com/latest/classes/LuaGameScript.html#method_delete_surface)**
  for immediate, deterministic teardown of a platform and all its entities. Route all platform
  removal through `GameUtils.delete_platform` (`module/utils/game-utils.lua`); a lint guard
  (`npm run lint:lua`) blocks direct `*platform*.destroy()` calls.

## Read-only entity properties

- **`LuaEntity.frozen` is read-only on 2.0.77.** **[empirical, 2.0.77, fluid-lab R1/R8]** Direct assignment (`entity.frozen = true` or `false`) fails with `LuaEntity::frozen is read only.` A module-tree grep found no production `.frozen =` assignments, so the current drift is documentation/API-note wording rather than a live write site. Code that needs frozen-state changes must go through entity creation/import seams that the engine permits, not post-create assignment.
- **Many entity properties became read-only in 2.0** (e.g. quality, computed bonuses like
  `productivity_bonus`, which aggregates force + beacon/module bonuses). Set them during
  `create_entity`, not after, and wrap optional writes in `pcall`. **[empirical]**
- **`crafting_speed` updates instantly** when a nearby beacon's `beacon_modules` inventory is
  populated — no tick delay, no power needed. This is why import restores beacon module inventories
  before crafter inputs, so `set_stack()` caps reflect the beacon-boosted speed. LAB-I B8 measured
  `1.25→3.125` in the same module-population execution with two speed-module-3 modules, both powered and
  unpowered; the first elapsed read stayed 3.125. **[empirical, 2.0.77, engine-repin-lab B8]**

- **Unknown inventory items are skipped with a warning while valid siblings restore.** LAB-I B9 imported an
  iron chest containing `iron-plate x10` plus a nonexistent item. The remote completed without error, the chest
  physically held all ten valid plates, and the host log gained the expected "Skipped unknown item" warning.
  **[empirical, 2.0.77, engine-repin-lab B9]**

## Deactivated-entity state writes and control-behavior / equipment restore

These drive the import restore path (all measured by the state-dimensions closer run; see the
state-dimensions-lab NOTEBOOK, archived at git tag `labs-archive-2026-07-19`, and the matching integration tests).

- **Burner, energy, and heat writes are ACCEPTED while the entity is DEACTIVATED.** **[empirical, 2.0.77, state-dimensions-lab + pads omnibus-burner-fuel/omnibus-heat-temperature]** A deactivated burner reads back
  `currently_burning` / `remaining_burning_fuel` exactly; setting `currently_burning` does not mutate the fuel
  inventory (so it may run before `restore_inventories` clear+refill). A deactivated accumulator/machine
  accepts `entity.energy = v` exactly; a deactivated reactor accepts `entity.temperature = v` exactly. None of
  these are item-counted, so they do not perturb the pre-activation exact gate. No relocation to activation.
- **`LuaEquipment.shield` (and `.energy`) READS 0 on equipment with no such buffer, but WRITING throws.**
  **[empirical, 2.0.77, pad omnibus-adversarial-inventory]** Reading `.shield` on non-shield equipment returns `0`
  (truthy in Lua), so a `~= nil` guard is a FALSE guard; writing `equipment.shield = v` on non-shield
  equipment throws `"Equipment is not shields."` and killed an import on_tick. Guard the write with pcall and
  capture shield/energy on export only when `> 0`.
- **A `small-lamp` has NO control behavior until it is wired; `get_control_behavior()` returns nil.**
  **[empirical, 2.0.77, pad omnibus-circuit-config]** Restoring control-behavior config (circuit_condition,
  circuit_enable_disable) must use `get_or_create_control_behavior()`, or the settings are silently dropped
  for any entity whose CB is not yet instantiated at restore time (wires restore in a separate phase).
- **Most entity types are natively `active == false`, so "active" is not a fidelity axis for them.**
  **[empirical, 2.1.11, gallery source-vs-destination control 2026-07-28]** On the untouched gallery
  source, 486 of 542 entities read `active == false`: pipes, pipe-to-grounds, belts, splitters,
  containers, storage tanks, electric poles, solar panels, accumulators, lamps, display panels,
  combinators, resources, ground items — and the space-platform-hub itself. These are passive
  entities with no per-tick update. Never diff raw `active` counts between source and destination and
  read the difference as damage; diff them PER TYPE against the source control, or the ~490 natively
  inactive entities swamp the handful that matter.
- **The import freezes nearly every type but only wakes `ACTIVATABLE_ENTITY_TYPES`, so a type that is
  natively ACTIVE and absent from that list arrives permanently disabled.**
  **[empirical, 2.1.11, gallery whole-platform transfer 2026-07-28]** `entity_creation.lua` disables
  everything except beacon/radar/item-request-proxy; `SurfaceLock.activate_all` and
  `ActiveStateRestoration` both filter by `ACTIVATABLE_ENTITY_TYPES`. Measured on a real transfer,
  the source-vs-destination difference is exactly **infinity-pipe x2 and spider-vehicle x2** — active
  at the source, inactive at the destination. The gate cannot see this (it counts items and fluids,
  not activity). A spidertron riding a transferred platform arrives disabled.
- **A decider combinator's OUTPUT REGISTER is not script-writable.**
  **[empirical, 2.1.11, circuit-latch-rearm R1]**
  `LuaDeciderCombinatorControlBehavior` has no `set_signal` ("doesn't contain key"). So a self-feedback (SR) latch cannot
  be restored by any serializer: it arrives with its register at 0, reads its own 0 through the
  feedback wire, and is stable at 0 — the source's held signal is LOST on transfer.
  (An earlier revision of this entry also claimed `disabled_by_script` is a NO-OP on combinators,
  from a rung that wrote `true` and read the property back as `false`. RETRACTED 2026-07-28: that
  test was confounded — combinators are natively `active == false` (see the entry above), so neither
  the readback nor an `active` check distinguishes "the write was ignored" from "it was already
  off". Whether the write takes effect on a combinator is UNMEASURED; a correct rung must record
  `active` BEFORE the write.)
- **A cleared latch CAN be re-armed by temporarily rewriting the decider's CONDITION.**
  **[empirical, 2.1.11, circuit-latch-rearm R3]** Control behaviour IS writable: forcing the condition
  true, letting it evaluate, then restoring the captured condition leaves the latch holding itself
  (measured `(empty)` → `signal-S=1` → `signal-S=1` after restore). NOT IMPLEMENTED in production, and
  two caveats gate it: (a) it needs at least one UNPAUSED tick, so it cannot run inside the frozen
  pre-gate window — it would have to be a post-activation pass, which is lawful only because circuit
  signals are not part of the exact gate (items + fluids); (b) an output with
  `copy_count_from_input=false` always emits 1, so a source register holding a count other than 1 is
  still not reproduced, and forcing a condition true momentarily pulses whatever the network drives.
- **Decider and arithmetic combinators DRAW POWER (16.67 J/tick); constant combinators do not.**
  **[empirical, 2.1.11, circuit-latch-rearm build guard]** Read off the prototypes:
  `prototypes.entity["decider-combinator"].electric_energy_source_prototype` is non-nil with
  `energy_usage = 16.666…`, while the constant combinator's is nil. An unpowered decider reports
  `status = no_power` and never evaluates, so any circuit probe built without a power source measures
  a vacuous zero — the rung asserts `status == "working"` before trusting a single later reading.
- **Recipe quality is `get_recipe()`'s SECOND return; `get_recipe_quality()` and the `recipe_quality`
  attribute do NOT exist.** **[empirical, 2.0.77, state-dimensions-lab + pad omnibus-adversarial-inventory]** Both
  `entity.get_recipe_quality()` and `entity.recipe_quality` throw "doesn't contain key" — a pcall-probed
  capture or a safecall'd attribute write silently never works. Read quality via
  `local recipe, quality = entity.get_recipe()`; set it ATOMICALLY via `entity.set_recipe(name, quality)` —
  `set_recipe(name)` without the argument resets the pair to normal quality.
