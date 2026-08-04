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
- [Empirical foundations (2.1.11)](#empirical-foundations-2111)
- [Passenger handling](#passenger-handling)
- [Planned work](#planned-work)
- [References](#references)

## Current state

| Piece | Home | What it does |
|---|---|---|
| **Gateway mod** (data-stage) | `docker/seed-data/mods-src/surfexp_gateways/` → built `docker/seed-data/mods/surfexp_gateways_0.4.0.zip` | 4 surfaceless gateway `space-location`s + `nauvis` connections; pure data, no control.lua |
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

## Empirical foundations (2.1.11)

The feature was originally built on pre-pin evidence that was purged with the rest of the 2.0.x
documentation; these are the re-certification measurements from the 2026-08-03 headless spike. Each is
a one-line RCON `/sc` probe reproducible on the dev cluster (probe platforms swept after every run).
Per the api-notes charter, anything the [official docs](https://lua-api.factorio.com/2.1.11/) state is
linked, not restated — only unstated behavior gets a claim here.

- **Platform creation is STAGED: `create_space_platform` builds nothing** — no surface, no hub,
  `paused = false`, state `waiting_for_starter_pack`. **`apply_starter_pack()` creates the surface + hub
  AND pauses the platform** (upstream documents the apply, not the pause; the `paused` attribute doc
  states no initial value). Activation is a separate, explicit unpause.
  **[empirical, 2.1.11, staged create/apply probe 2026-08-03]**
- **A schedule-record edit targeting the platform's current location yields `waiting_at_station`
  WITHOUT travel, and the `on_space_platform_changed_state` arrival handler fires on that transition —
  and RE-FIRES on `go_to_station` re-selection of the same station.** A schedule-less platform reads
  `no_schedule`; the `space_location =` write itself is immediate (readable same execution). Upstream
  documents the pieces (the write, the states, the event), not this composition.
  **[empirical, 2.1.11, park/event probe 2026-08-03]**
- **`enter_space_platform` returns `false` for disconnected players** in every variant probed
  (controller types, paused and unpaused platforms) — upstream says only "if possible". The destination
  can never pre-seat an offline player; this is what forces the seat-on-join design below.
  **[empirical, 2.1.11, L2 headless probe 2026-08-03]**
- **`game.delete_surface` under an OFFLINE characterless player record RELOCATES the record to `nauvis`
  {0,0}, controller preserved — no crash, no dangling reference, and the engine accepts the delete with
  the record aboard** (upstream documents only entity deletion). Character bodies aboard are DESTROYED
  with the surface — that half IS upstream-documented ("all entities on it") and is the measured reason
  evacuation-before-delete is the only thing protecting a passenger's body and gear; the engine protects
  only the record. **[empirical, 2.1.11, delete-under-record probe 2026-08-03 — record restored
  byte-exact afterward]**

### Known defect — the park write cancels restored item-request proxies

Writing `space_location` destroys item-request proxies on the platform surface (measured 1 → 0 on
2.1.11; the upstream-documented "will cancel pending item requests" is literal). The import's gateway
park performs exactly that write as the LAST import step — after restoration re-creates proxies and
after the exact gate has already issued its verdict. A gateway-parked import of a proxy-carrying
platform therefore silently loses its proxies, post-verdict; detection is latent by construction (the
gate cannot see past its own verdict, and no standing test transfers a proxy-carrying platform with
gateway park requested). **Planned fix: park BEFORE restoration** — a paused, empty, freshly-created
platform accepts the `space_location` write and lands at the gateway (measured), so parking first
leaves nothing to cancel — shipped with an adversarial fixture (gateway-parked transfer of a
proxy-carrying platform, physical proxy count on the destination, RED on pre-fix code).

## Passenger handling

A transfer is **not** blocked when players are aboard. A platform passenger is hub-locked in remote view with
roughly no inventory (only equipped gear). Everyone aboard, and any abandoned character bodies, are
**evacuated to Nauvis** at the sole source-delete chokepoint (`delete_platform_for_transfer` →
`Gateway.evacuate_passengers`, run before `game.delete_surface`) — never orphaned, never duplicated (the
destination copy is already committed). The `passenger-evacuate` runner was retired 2026-07-27 in the
one-test-save consolidation and the evacuation branch has no standing test today; see the passenger
section of [CLAUDE.md](../CLAUDE.md).

## Planned work

- **Automation** — auto-trigger on arrival, or schedule-driven routing. Blocked on a Factorio limitation: an
  instance only knows its own space-locations, so vanilla schedule routing cannot target another server's
  destination. Likely needs plugin-injected schedule/interrupt logic or config-driven auto-transfer on arrival.
- **Follow-your-platform (Layer 2)** — carry the player with the platform to the destination via
  `LuaPlayer.connect_to_server` + `LuaPlayer.enter_space_platform` (no `inventory_sync`). The headless
  half of the re-scope ran 2026-08-03 (see [Empirical foundations](#empirical-foundations-2111));
  the client half is scripted in [l2-client-session-script.md](l2-client-session-script.md) and awaits
  an owner session at a real game client. **Owner design ruling 2026-08-03 — seat-on-join, one shot,
  native fallback**: the destination records a pending-seat intent at import go-live (player name +
  the destination platform identity resolved at completion — never the source index, never a join-time
  name lookup); an on-join hook makes ONE seat attempt; if the platform is gone the intent is dropped
  and the game's native spawn places the player — no recovery flow. The failure mode degrades to
  Layer 1's outcome for free (native spawn is where evacuation sends people), and the raw-engine
  fallback on the source side is measured safe (record relocation, above). What IS proven on 2.1.11 is
  the `/teleport` GUI (admins + the `Teleport` permission group), which fires `connect_to_server`
  without carrying the platform. Layer 1 (evacuate to Nauvis) remains the fallback for every Layer-2
  abort.
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
  (two-phase commit), and [factorio-2.0-api-notes.md](factorio-2.0-api-notes.md). Platform deletion goes
  through `GameUtils.delete_platform`, whose comment carries the measurement for why it uses
  `game.delete_surface` rather than the platform's own destroy method — read it there rather than
  trusting a second copy here.
