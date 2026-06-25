# Factorio 2.0 (Space Age) API & Simulation Notes

Durable Factorio 2.0 API facts this plugin depends on. Each entry is marked **[API]**
(verified against [lua-api.factorio.com](https://lua-api.factorio.com/latest/)) or
**[empirical]** (observed via RCON testing in this project; not stated in the docs). A version
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
- [Space platform deletion](#space-platform-deletion)
- [LuaProfiler and LocalisedString](#luaprofiler-and-localisedstring)
- [Read-only entity properties](#read-only-entity-properties)

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
- **`get_capacity(i)`** is the segment capacity. **[API]** Empirically it returns the **full segment**
  capacity for pipes/tanks but only the **local** buffer capacity for machines/thrusters, because
  pipe prototypes define `base_area` (drives segment capacity) while machines define fixed local
  `fluid_box` buffers. When injecting, pick the entity with the **highest** `get_capacity()` (a
  pipe/tank) as the target. **[empirical]**

## Fluid injection on import

- **Inject fluid only after `entity.active = true` and `entity.frozen = false`.** A frozen/inactive
  entity is detached from its segment; writing `entity.fluidbox[i] = {...}` lands in a temporary
  ghost buffer that is wiped when the entity rejoins a live segment on unfreeze. **[empirical]**
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

- **Many entity properties became read-only in 2.0** (e.g. quality, computed bonuses like
  `productivity_bonus`, which aggregates force + beacon/module bonuses). Set them during
  `create_entity`, not after, and wrap optional writes in `pcall`. **[empirical]**
- **`crafting_speed` updates instantly** when a nearby beacon's `beacon_modules` inventory is
  populated — no tick delay, no power needed. This is why import restores beacon module inventories
  before crafter inputs, so `set_stack()` caps reflect the beacon-boosted speed. **[empirical]**
