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
- **Use an epsilon** for high-temperature / large-volume fluids — floating-point drift and
  temperature-weighted merges shift exact `fluid@temp` keys. Validate on volume (or thermal energy
  V×T), not exact temperature buckets. **[empirical]**
- **Storage-tank mixed-temperature steam equilibrates before export and round-trips as the equilibrated key.**
  **[empirical, 2.0.77, fluid-lab R10a/R10b]** R10a proved a fixed `steam@165.0C` storage-tank segment
  (`2000`) reproduces exactly through the real transfer path and passes validation. R10b wrote `1000` steam at
  `165C` plus `1000` steam at `500C` into one storage tank; the same-tick read, +1 tick, +60 ticks, source
  debug dump, destination validation, and destination direct/segment meters all reported a single equilibrated
  `steam@332.5C = 2000` key. In this measured storage-tank case, the old exact-key gate would not have
  false-failed; aggregate-by-name validation is defensive for this case rather than proven necessary by R10b.
- **`get_capacity(i)`** is the segment capacity. **[API]** Empirically it returns the **full segment**
  capacity for pipes/tanks but only the **local** buffer capacity for machines/thrusters, because
  pipe prototypes define `base_area` (drives segment capacity) while machines define fixed local
  `fluid_box` buffers. When injecting, pick the entity with the **highest** `get_capacity()` (a
  pipe/tank) as the target. **[empirical]**

## Fluid injection on import

- **Inject fluid only after `entity.active = true` and `entity.frozen = false`.** **[empirical]** — the
  behavioral rule is solid: injecting pre-activation reproducibly lost ~15% of fluids; the
  inject-after-activation reorder eliminated the loss and has been regression-tested since.
- *Mechanism explanation for the above* — "a frozen/inactive entity is detached from its segment; the write
  lands in a temporary ghost buffer that is wiped when the entity rejoins a live segment on unfreeze" —
  **[hypothesis]**. The cited internals (`FluidSystem::merge_segment()`, `FluidSystem::on_entity_unfrozen`)
  are closed-source and uninspectable ("expert analysis" ≠ verification). Fluid-lab tested the prediction set:
  isolated machine buffers survived deactivation/reactivation, `game.tick_paused` during destination-hold
  stage/read did not affect isolated machine buffers, and the attempted segment-connected activatable specimen
  was unconstructible on 2.0.77 because tested activatable fluid entities expose no non-nil own-fluidbox segment
  ID. Retain the behavioral import rule on historical evidence; do not treat the ghost-buffer mechanism as
  proven for current-engine destination-hold design.
- **Isolated chemical-plant heavy-oil buffers survive `active=false` and platform pause.**
  **[empirical, 2.0.77, fluid-lab R1/R3]** With `heavy-oil-cracking` explicitly enabled and the write
  read back before proceeding, a chemical plant's isolated heavy-oil input (`get_fluid_segment_id(i) == nil`)
  stayed at 20 units immediately after `active=false`, after +60 ticks, after `active=true`, and after another
  +60 ticks. Writing the same buffer while inactive also survived immediate reactivation (R2). A paused platform
  with the plant left active preserved the same 20 units across +600 ticks and after unpause (R3). R9 then proved
  the real destination-hold path also preserves an asserted isolated machine buffer while `game.tick_paused=true`;
  the hold keeps full deactivation. Directly setting `LuaEntity.frozen` failed in this lab because the property is
  read-only.
- **Fusion-reactor *output* fluidboxes reject external writes.** The plasma output is engine-managed
  — [`FusionReactorPrototype.output_fluid_box`](https://lua-api.factorio.com/latest/prototypes/FusionReactorPrototype.html#output_fluid_box)
  with an engine `target_temperature`; the engine generates plasma during simulation. `fluidbox[i]=`
  and `insert_fluid()` return without error but the value reads back `0`. Reactor/generator *input*
  fluidboxes accept writes normally. Track rejected writes and subtract from expected counts.
  **[empirical; aligns with the engine-managed output design per the API docs]**

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
- **Do NOT reason about belt grouping via `line_equals` at 2.0.76 — it is unreliable here** (observed returning
  `true` for two belts whose lines hold *different* counts, so it is neither identity nor content equality).
  Ground belt totals on `get_item_count` (or unique `get_detailed_contents().unique_id` stacks), never on
  `line_equals` dedup.
- **[empirical, 2.0.76]** `tests/integration/engine-invariants` grounds the belt meter against the unique-stack
  physical total (catches both belt-item drop → meter < physical and a whole-line double-count → meter >
  physical) and asserts held-item inclusion whenever an inserter is holding.

- **[empirical, 2.0.77, no-tick-sync-lab]** The strict-gate synchronous pass
  (`restore_held_items_only` → `validate_import(..., strict=true)`) does not advance `game.tick`, does not move
  a deactivated assembler's `crafting_progress`, and does not change the restored inserter hand before the strict
  count. Measured by `tests/no-tick-sync-lab/run-pr0b.mjs`: tick 187755→187755, crafting_progress
  0.42000000000000004→0.42000000000000004, held `iron-plate x1` unchanged after restore, strict validation green.

## Space platform deletion

- **`LuaSpacePlatform.destroy()` is a no-op at 2.0.76 — use `game.delete_surface` instead.** Verified via
  RCON on the pinned version: `destroy()`, `destroy(0)`, and `destroy(60)` all return `ok=true` but the
  platform stays `valid` and present after 100+ ticks. `hub.destroy()` is auto-recovered by the engine.
  `game.delete_surface(platform.surface)` does remove it (verified — end-of-tick deferred). **[empirical, 2.0.76]**
  The [latest docs](https://lua-api.factorio.com/latest/classes/LuaSpacePlatform.html#method_destroy) show
  `destroy(ticks)` *scheduling* deferred deletion — a **post-2.0.76 change**, not functional at our pin. **[API, latest]**
- **This project uses
  [`game.delete_surface(platform.surface)`](https://lua-api.factorio.com/latest/classes/LuaGameScript.html#method_delete_surface)**
  for immediate, deterministic teardown of a platform and all its entities. Route all platform
  removal through `GameUtils.delete_platform` (`module/utils/game-utils.lua`); a lint guard
  (`npm run lint:lua`) blocks direct `*platform*.destroy()` calls.

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
  before crafter inputs, so `set_stack()` caps reflect the beacon-boosted speed. **[empirical]**

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
