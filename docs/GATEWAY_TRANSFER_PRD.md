# In-Game Gateway Transfer — Product Requirements (PRD)

**Status:** Phase 1a CORE MECHANIC IMPLEMENTED (2026-06-28) — explicit `/gateway-transfer` command works
end-to-end (park at gateway → transfer → arrive paused at the gateway, hop stripped, full fidelity). Next:
Phase 1b (on-arrival GUI + conditions + passenger hard-block), Phase 1c (web Gateways config tab).
**Date:** 2026-06-19 (Phase 0 results added 2026-06-28; Phase 1a status 2026-06-28)
**Owner:** Solar
**Component:** `clusterio-surface-export`

> This is a living design snapshot captured during a requirements interview. Sections 1–8 are
> decided; Section 10 lists what is still open. Update this file as decisions land.
>
> ✅ **Phase 0 PASSED — building is unblocked.** The core mechanic was validated empirically on the live
> cluster with vanilla `solar-system-edge` (zero mod-building): a platform routed there reaches a **stable
> `waiting_at_station`** (it PARKS — not a fly-by) and the existing `on_space_platform_changed_state`
> handler **fires** (proven via its `storage.platform_flight_data` side effect). Full results + the API
> facts discovered are in §6. Proceed to Phase 1.

---

## 1. Summary / Goal

Let players trigger a cross-instance space-platform transfer **from inside the game** by flying the
platform to a dedicated in-space **gateway**, instead of only via the web UI. The experience is
diegetic — "fly your ship to a place, and it crosses to the other server." This is a feature *of this
repo*, reusing the existing transfer pipeline; it is not a separate project.

**Non-goal (for now):** fully automated, schedule-driven cross-server routing (see Phase 2 / open
questions — it is blocked on a real Factorio limitation).

---

## 2. Background — what exists today

- **The transfer machinery is fully built and keys off a single value: a numeric
  `destination_instance_id`.** `/transfer-platform <index> <dest_id>` → lock platform →
  `AsyncProcessor.queue_export(index, force, "TRANSFER", dest_id)` →
  `clusterio_api.send_json("surface_transfer_request", {…, destination_instance_id})`. The controller's
  `TransferOrchestrator` then runs **export → transmit → import → validate → delete-source**, a
  **two-phase commit** (source platform is deleted only after the destination validates).
- **The in-game trigger hook already exists.** `module/control.lua` handles
  `on_space_platform_changed_state`; it already reads the schedule destination
  (`schedule.records[schedule.current].station`) and sends a `send_json` telemetry event. **Today it
  does not initiate a transfer** — that is the gap this feature closes.
- **The plugin is a save-patched Clusterio plugin (control-stage Lua only).** It cannot define Factorio
  prototypes.
- **There is no first-party data-stage mod yet.** `docker/seed-data/mods/` contains only third-party
  mods (FluidMustFlow, maraxsis, Spidertron×2).

So the feature reduces to three new bolts: **(a)** a place to fly to, **(b)** map that place → an
instance id, **(c)** call the transfer that already exists.

---

## 3. Key research findings (load-bearing — do not re-derive)

### Factorio 2.0 Space Age API
- **A surfaceless-but-parkable destination is a `space-location` prototype** (as opposed to a `planet`,
  which generates a surface). Vanilla precedent: **"Solar system edge"** — reachable, platforms park
  there with normal wait conditions. The **"Shattered planet"** is the *other* kind: 4,000,000 km out,
  "not intended to be reached," so selecting it converts the wait condition into a **"fly condition"**
  (triggers en-route, never parks). → **Our gateway must be modeled on Solar System Edge (reachable)**
  so the platform truly enters `waiting_at_station` and the existing handler fires. **Likely explicit
  lever:** `LuaSpaceLocationPrototype.fly_condition` (exists in the API) — set it false for a parkable
  gateway, rather than tuning `space-connection.length` to avoid shattered-planet behavior. *Verify in
  Phase 0.*
- **Prototypes are data-stage and cannot be created at runtime.** Adding a `space-location` /
  `space-connection` requires a **mod in the mod pack**. Clusterio save-patching is control-stage only
  ("Mods on the other hand work without modifications"); the instance mods folder is driven entirely by
  the mod pack (`Instance.syncMods`).
- **`space-connection`** = `from` / `to` (SpaceLocationID) + `length` (km, can't be 0). One connection
  from an existing planet → the gateway is what makes it appear in the hub's "add station" picker.
- **Hidden-until-configured is supported — but `hidden` and `unlocked` are INDEPENDENT axes, do not
  conflate them.** `SpaceLocationPrototype.hidden` (bool) "Hides the space location from the planet
  selection lists and the space map" — this is likely *unconditional*, i.e. an unlocked-but-`hidden`
  location probably still won't appear in the schedule picker, which would defeat reveal-by-config.
  **Working hypothesis (verify in Phase 0): ship gateways `hidden = false` but LOCKED (simply never
  auto-unlocked), and reveal a configured gateway with runtime
  `LuaForce.unlock_space_location(name)`** ("Unlocks the planet to be accessible to this force"). *No
  runtime single-location re-lock was found* → functional gating must be plugin-side regardless of
  visibility (the plugin no-ops on docking at an unconfigured gateway no matter what).
- **Runtime placement / identity primitives:** `platform.space_location = <loc>` (teleports; cancels
  pending item requests), `platform.space_connection = <conn>` (sets distance to 0.5). Lua reads its own
  instance id via `remote.call("clusterio_api", "get_instance_id")`. Player primitives:
  built-in **"Passenger present / not present"** wait condition; `LuaPlayer.land_on_planet` (ejects a
  player from the platform onto the current planet).

### Clusterio prior art — `edge_transports` → `universal_edges`
- An **"edge" link** is configured as `{ id, origin[x,y], surface, direction, length, target_instance,
  target_edge }`. → This is exactly our gateway shape: a place that maps to a **target instance** *and*
  a **corresponding place on the far side** (`target_edge`).
- **Config is offline / applied at startup** (`edge_transports.internal` per-instance). The successor
  **`universal_edges` moved edge config to a web interface** on a **global (controller) config system**.
  → Validates our "offline config + web dashboard, controller = source of truth" plan; it is the same
  direction Clusterio itself went.
- **Player/passenger-in-vehicle handling is NOT solved or documented** in either plugin (universal_edges
  even lists "train fuel and schedules go missing" as open bugs). → There is no blueprint to copy; we
  engineer the player hazard ourselves.

**Sources:** lua-api.factorio.com (`SpaceLocationPrototype`, `LuaForce.unlock_space_location`,
`LuaSpacePlatform`, `SpaceConnectionPrototype`); Factorio wiki (Space platform, Shattered planet);
Clusterio `docs/how-it-works.md` + `Instance.syncMods`; GitHub `clusterio/edge_transports`,
`clusterio/universal_edges`.

---

## 4. Architecture (where each piece lives in this repo)

| Layer | Home | Responsibility |
|---|---|---|
| **Data-stage mod** (new) | `docker/seed-data/mods/<surfexp_gateways>/`, added to the mod pack | **Prototypes only** — N gateway `space-location`s (Solar-System-Edge style, reachable — `fly_condition = false`; shipped **locked but not `hidden`**, never auto-unlocked — pending Phase 0), `space-connection`(s) wiring each gateway to an existing planet, icon, locale. Discoverable by naming convention `surfexp_gateway_*`. **No control-stage code.** |
| **Save-patched plugin** (existing) | `module/` | Gateway discovery (scan `prototypes.space_location` by prefix); per-force `unlock_space_location` of configured gateways at startup; arrival detection (extend the existing `on_space_platform_changed_state` handler); Phase-1 transfer GUI/button + "conditions met" checks; call into the existing `surface_transfer_request` flow. |
| **Controller / web UI** (existing) | `controller.ts`, `web/` | New **"Gateways" tab** to configure links; controller is source of truth; config applied offline/at startup. |

**Why the split works:** the save-patched module runs in the *same* Factorio game as the mod, so at
runtime the plugin can see the mod's prototype by name (`game.space_location_prototypes[...]`,
`platform.space_location.name == "surfexp_gateway_1"`). The mod can be pure data; all logic stays in the
plugin we already develop.

---

## 5. Topology & configuration model

- **N gateways supported (optional).** Runtime treats gateways as a **set** and never assumes a
  singleton. Ship **4 prototypes**, **1 enabled by default**.
- **Gateway ↔ instance = many-to-many**, **default 1:1**.
- A **gateway-link** = **`{ target_instance, target_gateway }`** (mirrors edge `target_instance` +
  `target_edge`). Default 1:1 means `surfexp_gateway_1@A ↔ surfexp_gateway_1@B`.
- **Config is offline** (applied at instance startup, like other Clusterio settings) and edited via the
  **web dashboard** (controller-global). Changing it requires the standard restart/sync, not a live
  hot-reconfigure.
- **Provisioning reality:** the *number of physical gateway places* is fixed at mod-build (data-stage).
  The dashboard maps / enables / names / routes the existing pool; adding a brand-new place = add one
  templated prototype + rebuild the mod (the only data-stage step).

---

## 6. Phasing

- **Phase 0 ✅ PASSED (2026-06-28) — core mechanic validated empirically.** On the live cluster, no
  mod-building, no GUI, using vanilla `solar-system-edge` (already unlocked for the player force). A long
  *natural* flight was avoided by teleporting a **clone** of `test` (the `test` fixture was untouched).
  **RESULTS (empirical facts — do not re-derive):**
  - ✅ **PARKS, not fly-by.** A platform whose schedule targets `solar-system-edge` (a schedule record with
    `station="solar-system-edge"` + a wait condition) reaches **`waiting_at_station` (state=6)** and stays
    there for the wait duration (confirmed STABLE ≥8s, speed≈0; then departed exactly when the 30s `time`
    wait elapsed). A fly-by location (shattered-planet style) never reaches `waiting_at_station`. → our
    gateway, modeled on solar-system-edge, will park.
  - ✅ **The handler FIRES.** `on_space_platform_changed_state` ran on the platform's state changes — proven
    via its side effect `storage.platform_flight_data[name] = {departure_tick=…}` (written ONLY by that
    handler). NOTE: the success path does NOT `log()` (it `send_json`s `surface_platform_state_changed`), so
    detect it via the side effect or the controller event — not `factorio-current.log`.
  - ✅ **API for Phase 1 (verified on 2.0.76):**
    - `platform.space_location = "solar-system-edge"` (STRING name) teleports/places the platform. → use
      this for §7.4 "place the imported platform at the target gateway."
    - `platform.get_schedule().go_to_station(index)` routes to a schedule record (sets `current`). Records are
      `{station="<space-location-name>", wait_conditions={…}, allows_unloading, temporary, created_by_interrupt}`.
      → a gateway "station" is just a schedule record whose `station` is the gateway's space-location name.
    - `platform.schedule` returns a plain-table COPY (read-only view); `platform.get_schedule()` returns the
      live `LuaSchedule` (write). `defines.space_platform_state`: paused=7, waiting_at_station=6, on_the_path=2,
      no_schedule=4, no_path=5, waiting_for_departure=3.
    - `force.is_space_location_unlocked("solar-system-edge")` → true (already unlocked); `unlock_space_location`
      is the reveal lever (§3 plan holds).
  - ⚠️ **`fly_condition` / `hidden` are NOT runtime-readable** on `LuaSpaceLocationPrototype` (returned n/a) —
    they are data-stage prototype settings we set when BUILDING the gateway mod (model on solar-system-edge,
    which parks). The `hidden`-vs-picker behaviour can only be confirmed once the mod ships a gateway
    prototype; NOT a blocker — functional gating is plugin-side regardless (§8).
  - 📝 **Topology note:** `solar-system-edge` is reached only via `aquilo↔solar-system-edge` (length 100000),
    several hops from nauvis → a *natural* flight is long. The gateway mod should add a shorter
    `space-connection` from a convenient planet so players can actually fly to the gateway.
  **Exit criteria MET → Phase 1 is real. Proceed.**

  Original procedure (for reference): (1) `/sc for n,_ in pairs(prototypes.space_location) do rcon.print(n) end`;
  (2) `unlock_space_location("solar-system-edge")`; (3) route a clone there (schedule `go_to_station` +
  `space_location=`); (4) poll `{state, space_location.name}` + check `storage.platform_flight_data`.
- **Phase 1 (priority) — manual, explicit.** Fly to a gateway → platform parks
  (`waiting_at_station`) → plugin shows a **custom GUI / button** → on press, **if conditions are met**,
  run the transfer. No accidental triggers. Destination comes from the gateway-link config (an in-GUI
  selector appears only when a gateway is configured with multiple targets).
- **Phase 2 (deferred — research item) — automation.** Auto-trigger on arrival / via schedule logic.
  **Blocked on:** *worlds can't see each other's "stops"* — an instance only knows its own
  space-locations, so vanilla schedule routing can't target another server's destination. Likely needs
  plugin-injected schedule/interrupt logic or config-driven auto-transfer on arrival. Explicitly **not**
  in Phase 1.

---

## 7. Transfer flow (reuses the existing pipeline)

1. Platform parks at a gateway. **Phase 1:** player presses the transfer button; conditions met.
2. Plugin resolves gateway-link → `destination_instance_id` (+ `target_gateway`).
3. Existing pipeline: **lock → export(`TRANSFER`, dest) → controller route → import on target →
   validate → delete source only on validated success** (two-phase commit, already implemented in
   `TransferOrchestrator`).
4. On import, **place the platform at `target_gateway`** (paused) and **strip the gateway hop from its
   schedule** so it does not immediately bounce back.

---

## 8. Hazards & handling

- **Schedule loop.** The arriving platform retains a schedule that still names the gateway → it could
  fly straight back. **Fix:** on import, strip/rewrite the gateway hop and arrive paused.
- **Player aboard.** ⚠️ **The two-phase commit protects platform *data*, not a player *session*.** A
  player locked in the hub is a live session bound to instance A's *server process* — it cannot be
  carried to instance B's process by the data export/import at all. These are two different problems;
  do not let the validation-commit language imply the player is handled. **Phase 1 policy: hard-block
  the transfer while a passenger is present** (built-in "Passenger present" detection), *or* eject to
  the planet first (`LuaPlayer.land_on_planet`). Simple, safe, no cross-process handoff.
  - **Future (separate problem, NOT Phase 1): live cross-server player handoff.** Would require
    serializing the player's character/inventory, recreating it on the destination, and redirecting the
    client's connection — the same unsolved area `universal_edges` punts on. Sketch to revisit:
    serialize → recreate on B at the arrived platform → **fallback** to Nauvis's first cargo landing pad,
    else `0,0`, if recreation fails. Out of scope until Phase 1 ships.
- **Disabled / unconfigured gateway.** The plugin **no-ops** when a platform docks at an unconfigured
  gateway, regardless of whether the location is visible — this is the real safety guarantee
  (independent of the `unlock`/re-lock visibility layer).

---

## 9. Decisions log

- ✅ Diegetic "fly to a gateway" model; dedicated **surfaceless `space-location`** (reachable, Solar-
  System-Edge style). No piggybacking an existing planet. No shortcuts.
- ✅ Delivered as a new **data-stage mod (prototypes)** + the existing **save-patched plugin (logic/GUI)**
  — one feature of this repo.
- ✅ **N gateways**, optional; runtime treats them as a **set**. Ship 4, default 1 enabled.
- ✅ **Gateway ↔ instance many-to-many, default 1:1**; link = `{ target_instance, target_gateway }`;
  imported platform **arrives at the target gateway**, paused, hop stripped.
- ✅ **Reveal-when-configured** via `unlock_space_location` (ship **locked, not `hidden`** — pending
  Phase 0 confirmation of the `hidden`-vs-`unlocked` behavior); functional gating is plugin-side regardless.
- ✅ Config is **offline + web-dashboard-driven** (controller = source of truth), mirroring
  `edge_transports`/`universal_edges`.
- ✅ **Phase 1 = manual GUI button at the gateway**; **Phase 2 = automation** (deferred, blocked on
  cross-instance stop visibility).
- ✅ Hazards: schedule-loop fixed by **hop-strip on import**; data integrity by the existing **two-phase
  commit**; **Phase 1 hard-blocks transfer while a passenger is present** (live cross-server player
  handoff is a separate, out-of-scope future problem — §8).
- ✅ **Phase 0 empirical validation gates all build work** (§6) — the park-and-fire mechanic is verified
  on the live cluster with vanilla `solar-system-edge` before any mod/GUI/dashboard is written.

---

## 10. Open questions / TODO (not yet decided)

> Empirical unknowns — park-vs-flyby / `fly_condition`, `hidden`-vs-`unlocked`, whether the handler
> fires — are resolved by **Phase 0 (§6)**, not here. The items below are genuine design choices.

- **"Conditions met" set** for the Phase-1 transfer button (docked at gateway; target instance online;
  no in-flight transfer for this platform; passenger policy; thrust/fuel state; …).
- **Permissions:** who may *trigger* a transfer (any player on the force? admin only?) vs who may
  *configure* gateways (admin).
- **Connection topology:** which planet(s) connect to each gateway, and the `space-connection.length`
  (travel time vs asteroid danger trade-off).
- **GUI surface:** auto-popup on dock vs a button on the hub GUI vs a shortcut/hotkey.
- **Re-lock workaround** if a gateway is disabled after having been unlocked (no single-location
  runtime re-lock API).
- **Phase-2 automation mechanism** (cross-instance stop visibility) — research.
- **Per-force vs global unlock**, and how the single default-enabled gateway is chosen on a fresh
  cluster (config default vs a first-instance convention).
- **Prototype pool details:** ship exactly 4? naming/display conventions; per-force vs global unlock.

---

## 11. References

- Factorio API: [`SpaceLocationPrototype`](https://lua-api.factorio.com/latest/prototypes/SpaceLocationPrototype.html),
  [`LuaForce.unlock_space_location`](https://lua-api.factorio.com/latest/classes/LuaForce.html#method_unlock_space_location),
  [`LuaSpacePlatform`](https://lua-api.factorio.com/latest/classes/LuaSpacePlatform.html),
  [`SpaceConnectionPrototype`](https://lua-api.factorio.com/latest/prototypes/SpaceConnectionPrototype.html)
- Factorio wiki: [Space platform](https://wiki.factorio.com/Space_platform), [Shattered planet](https://wiki.factorio.com/Shattered_planet)
- Clusterio prior art: [edge_transports](https://github.com/clusterio/edge_transports), [universal_edges](https://github.com/clusterio/universal_edges)
- This repo: `module/control.lua` (existing `on_space_platform_changed_state` handler),
  `lib/transfer-orchestrator.ts` (two-phase commit), `module/interfaces/commands/transfer-platform.lua`
  (existing transfer entry point), `CLAUDE.md` (Pitfall #19 platform deletion, Pitfall #12 clusterio API path).
