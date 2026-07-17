# Factorio 2.0 (Space Age) API & Simulation Notes

Durable Factorio 2.0 API facts this plugin depends on. Each entry is marked **[API]**
(verified against [lua-api.factorio.com](https://lua-api.factorio.com/latest/)),
**[empirical]** (observed via RCON testing in this project; not stated in the docs), or
**[hypothesis]** (a mechanism EXPLANATION whose predictions have not been isolated and tested — treat as a
lead, not a law; a behavioral rule can be [empirical] while its explanation is only [hypothesis]). A version
qualifier may be appended — **[empirical, 2.0.76]** means checked against our pinned engine, and
**[API, latest]** means the current published docs, which can differ from our pin (the API drifts —
see [Space platform deletion](#space-platform-deletion)). When they disagree, the pinned-version fact
wins for this codebase. This is reference knowledge, not a changelog — see git history for when each
was learned.

## Contents

- [Fluid segment system](#fluid-segment-system)
- [Reading fluid safely](#reading-fluid-safely)
- [Fluid injection on import](#fluid-injection-on-import)
- [Inventory sizing](#inventory-sizing)
- [Item counting (get_item_count includes belts)](#item-counting)
- [Space platform deletion](#space-platform-deletion)
- [Space platform electric network](#space-platform-electric-network)
- [Save completion and atomic replacement](#save-completion-and-atomic-replacement)
- [LuaProfiler and LocalisedString](#luaprofiler-and-localisedstring)
- [Read-only entity properties](#read-only-entity-properties)
- [Players on space platforms + cross-server move](#players-on-space-platforms--cross-server-move)
- [Space platform hold semantics](#space-platform-hold-semantics)

## Fluid segment system

**[API]** Factorio 2.0.7 reworked fluid flow ([FFF-416](https://factorio.com/blog/post/fff-416)):
contiguous pipes + storage tanks are merged into **segments**; **each segment holds a single
fluid**, and throughput scales with how full the segment is. Fluids no longer mix.

Consequence: fluid does not live per-entity — it lives in the shared segment. Entity fluidboxes
(`entity.fluidbox[i]`) are a **proxy window** onto the segment, not a container.

## Reading fluid safely

- **`entity.fluidbox[i]` reads stale after a state change.** When an entity is activated or a
  platform unpaused, the local fluidbox may read `0`/`nil` for one or more ticks while it syncs
  with the segment. **[empirical]**
- **Use [`LuaFluidBox.get_fluid_segment_contents(i)`](https://lua-api.factorio.com/latest/classes/LuaFluidBox.html#method_get_fluid_segment_contents)**
  for validation — it queries the segment directly. It returns at most one fluid (segments are
  single-fluid). **[API]**
- **Deduplicate by segment ID** when summing across a network: every entity on a segment reports
  the same segment total, so summing per-entity multiplies the result.
  [`get_fluid_segment_id(i)`](https://lua-api.factorio.com/latest/classes/LuaFluidBox.html#method_get_fluid_segment_id)
  **may return `nil`** for fluid wagons, fluid-turret internal buffers, or any fluidbox not part of
  a segment (e.g. an isolated machine fluidbox) — handle the `nil` case by reading the proxy
  directly. **[API]**
- **Temperature merging is volume-weighted and prototype bounds precede key precision.**
  **[empirical, 2.0.77, fluid-lab R12]** Connecting `500 steam@165°C` to `1500 steam@500°C` produced one
  `2000@416.25°C` segment in the same tick: volume and V×T were exact. Steam writes requested at 9,999 through
  10,000,000°C all read back at the prototype maximum 5,000°C and remained one stable `steam@5000.0C` key.
  R12 therefore found no generic floating-point boundary at 10,000°C; high-temperature policy thresholds must
  be justified by the actual fluid prototype/path rather than the old ">1,000,000°C doubles" story.
- **Storage-tank mixed-temperature steam equilibrates before export and round-trips as the equilibrated key.**
  **[empirical, 2.0.77, fluid-lab R10a/R10b]** R10a proved a fixed `steam@165.0C` storage-tank segment
  (`2000`) reproduces exactly through the real transfer path and passes validation. R10b wrote `1000` steam at
  `165C` plus `1000` steam at `500C` into one storage tank; the same-tick read, +1 tick, +60 ticks, source
  debug dump, destination validation, and destination direct/segment meters all reported a single equilibrated
  `steam@332.5C = 2000` key. In this measured storage-tank case, the old exact-key gate would not have
  false-failed; aggregate-by-name validation is defensive for this case rather than proven necessary by R10b.
- **A production export lock freezes pump-driven segment transfer while belts keep moving.**
  **[empirical, 2.0.77, gate-drift LAB-A]** A powered east-facing pump moved water between two connected
  segments before export and resumed after unlock. During the real multi-tick `/export-platform` lock, the
  pump reported `disabled_by_script`, four lock-window samples per flowing section showed unchanged per-segment
  contents and stable segment IDs, while belt-position signatures continued changing. Two consecutive full
  passes covered export spans of `144`–`240` ticks; serialized versus independent single-tick physical totals
  were exact in every section (`max fluid residual=0`, `max item residual=0`). This grounds the tested source
  export path only; it does not generalize exactness to untested fluids or restoration behavior.
- **LAB-A found no source-export scan residual requiring a tolerance in its tested fixture.**
  **[empirical, 2.0.77, gate-drift LAB-A]** The existing high-temperature/merge epsilon note concerns other
  measurement domains; it is not evidence for a generic source-export volume-loss band.
- **`get_capacity(i)`** is the segment capacity. **[API]** Empirically it returns the **full segment**
  capacity for pipes/tanks but only the **local** buffer capacity for machines/thrusters, because
  pipe prototypes define `base_area` (drives segment capacity) while machines define fixed local
  `fluid_box` buffers. When injecting, pick the entity with the **highest** `get_capacity()` (a
  pipe/tank) as the target. **[empirical]**

## Fluid injection on import

- **The old pipeline's pre-activation injection lost ~15%; its responsible class was never isolated.**
  **[empirical, historical pipeline]** Moving injection after activation eliminated that whole-pipeline loss,
  but R11 later measured exact conservation using the shipped restoration code in a frozen destination world.
  Treat the old result as history, not as a current engine rule.
- *Historical mechanism hypothesis* — "a frozen/inactive entity is detached from its segment; the write
  lands in a temporary ghost buffer that is wiped when the entity rejoins a live segment on unfreeze" —
  **[hypothesis]**. The cited internals (`FluidSystem::merge_segment()`, `FluidSystem::on_entity_unfrozen`)
  are closed-source and uninspectable ("expert analysis" ≠ verification). Fluid-lab tested the prediction set:
  isolated machine buffers survived deactivation/reactivation, `game.tick_paused` during destination-hold
  stage/read did not affect isolated machine buffers, and the attempted segment-connected activatable specimen
  was unconstructible on 2.0.77 because tested activatable fluid entities expose no non-nil own-fluidbox segment
  ID. The predictions tested on 2.0.77 did not reproduce the mechanism; do not treat it as current-engine law.
- **Isolated chemical-plant heavy-oil buffers survive `active=false` and platform pause.**
  **[empirical, 2.0.77, fluid-lab R1/R3]** With `heavy-oil-cracking` explicitly enabled and the write
  read back before proceeding, a chemical plant's isolated heavy-oil input (`get_fluid_segment_id(i) == nil`)
  stayed at 20 units immediately after `active=false`, after +60 ticks, after `active=true`, and after another
  +60 ticks. Writing the same buffer while inactive also survived immediate reactivation (R2). A paused platform
  with the plant left active preserved the same 20 units across +600 ticks and after unpause (R3). R9 then proved
  the real destination-hold path also preserves an asserted isolated machine buffer while `game.tick_paused=true`;
  the hold keeps full deactivation. Directly setting `LuaEntity.frozen` failed in this lab because the property is
  read-only.
- **Production fluid restoration conserved exact aggregate-by-name totals in a frozen destination world.**
  **[empirical, 2.0.77, fluid-lab R11]** Controls covering a pipe/tank segment, a mixed pump/pipe/chemical-
  plant/boiler fixture, and newly created paused/deactivated entities all retained exact totals through
  activation and 60 ticks. Two consecutive real transfers of a 1,359-entity clone then invoked the shipped
  `FluidRestoration.restore()` before activation through a one-shot, name-scoped diagnostic seam. All eight
  fluid names matched their full-precision expected totals exactly in both the frozen and same-tick
  post-activation censuses (`max |delta| = 0`, epsilon `1e-6`). Engine-rejected fusion-plasma output writes
  were measured and subtracted before comparison. This refutes the historical rule's generalization to the
  current engine/path; the old ~15% loss remains a historical observation whose responsible class was not
  reproduced. The production path now uses this measured ordering: frozen restoration, one exact by-name fluid
  gate (`epsilon=1e-6`), then activation. Five consecutive clean 1,359-entity transfers passed with exact item
  and fluid verdicts. **[empirical, 2.0.77, single-gate acceptance]**
- **Fusion-reactor *output* fluidboxes reject external writes.** The plasma output is engine-managed
  — [`FusionReactorPrototype.output_fluid_box`](https://lua-api.factorio.com/latest/prototypes/FusionReactorPrototype.html#output_fluid_box)
  with an engine `target_temperature`; the engine generates plasma during simulation. `fluidbox[i]=`
  and `insert_fluid()` return without error but the value reads back `0`. Reactor/generator *input*
  fluidboxes accept writes normally. Track rejected writes and subtract from expected counts.
  **[empirical; aligns with the engine-managed output design per the API docs]**
- **Non-`default` fluid connection categories identify vanilla 2.0.77's unpipeable, engine-owned fluidboxes.**
  **[empirical, 2.0.77, fluid-lab P2 / plasma-engine-owned]** An exhaustive prototype census found that
  ordinary pipes and storage tanks expose only the `default` category; the `fusion-plasma` category occurs
  only on fusion-reactor outputs, fusion-generator inputs, and the cheat-only infinity pipe. A player cannot
  connect an ordinary passive holder to those boxes. Five independent transfers of production-shaped
  1,359-entity clones passed the exact gate after export expected counts, import writes, and the destination
  census all classified non-`default` boxes identically. The restorable isolated-plasma control remained
  counted in every run. Classification is derived from
  `fluidbox_prototype.pipe_connections[].connection_category`, not prototype names. Export emits a warning
  for any non-`default` category or owning prototype outside the measured fusion family; re-run this census
  and review the classification whenever the engine pin changes.

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
  lines **+** inserter-held — and is not inflated by shared belt runs. This is what the freeze-first
  `transfer-fidelity` sentinel relies on (its physical meter == the validator's `count_all_items`, both
  belt-aware; the only residual is the craft window, which freezing the source eliminates).
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
  [BELT-R9](../tests/belt-lab/NOTEBOOK.md#belt-r9-empirical-2077---topology-first-plan-a-stops-on-the-real-dup-233855-component).
- **[empirical, 2.0.76]** `tests/integration/engine-invariants` grounds the belt meter against the unique-stack
  physical total (catches both belt-item drop → meter < physical and a whole-line double-count → meter >
  physical) and asserts held-item inclusion whenever an inserter is holding.

## Belt transport-line laws (CANONICAL — 2026-07-17 recreation)

> This section is the single source of truth for belt insertion/restoration physics. Other docs must POINT
> here, not restate. Every law carries its rung; the full ledgers are in
> [tests/belt-lab/NOTEBOOK.md](../tests/belt-lab/NOTEBOOK.md), including the same-day RETRACTIONS entry
> (a briefly-held "frozen platform" claim and an "insert_at duplication" claim were instrument artifacts —
> the RCON-global lab hazard — and never reached law).

- **[empirical, 2.0.77, BELT-R10] `insert_at`'s write frame is offset from the `get_detailed_contents` read
  frame by exactly one tick of that entity's `belt_speed`** (transport 1/32, fast 2/32, express 3/32, turbo
  4/32 — `prototypes.entity[name].belt_speed` exactly; tier-parametric, NEVER a constant). Writing below
  `belt_speed` silently materializes the item on the downstream entity with ret=TRUE; writing beyond
  `line_length` honestly rejects. Any belt write must therefore use positions `>= belt_speed` (in /256 grid:
  `k >= belt_speed*256`).
- **[empirical, 2.0.77, BELT-R11/R12] Side-scoped reverse first-fit reconstructs belt contents exactly.**
  The fidelity unit is the continuous lane side (owner contract: `(name, quality, stack count)` multiset;
  position/order/window are NOT invariants). Partition the populated source by same-execution `line_equals`
  (= the lane sides); bridge to the destination by belt ordinal + line index (no engine graph — the empty
  target's input/output_lines BFS shatters on real topologies); place each side's multiset by reverse
  first-fit over that side's own windows with the R10 k-floor; validate every placement by physical
  side-census delta, never return values. Measured: 243/243 (saturated mixed omnibus) and 431/431 with
  **21/21 filtered-pure sides staying pure** (purity holds by construction). Splitter filter/priorities,
  loader filters, and infinity-chest settings all copy cleanly entity-to-entity.
- **[empirical, 2.0.77, BELT-R11] Fetch transport-line handles in the SAME execution that writes them.**
  On an aged clone, writes through stale window handles landed li-preserving in a downstream window's frame
  (864 detected-and-undone events); fresh same-execution handles produced zero. Same-side landing makes the
  class contract-benign, but production code must not cache line handles across ticks.
- **[empirical, 2.0.77, BELT-R13] Paused-platform belt physics: belts MOVE (items flow; there is no frozen
  regime — saturated lanes are still only jam-stable), belt-class `active=true`/`false` writes are REJECTED
  (reads stay false; loaders' flag IS writable — freeze feeders by deactivating loaders), and `insert_at`
  conserves exactly (distinct-unique_id controls on platform and nauvis; no duplication).** This re-confirms
  the long-standing "belts keep moving" law and is why the export-side atomic single-tick belt scan
  (Pitfall #16, atomic belt scan) remains REQUIRED.
- **Import-side single-tick belt restore is the current conservative implementation, not a proven
  requirement.** Movement within a lane side between restore batches is contract-harmless (multiset unit);
  the untested risk is items crossing SIDE boundaries (through splitters/sideloads) mid-restore before the
  gate. Incremental (multi-tick) belt restore is a design candidate gated on that rung — do not assert
  either "must be single-tick" or "safe to batch" beyond this.
- **Standard fill instrument**: infinity chest (filtered, at-least N) + filtered loader saturates a belt
  circuit to a deterministic steady state; loaders stay active on paused platforms (deactivate them to
  freeze the feed). See the Physical Truth Lab Standard's fixture-contract section.

- **[empirical, 2.0.77, no-tick-sync-lab PR-0B/LAB-B5]** The strict-gate synchronous pass
  (`restore_held_items_only` → `validate_import(..., strict=true)`) does not advance `game.tick`, does not move
  a deactivated assembler's `crafting_progress`, and does not change the restored inserter hand before the strict
  count. Measured by `tests/no-tick-sync-lab/run-pr0b.mjs`: tick 187755→187755, crafting_progress
  0.42000000000000004→0.42000000000000004, held `iron-plate x1` unchanged after restore, strict validation green.
  LAB-B5 repeated the boundary on a mid-craft furnace: reactivation plus an immediate read in one Lua execution
  kept tick, progress, input, and output identical; progress and output changed only after ticks elapsed.

- **[empirical, 2.0.77, inserter-lab B1-B4]** A player-force control and an adversarial platform containing a
  legendary bulk inserter on a destination force initialized at bonus 0 both transferred a physical held stack
  of 8 exactly. Phase-0 raised that entity force to source bonus 11 before restoration. Separately, an already
  seated hand stayed at 8 when its force bonus dropped 11→0, through elapsed ticks and
  `reset_technology_effects()`; no items appeared on the ground. Raise-only remains the import policy because
  an import should not lower unrelated destination state, not because a seated hand was observed ejecting.

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

## Space platform electric network

- **A space-platform surface has exactly ONE global electric network, and every electric entity on the
  surface joins it — regardless of position, distance, or foundation connectivity.** **[empirical, 2.0.77,
  live gallery-instance probes 2026-07-17]** Three controlled probes on throwaway platforms measured a lamp on
  a disconnected foundation patch behind a 10-tile verified-void gap reading the SAME `electric_network_id` as a
  lamp beside the hub; patches at axis distance 320 and Euclidean distance 452 (diagonal 320,320) joined the
  same network too, as did entities created in the same Lua execution as the platform and minutes later. An
  earlier reading of "separate networks per island" (ids 13/15/19) was one-network-per-PLATFORM across three
  different platforms, misread as per-island isolation. Two explanations are **REFUTED** (record as refuted, not
  fact): (a) "tiles are wires" — electricity conducting through contiguous foundation from the hub — the
  verified-void gap did not isolate; (b) any distance/radius-based membership boundary — d=452 still joined.
- **The hub reports `electric_network_id = nil` and generates no power.** **[empirical, 2.0.77, live
  gallery-instance probes 2026-07-17]** Hubs are not electric-network members, and a bare starter platform's
  network has no generation. `status = no_power` on an entity therefore means "this platform's network has no
  generation," never "this entity is disconnected."
- **`LuaSurface.has_global_electric_network` is READ-ONLY; the write path is
  `create_global_electric_network()`.** **[API, 2.0.77]** The official runtime-api.json marks
  `has_global_electric_network` with write=false; the network is created via
  `LuaSurface.create_global_electric_network()`, and starter packs create it through the prototype property
  `SpacePlatformStarterPackPrototype.create_electric_network` (boolean).

## Save completion and atomic replacement

- **`/server-save` returning does not prove the save is durable yet.** The exact active save is written via
  `<name>.tmp.zip` and then atomically replaces `<name>.zip`; a restart immediately after the RCON response can
  therefore load the previous save. Wait for the active save's temporary file to disappear, mtime to advance,
  inode to change, and final size to be nonzero before restarting or copying it. The destination-hold integration
  harness measures this through `Get-ActiveSaveName`, `Get-SaveState`, and `Wait-ForCompletedSave`.
  **[empirical, 2.0.77, destination-hold probe]**
- **Stopping an instance produced a new, valid replacement save in CI.** In PR #83's deliberate failure run
  `29139669590`, host-2's active `world.zip` changed from `mtime|size|inode`
  `1783744275|724082|9180580` to `1783744647|843161|9180248`; the temporary file was absent and both captured
  saves passed full ZIP validation. This proves stop-save replacement and validates polling the same physical
  completion signals before forensic capture. **[empirical, 2.0.77, CI save-flush probe]** Whether
  `clusterioctl instance stop` can return before that replacement completes remains **[hypothesis]**: the first
  post-return poll in this run was already complete, so post-return asynchrony was not observed.

## LuaProfiler and LocalisedString

- **[`LuaProfiler` cannot be serialized](https://lua-api.factorio.com/latest/classes/LuaGameScript.html#method_create_profiler).**
  **[API]** It cannot be stored in `storage` (crashes on save) and `tostring(profiler)` returns a
  memory address (`userdata: 0x...`), not a time. The **only** persistable form is a LocalisedString
  array `{"", profiler}` — the engine bakes the current value in during serialization; it renders
  correctly after reload but is display-only (no math, no JSON). **[empirical]**
- **A single LocalisedString is capped at 20 parameters.** Exceeding it crashes the event with
  `Too many parameters for localised string: N > 20 (limit)` — observed crashing `on_tick` during
  import completion. Split into multiple `game.print({"", ...})` calls. **[empirical]**

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

These drive the import restore path (all measured by the state-dimensions closer run; see
`tests/state-dimensions-lab/NOTEBOOK.md` and the matching integration tests).

- **Burner, energy, and heat writes are ACCEPTED while the entity is DEACTIVATED.** **[empirical, 2.0.77,
  state-dimensions-lab + entity-burner/energy/heat-roundtrip]** A deactivated burner reads back
  `currently_burning` / `remaining_burning_fuel` exactly; setting `currently_burning` does not mutate the fuel
  inventory (so it may run before `restore_inventories` clear+refill). A deactivated accumulator/machine
  accepts `entity.energy = v` exactly; a deactivated reactor accepts `entity.temperature = v` exactly. None of
  these are item-counted, so they do not perturb the pre-activation exact gate. No relocation to activation.
- **`LuaEquipment.shield` (and `.energy`) READS 0 on equipment with no such buffer, but WRITING throws.**
  **[empirical, 2.0.77, equipment-burner-roundtrip]** Reading `.shield` on non-shield equipment returns `0`
  (truthy in Lua), so a `~= nil` guard is a FALSE guard; writing `equipment.shield = v` on non-shield
  equipment throws `"Equipment is not shields."` and killed an import on_tick. Guard the write with pcall and
  capture shield/energy on export only when `> 0`.
- **A `small-lamp` has NO control behavior until it is wired; `get_control_behavior()` returns nil.**
  **[empirical, 2.0.77, circuit-config-roundtrip]** Restoring control-behavior config (circuit_condition,
  circuit_enable_disable) must use `get_or_create_control_behavior()`, or the settings are silently dropped
  for any entity whose CB is not yet instantiated at restore time (wires restore in a separate phase).
- **`LuaEntity.disabled_by_control_behavior` (boolean) is unreliable; use `status`.** **[empirical, 2.0.77,
  circuit-config-roundtrip]** A lamp genuinely disabled by its circuit condition reports
  `status == defines.entity_status.disabled_by_control_behavior` (55) while the boolean property reads
  `false`. Detect circuit-disabled state via `status`, not the property.
- **`LuaGenericOnOffControlBehavior.circuit_condition` is written in the FLAT form.** **[empirical, 2.0.77,
  circuit-config-roundtrip]** `cb.circuit_condition = {first_signal=..., comparator=..., constant=...}` takes
  (reads back the signal); a nested `{condition={...}}` form does not.
- **Recipe quality is `get_recipe()`'s SECOND return; `get_recipe_quality()` and the `recipe_quality`
  attribute do NOT exist.** **[empirical, 2.0.77, state-dimensions-lab + item-grid-roundtrip]** Both
  `entity.get_recipe_quality()` and `entity.recipe_quality` throw "doesn't contain key" — a pcall-probed
  capture or a safecall'd attribute write silently never works. Read quality via
  `local recipe, quality = entity.get_recipe()`; set it ATOMICALLY via `entity.set_recipe(name, quality)` —
  `set_recipe(name)` without the argument resets the pair to normal quality.
- **Equipment buffers: `energy = v` (incl. 0) is accepted on every equipment type; `shield = v` throws
  ("Equipment is not shields.") on non-shield equipment, and `max_shield` reads 0 there vs the real
  capacity on shields.** **[empirical, 2.0.77, state-dimensions-lab probe]** Use `max_shield > 0` as the
  shield-capture discriminator; energy can be captured/restored unconditionally. Grid equipment QUALITY
  must be passed at `grid.put({name, position, quality})` time — it is not writable afterwards.
- **Ghost/proxy classes are safe for generic inventory/state reads.** **[empirical, 2.0.77,
  state-dimensions-lab probe]** entity-ghost, tile-ghost, and item-request-proxy all return
  `get_max_inventory_index()` (8) without throwing and read `.burner` as nil without throwing — generic
  extraction reaching these classes is not a crash vector at this pin.

## Players on space platforms + cross-server move

These facts drive how cross-instance transfer handles a player who is "aboard" a platform
(see [GATEWAY_TRANSFER_PRD.md](GATEWAY_TRANSFER_PRD.md) and the passenger-evacuate test).

- **A player on a platform is hub-locked in remote view with ~no inventory.** Official wiki
  (Space platform → Passengers): a character traveling to a platform "is **not allowed to carry any items
  in their inventory, except for their equipped weapons and armor (but not ammunition)**"; players aboard are
  "**locked inside the space platform hub, unable to move … locked into remote view** until they drop their
  character to a planetary surface", and "**there is no way to access a player's inventory while in this
  state.**" So a "passenger" carries essentially nothing to sync. **[wiki, verified]**
- **Native hub-loss returns the player to the planet they were last at.** This is why evacuating an aboard
  player to a planet on transfer is *native-aligned*, not a hack. **[wiki]**
- **Detecting an aboard player**: `player.physical_surface_index == platform.surface.index` (catches a
  connected pilot AND a disconnected player still on it) ∪ `surface.count_entities_filtered{type="character"}`
  (abandoned bodies). A remote-view *watcher* has `surface_index` but not `physical_surface_index` → NOT
  aboard. `LuaSpacePlatform` has no players/characters accessor — go through the surface. **[empirical]**
- **Moving a player off a platform**: `LuaPlayer.land_on_planet()` lands on "the current planet" → **useless
  at a surfaceless gateway** (no planet); use `player.teleport(pos, planet_surface)` instead.
  `enter_space_platform(space_platform) → boolean` (takes a **LuaSpacePlatform object**, not a name; returns
  whether the player entered) / `leave_space_platform()` are the on/off-platform primitives. **[API, 2.0.77]**
  (Whether `teleport` cleanly exits a hub-locked remote-view session for a *connected* player is verified by
  hand — the automated test exercises an abandoned character body.) **[docs + to-verify]**
- **Redirecting a player's client to another server**: `LuaPlayer.connect_to_server{address, name,
  description, password}` — "**Asks** the player if they would like to connect" (a PROMPT the player accepts;
  it is a **no-op on a host / single-player**, only works on a connected multiplayer *peer*). Address comes
  from Clusterio's `host.public_address` + instance `game_port` (the `server_select` plugin pattern). Not
  silent; **no engine permission/admin gate** (the client just accepts the prompt); engine API since 2.0.47.
  `public_address` defaults to `"localhost"` (must be client-routable). Basis of the future Layer-2 "follow
  your platform" feature — spike done 2026-07-03 (**CONDITIONAL GO**), see
  [GATEWAY_TRANSFER_PRD.md](GATEWAY_TRANSFER_PRD.md). **[docs 2.0.77, verified]**

## Space platform hold semantics

- **[empirical, 2.0.77, hold-lab PR-0A]** Spoilage is anchored to global game ticks and continues under `platform.paused`. In the hold-completeness lab, a held yumako stack drifted by the same spoil percent as the live-control stack while the platform was hidden, paused, and held. This is acceptable destination-hold behavior: the not-live contract is no observable side effects, held drift no worse than the live control, zero platform damage, and nothing leaving the platform — not frozen time.
- **[empirical, 2.0.77, hold-lab PR-0A]** Cargo-pod state machines are pause-exempt. Before the primitive fix, a held cargo pod advanced while `platform.paused=true`; `DestinationHold.stage()` now reuses `SurfaceLock.complete_cargo_pods` after pausing/hiding/deactivating the held platform, so a staged destination hold is pod-free. The PR-0A live specimen was an `awaiting_launch` pod: it verified `pod_count=0` immediately after stage and after the hold window, with overflow cargo retained on the platform as item-on-ground when the hub was full. The shared helper also routes `descending`/`parking` pods through the same recover-and-spill path, but PR-0A did not construct that state as a separate live specimen.

## Fluid segment membership and paused destination holds

- **[empirical, 2.0.77, fluid-lab R9]** A deterministic chemical-plant `heavy-oil-cracking` fixture with a verified 20 heavy-oil direct buffer preserved that buffer through the real destination-hold primitive while the game was held paused: pre-read -> stage -> +600 held ticks -> go-live -> +60 -> unpaused +120 all read direct machine fluid = 20. The plant buffer remained isolated (`segment_id=nil`, segment meter = 0). `game.tick_paused=true` during stage/read does not affect isolated machine buffers; fixture/meter hardening was sufficient and the destination-hold primitive remains unchanged.
- **[empirical, 2.0.77, fluid-lab R7]** Tested activatable fluid entities did not expose non-nil fluid segment IDs on their own fluidboxes: chemical-plant buffers were isolated, and a pump connected to adjacent pipes still returned no pump-side segment ID after tick updates while the pipes/tanks reported segment IDs. Pipes/tanks are segment-meter surfaces but are not activatable. For the tested engine surface, no activatable entity's own fluidbox exposes a non-nil segment ID; the ghost-buffer mechanism's current constructible domain is empty.
- **[unexplained, 2.0.77, destination-hold CI delta=20]** The original CI-only `fluids 1120→1100 delta=20` was eliminated by fixture determinism and direct-machine meter hardening, but its root cause was never isolated. Remaining candidates are the fresh-force recipe-less write path and meter staleness. The instrumented probe now reports tick, `game.tick_paused`, platform pause, direct machine buffers, and segment meters so any recurrence self-diagnoses instead of becoming a silent fidelity claim.
