# Gateway Transfer — Design and Current State

> The filename keeps its historical `_PRD` suffix so existing links stay valid. This is a facts-forward
> design + current-state reference (what the feature does now, the API behavior it rests on, and what is
> not yet built) — not a requirements/tracking document.

Players trigger a cross-instance space-platform transfer **from inside the game** by flying a platform to a
dedicated in-space **gateway**, instead of using the web UI. It reuses the existing transfer pipeline and is
a feature of this repo, not a separate project.

## Contents

- [Current state](#current-state)
- [How a gateway transfer runs](#how-a-gateway-transfer-runs)
- [The gateway mod](#the-gateway-mod)
- [Where each piece lives](#where-each-piece-lives)
- [Verified Factorio API behavior](#verified-factorio-api-behavior)
- [Passenger handling](#passenger-handling)
- [Planned work](#planned-work)
- [References](#references)

## Current state

| Piece | Home | What it does |
|---|---|---|
| **Gateway mod** (data-stage) | `docker/seed-data/mods-src/surfexp_gateways/` → built `docker/seed-data/mods/surfexp_gateways_0.1.0.zip` | 4 surfaceless gateway `space-location`s + `nauvis` connections; pure data, no control.lua |
| **Gateway logic** | [gateway.lua](../docker/seed-data/external_plugins/surface_export/module/core/gateway.lua) | discovery + per-force unlock, arrival detection, passenger evacuation, schedule hop-strip |
| **Commands** | `module/interfaces/commands/{gateway-transfer,gateway-gui}.lua` | `/gateway-transfer <index> <dest_id>`, `/gateway-gui <index>` |
| **On-arrival chooser GUI** | [gui/gateway-transfer.lua](../docker/seed-data/external_plugins/surface_export/module/interfaces/gui/gateway-transfer.lua) | opens for viewers when a platform parks at a gateway that has configured targets |
| **Web Gateways tab** | [GatewaysTab.tsx](../docker/seed-data/external_plugins/surface_export/web/GatewaysTab.tsx) + `GetGatewaysRequest` / `SetGatewayLinkRequest` in [messages.ts](../docker/seed-data/external_plugins/surface_export/messages.ts) | edit each gateway's destination links; controller is the source of truth; an empty target list disables the gateway |

A transfer triggered at a gateway runs the existing **two-phase commit** pipeline — the source platform is
deleted only after the destination validates. The destination is resolved either explicitly (the command
argument) or from the configured gateway links (the on-arrival chooser).

## How a gateway transfer runs

1. **Route** a platform to a `surfexp_gateway_*` (reached via a `space-connection` from `nauvis`, length
   3000). It reaches `waiting_at_station` (state 6) and **parks** — the gateway has no `fly_condition`, so it
   is not a fly-by.
2. **Trigger** (currently manual):
   - `/gateway-transfer <platform_index> <destination_instance_id>` — gates on `Gateway.parked_at_gateway`
     (refuses unless the platform is parked at a gateway); the destination is supplied explicitly. Or
   - the **on-arrival chooser GUI**, opened automatically for players viewing a platform that parks at a
     gateway with configured target links (`/gateway-gui <index>` opens it on demand).
3. **Transfer** via `TransferTrigger.start(force, index, dest_id, gateway_name)` → the existing pipeline:
   lock → export (`TRANSFER`, dest) → controller route → import on target → validate → delete source.
4. **On import**, the platform is placed at the target gateway (default: the same gateway name on the
   destination), arrives **paused**, and has the gateway hop stripped from its schedule
   (`Gateway.strip_gateway_records`) so it does not immediately fly back.
5. **Passengers** aboard, and any abandoned character bodies, are evacuated to Nauvis at the source-delete
   chokepoint (`Gateway.evacuate_passengers`, before `game.delete_surface`).

## The gateway mod

[surfexp_gateways](../docker/seed-data/mods-src/surfexp_gateways/) is a pure data-stage mod (no control.lua)
that ships **4** gateway `space-location` prototypes (`surfexp_gateway_1`..`4`), each modeled exactly on
vanilla `solar-system-edge`:

- **No `fly_condition`** → a routed platform reaches a stable `waiting_at_station` (it parks).
  `shattered-planet` sets `fly_condition = true` (the fly-by tell); the gateway omits it.
- **No `surface` / `map_gen`** → surfaceless (no surface is generated).
- **No `asteroid_spawn_definitions`** → an asteroid-free route.
- Each has a `space-connection` (`surfexp_gateway_link_i`) from `nauvis`, length 3000 — a short hop (vanilla
  nauvis→planet is 15000).

The mod ships **locked** (no unlock technology). The save-patched plugin unlocks each gateway per-force at
runtime (`Gateway.discover_and_unlock` → `force.unlock_space_location`). The plugin **no-ops** when a platform
parks at a gateway with no configured targets, so an unconfigured gateway is inert regardless of visibility.

## Where each piece lives

| Layer | Home | Responsibility |
|---|---|---|
| **Data-stage mod** | `mods-src/surfexp_gateways/` (built into `mods/`) | Prototypes only — gateway `space-location`s + `nauvis` connections + icon/locale. No control-stage code. |
| **Save-patched plugin** | `module/core/gateway.lua`, `module/interfaces/{commands,gui}/` | Discovery + per-force unlock, arrival detection (extends the `on_space_platform_changed_state` handler), the transfer trigger + chooser GUI, passenger evacuation, schedule hop-strip. |
| **Controller / web** | `controller.ts`, `web/GatewaysTab.tsx`, `messages.ts` | The Gateways config tab; controller is the source of truth; resolved links are pushed to instances. |

The split works because the save-patched module runs in the *same* Factorio game as the mod, so at runtime it
sees the mod's prototypes by name (`game.space_location_prototypes[...]`,
`platform.space_location.name == "surfexp_gateway_1"`). The mod stays pure data; all logic lives in the plugin.

## Verified Factorio API behavior

Load-bearing facts (verified empirically on the live cluster and on Factorio 2.0.76 — do not re-derive):

- A **surfaceless-but-parkable destination is a `space-location` prototype** (a `planet` would generate a
  surface). Vanilla precedent: `solar-system-edge`. A platform routed to a location with **no `fly_condition`**
  reaches `waiting_at_station` and parks; a fly-by location (`shattered-planet`, `fly_condition = true`) never
  parks. `fly_condition` and `hidden` are **data-stage only — not runtime-readable** on
  `LuaSpaceLocationPrototype`.
- **Prototypes are data-stage and cannot be created at runtime**, so a `space-location` / `space-connection`
  requires a mod in the mod pack. Clusterio save-patching is control-stage only.
- **`hidden` and `unlocked` are independent axes.** Reveal a gateway with
  `LuaForce.unlock_space_location(name)`; there is no runtime single-location **re-lock** API, so functional
  gating is plugin-side regardless of visibility.
- **Placement / schedule primitives:** `platform.space_location = "<name>"` (string; teleports/places, cancels
  pending item requests); `platform.get_schedule().go_to_station(index)` routes to a record; `platform.schedule`
  is a read-only plain-table copy while `get_schedule()` returns the live `LuaSchedule`. A gateway "station" is a
  schedule record whose `station` is the gateway's space-location name.
- **`defines.space_platform_state`:** paused = 7, waiting_at_station = 6, on_the_path = 2, no_schedule = 4,
  no_path = 5, waiting_for_departure = 3.
- **`on_space_platform_changed_state` fires** on the park transition. Its success path does **not** `log()` (it
  `send_json`s `surface_platform_state_changed`), so observe it via its `storage.platform_flight_data` side
  effect or the controller event — not `factorio-current.log`.
- `force.is_space_location_unlocked("<name>")` reports unlock state.

## Passenger handling

A transfer is **not** blocked when players are aboard. A platform passenger is hub-locked in remote view with
roughly no inventory (only equipped gear). Everyone aboard, and any abandoned character bodies, are
**evacuated to Nauvis** at the sole source-delete chokepoint (`delete_platform_for_transfer` →
`Gateway.evacuate_passengers`, run before `game.delete_surface`) — never orphaned, never duplicated (the
destination copy is already committed). Covered by `tests/integration/passenger-evacuate`; see the passenger
section of [CLAUDE.md](../CLAUDE.md).

## Planned work

- **Automation** — auto-trigger on arrival, or schedule-driven routing. Blocked on a Factorio limitation: an
  instance only knows its own space-locations, so vanilla schedule routing cannot target another server's
  destination. Likely needs plugin-injected schedule/interrupt logic or config-driven auto-transfer on arrival.
- **Follow-your-platform (Layer 2)** — carry the player with the platform to the destination via
  `LuaPlayer.connect_to_server` + `enter_space_platform` (no `inventory_sync`). Spike-gated on
  `host.public_address` client reachability; Layer 1 (evacuate to Nauvis) is the fallback.
- **Richer trigger conditions and policy** — the "conditions met" set beyond "parked at a gateway" (target
  instance online, no in-flight transfer for this platform, fuel/thrust state); who may trigger versus
  configure; `space-connection` length tuning; a re-lock workaround for a disabled gateway; per-force versus
  global unlock.

## References

- Factorio API: [`SpaceLocationPrototype`](https://lua-api.factorio.com/latest/prototypes/SpaceLocationPrototype.html),
  [`LuaForce.unlock_space_location`](https://lua-api.factorio.com/latest/classes/LuaForce.html#method_unlock_space_location),
  [`LuaSpacePlatform`](https://lua-api.factorio.com/latest/classes/LuaSpacePlatform.html),
  [`SpaceConnectionPrototype`](https://lua-api.factorio.com/latest/prototypes/SpaceConnectionPrototype.html).
- Clusterio prior art (same direction — offline/global config + web UI):
  [edge_transports](https://github.com/clusterio/edge_transports),
  [universal_edges](https://github.com/clusterio/universal_edges).
- This repo: [gateway.lua](../docker/seed-data/external_plugins/surface_export/module/core/gateway.lua),
  [control.lua](../docker/seed-data/external_plugins/surface_export/module/control.lua)
  (the `on_space_platform_changed_state` handler),
  [transfer-orchestrator.ts](../docker/seed-data/external_plugins/surface_export/lib/transfer-orchestrator.ts)
  (two-phase commit), and [factorio-2.0-api-notes.md](factorio-2.0-api-notes.md). Platform deletion uses
  `game.delete_surface` (Pitfall #19 in CLAUDE.md).
