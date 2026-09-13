# Gateways

Gateways connect Factorio Space Age platform travel to Clusterio transfers. The
[gateway mod](../docker/seed-data/mods-src/surfexp_gateways/data.lua) defines space
locations and routes. The save-patched [gateway module](../docker/seed-data/external_plugins/surface_export/module/core/gateway.lua)
handles discovery, arrival checks, schedules, and passenger evacuation.

## Layout

The default `surfexp-gateway-layout` startup setting is `one_gate`: one visible
`surfexp_gateway_hub` with routes from Nauvis, Vulcanus, Gleba, Fulgora, and Aquilo.
The four legacy locations remain hidden and their routes are not generated.
The alternative `multi` setting exposes four directional locations and their
Nauvis routes. The controller's `surface_export.gateway_mode` must match the mod
setting. The plugin Settings tab does not expose a layout selector.

These are surfaceless space locations. Platform surfaces are created by Factorio;
the gateway itself does not create another planetary surface.

## In-game transfer

1. Route a platform to a configured gateway. `Gateway.parked_at_gateway` requires
   `waiting_at_station` and a gateway space location.
2. Choose a destination in the arrival GUI, or run
   `/gateway-transfer <platform_index> <destination_instance_id>`.
   `/gateway-gui <platform_index>` opens the chooser on demand.
3. The request uses the normal [transfer handoff](TRANSFER_2PC.md): validate and
   hold the destination, acknowledge source deletion, then release the destination.
4. Gateway arrival handling removes gateway stops from the imported schedule and
   parks the imported platform at its resolved destination location.

[TransferTrigger](../docker/seed-data/external_plugins/surface_export/module/core/transfer-trigger.lua)
checks the platform and begins the export. Gateway targets come from controller
configuration pushed to each instance; editing a canvas position does not change them.

## Passenger handling

Before source deletion, `Gateway.evacuate_passengers` attempts to move passengers
and abandoned character bodies to Nauvis, with another non-platform surface as a
fallback. Passenger travel to the other instance is not part of a platform transfer.
The separate [teleport GUI](../docker/seed-data/external_plugins/surface_export/module/interfaces/gui/teleport-gui.lua)
uses Factorio's native server connection prompt.

Source deletion requires confirmed evacuation:
[delete_platform_for_transfer](../docker/seed-data/external_plugins/surface_export/module/interfaces/remote/delete-platform-for-transfer.lua)
refuses deletion when a teleport fails, a passenger read fails, or passengers
remain aboard. An occupied platform without a fallback surface is also retained.
The source stays locked, no deletion receipt is recorded, and the validated
destination remains held until recovery confirms source deletion. Retrying after
evacuation succeeds uses the same transfer identity.

Failed-destination cleanup also requires confirmed evacuation. Failure retains the
destination and reports cleanup failure. A repeated held-destination discard checks
evacuation again before deleting the platform or clearing its hold.
If quarantine preparation fails, the interrupted import retains its exact platform
references and failure result. Result pruning preserves records owned by retained
jobs; confirmed cleanup can retire the matching interrupted job.

## Web canvas

[GatewayCanvas](../docker/seed-data/external_plugins/surface_export/web/gateway/GatewayCanvas.tsx)
renders instances, platforms, configured links, and transfer motion using React Flow.
The host, instance, and platform selectors filter or locate nodes. Layout reset
clears saved positions and frames the instances.

- Positions and edge style are stored in browser local storage by
  [layout-store](../docker/seed-data/external_plugins/surface_export/web/gateway/layout-store.ts).
- Connection changes are staged until **Save**. Saving sends gateway target lists
  to the controller; bidirectional connections update both endpoints. Partial
  failures are reported and are not a cluster-wide atomic configuration change.
- Editing requires `surface_export.exports.transfer`. The canvas also has a local
  interaction lock. See [permission definitions](../docker/seed-data/external_plugins/surface_export/index.ts).
- The transfer dialog submits the operation and closes. The route animation and
  Transaction Logs show progress; errors use toast messages.
- The debug panel includes motion previews. These exercise
  [the same renderer](../docker/seed-data/external_plugins/surface_export/web/gateway/MotionPreview.tsx)
  with synthetic states; they are not real transfers or performance evidence.
- [Recovery warnings](../docker/seed-data/external_plugins/surface_export/web/RecoveryWarnings.tsx)
  distinguish accepted restored copies, protected copies, and unverified offline
  state. A warning does not prove the other copy is absent.

## Inspection

Use [the transfer walkthrough](QUICK_START.md) for normal operation and
[the test index](../tests/README.md) for repeatable fixtures. The commands
`node tools/surface-export/canvas-shot.mjs --help` and
`node tools/tests/run-integration-tests.mjs --list` locate browser tooling and live
test runners. Measurements are scoped to their recorded runtime and fixture.
