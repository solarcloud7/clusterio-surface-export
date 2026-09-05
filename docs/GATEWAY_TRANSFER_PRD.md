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
| **Web Gateways tab** | [GatewayCanvas.tsx](../docker/seed-data/external_plugins/surface_export/web/gateway/GatewayCanvas.tsx) + `GetGatewaysRequest` / `SetGatewayLinkRequest` in [messages.ts](../docker/seed-data/external_plugins/surface_export/messages.ts) | edit each gateway's destination links; controller is the source of truth; an empty target list disables the gateway |

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
| **Controller / web** | `controller.ts`, `web/gateway/GatewayCanvas.tsx`, `messages.ts` | The Gateways canvas tab; controller is the source of truth; resolved links are pushed to instances. |

The split works because the save-patched module runs in the *same* Factorio game as the mod, so at runtime it
sees the mod's prototypes by name (`game.space_location_prototypes[...]`,
`platform.space_location.name == "surfexp_gateway_1"`). The mod stays pure data; all logic lives in the plugin.

## Empirical foundations (2.1.11)

The feature was originally built on pre-pin evidence that was purged with the rest of the 2.0.x
documentation; these are the re-certification measurements from the 2026-08-03 headless spike. Each is
a one-line RCON `/sc` probe reproducible on the dev cluster (probe platforms swept after every run).
Per the evidence discipline in [CLAUDE.md](../CLAUDE.md), anything the
[official docs](https://lua-api.factorio.com/2.1.11/) state is linked, not restated — only unstated
behavior gets a claim here.

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

### The park write and item-request proxies (2026-08-04 — two retractions, one ordering change)

Upstream documents that writing `space_location` "will cancel pending item requests." What that
cancellation actually touches, we could not pin down — and two of our own measurements along the
way turned out to be artifacts, recorded here so they cannot be re-derived:

- **RETRACTED: "the write destroys hub-targeted item-request proxies (1 → 0)."** Observed once
  (2026-08-03) and never reproduced: six survivals since, across valid and malformed proxy
  shapes, same-execution and deferred writes, and BOTH park orderings through full production
  gateway transfers. Unexplained, not fixed — the git history keeps the original observation.
- **RETRACTED: "hub-targeted proxies never ride the export."** An artifact of a malformed probe:
  insert-plan stacks are 1-based, and a `stack=0` plan creates a proxy that sits on the surface
  but exports nothing. A well-formed hub-targeted proxy **rides, restores against the remapped
  destination hub, and survives arrival** — measured end-to-end under both orderings.

What is actually true, measured: **both proxy-target shapes (entity- and hub-targeted) transfer
losslessly through gateway parks, under either ordering.** The park write was still moved from
the LAST import step to platform **creation** (import-pipeline.lua) on the categorical argument:
the write is documented-destructive with a scope we could not determine, and running it after the
verdict grants it restored, verdict-passed state to act on for no benefit — at creation the
surface carries nothing but the hub. Behavior-neutral by measurement; cheap by construction.

Standing pin: `tests/integration/gateway-park-proxies` — a real gateway transfer carrying BOTH
proxy shapes, terminal-2PC readiness (destination present AND source deleted), the destination's
own `debug_import_result` verdict read before any census claim, and physical per-shape proxy
counts (the exact gate is structurally blind to proxies, so the count is physical by design).
The completion-side verify also rides the result as non-gating `gatewayParked`.

### The client half (2026-08-06 — seat-on-join is a GO)

The headless spike above could not answer anything requiring a real game client. These are from the
owner-at-the-keyboard session against host-1/host-2 on the dev cluster. Upstream documents the
signatures and the hub-repositioning; only unstated behavior is claimed here.

- **`enter_space_platform` returns `true` for a CONNECTED player**, sets the controller to
  `remote` (7) from `character` (1), and moves BOTH the view and the character's
  `physical_surface` onto the platform. The 2026-08-03 headless `false` is specific to
  *disconnected* players; connected is the other half of that pair.
  **[empirical, 2.1.11, L2 client session 2026-08-06]**
- **A PAUSED platform does not refuse the seat** — same `true`, same resulting state, measured from a
  genuinely off-platform start. This is the join-during-import cell, since a platform is paused for
  the duration of its import. **[empirical, 2.1.11, L2 client session 2026-08-06]**
- **`leave_space_platform`'s effect is NOT visible within the calling `/sc` execution** — the
  controller still reads `remote` immediately after the call and transitions to `character` later.
  What it waits on was not isolated. Upstream documents the hub repositioning itself, which is not
  restated. Practical consequence: any probe that reads state synchronously after this call will
  conclude, wrongly, that it did nothing. **[empirical, 2.1.11, L2 client session 2026-08-06]**
- **A character standing at the hub's own position is clipped inside the hub's collision box** and
  cannot walk out. Reachable by any un-seat path that drops a player at the hub coordinate; use
  `find_non_colliding_position` instead. **[empirical, 2.1.11, L2 client session 2026-08-06]**
- **`connect_to_server` costs 0 ticks server-side, and its dialog reaches a connected player who is
  seated on a platform.** Accepting completes the cross-server jump.
  **[empirical, 2.1.11, L2 client session 2026-08-06]**
- **An arriving player lands on the destination's `nauvis` at {0,0} in `character` controller with a
  character — never on a platform**, even when the destination holds none. This is the ordering
  constraint on the design: the seat cannot fire at join time for a platform that has not landed
  yet, so it must be a pending intent resolved on platform arrival.
  **[empirical, 2.1.11, L2 client session 2026-08-06]**

**The full flow was measured end to end**, on a real 1359-entity platform (a clone of
`lab-transfer-fixture-v1`) transferred host-1 → host-2 with the player connected throughout:
prompt → player accepts → jumps to host-2 → transfer runs on host-1 → platform arrives on host-2,
**ZERO item loss (31305/31305) and ZERO fluid loss (149636.8/149636.8)**, source deleted. The player
watched the arrival from the destination and was never disconnected; client latency moved
(14 → 13 → 3, then 16 → 15 → 2) without breaking.
**[empirical, 2.1.11, L2 client session 2026-08-06]**

**GO for seat-on-join.** Q1 and Q2 of [l2-client-session-script.md](l2-client-session-script.md) both
pass. Note the ordering the measurement suggests — prompt at trigger time, player jumps, *then* the
export stall happens on a server they have already left — which may remove the need for the prompt to
survive a stall at all.

### Stall tolerance (same session, controlled stall)

The stall was generated deliberately rather than by a clone, so its duration is a set value rather
than an inference: a busy loop in one `/sc` execution, calibrated at ~2.14e8 iterations/second
against a measured 2.01 s RCON baseline. This blocks the main thread by construction.

- **A 7.43 s main-thread block does NOT disconnect a connected client.** Client latency climbed
  `3 → 30 → 32 → 149 → 254` and the connection held; no `WaitingForUserToSaveOrQuitAfterServerLeft`
  on either side. **[empirical, 2.1.11, controlled-stall probe 2026-08-06]**
- **A `connect_to_server` dialog created in the SAME tick the server blocks for 7.43 s reaches the
  client, survives the freeze, and remains actionable** — the owner accepted it afterward and the
  jump completed via the ordinary `WaitingForDisconnectConfirmation` path, not a drop. This closes
  the stall-race cell of Q2. **[empirical, 2.1.11, controlled-stall probe 2026-08-06]**

Consequence for the design: the prompt does **not** need to be moved pre-transfer to survive the
export stall. Both orderings are now measured safe.

**Not established, deliberately left open:**
- **Q3's manual seat-on-arrival and Q4's native fallback** were not run.
- **One client disconnect has no established cause, and the obvious explanation is now the least
  likely.** During an unrelated 1359-entity clone the client declared
  `WaitingForUserToSaveOrQuitAfterServerLeft` with the client 38 ticks (~0.63 s) behind, the server
  measuring 55.3 TPS over 10.19 s (~0.8 s of lost ticks), and the clone self-reporting 0.5 s. Those
  three numbers agree with each other, which is what made "the stall dropped the client" attractive
  — but the controlled probe above held a client through a stall **9x longer**. So a sub-second
  stall is not a sufficient cause, and the mechanism is unknown rather than merely unproven.
  Recorded as a measurement, not a finding. See [/client-logs](../.claude/skills/client-logs/SKILL.md)
  for why the server-side instruments cannot settle it: RCON and the instance log both ride the
  Factorio main thread, so their silence during a stall is the symptom, not evidence of its absence.

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
  (two-phase commit). Platform deletion goes through `GameUtils.delete_platform`, which uses
  `game.delete_surface` rather than the platform's own destroy method;
  [tests/instruments/engine-invariants](../tests/instruments/engine-invariants/run-tests.ps1) is what
  re-measures both halves of that choice against a live cluster.
