# Configuration

[index.ts](../../docker/seed-data/external_plugins/surface_export/index.ts) registers
the plugin's controller and instance fields. The tables below use the
`surface_export.` prefix. They describe registered defaults, not the values
currently applied to an existing cluster.

## Controller settings

The [Settings tab](../../docker/seed-data/external_plugins/surface_export/web/SettingsTab.tsx)
reads and writes Clusterio controller configuration. Reading requires
`core.controller.get_config`; saving requires `core.controller.update_config`.
It submits changed, writable fields together and reads the configuration back.
There is no separate plugin settings store.

| Field | Default | Behavior |
|---|---|---|
| `max_storage_size` | 20 | Stored Payload Downloads: retained platform payload files. The oldest file is removed when the limit is reached on a subsequent store. Transfer history is separate. |
| `transaction_log_detail_entries` | 100 | Saved Detailed Transfer Logs: retained timings and audit evidence, with failures prioritized. The UI accepts 10–5,000. Other operations retain summaries. |
| `transfer_validation_timeout_seconds` | 30 | Delay before verifying job status after payload acceptance. Clamped to 5–120 seconds; takes effect on the next transfer. Queued or progressing work stays nonterminal. Missing status retains ownership for recovery. |
| `platform_source_of_truth` | `plugin_history` | `plugin_history` quarantines every restored copy whose travel history is uncertain until an administrator decides. `save_game` additionally accepts a restored copy when the server recorded as holding the platform confirms it no longer has it; duplicates and unverifiable copies are quarantined in both modes. Applied at instance restart. See [recovery](recovery.md). |
| `max_inflight_transfers_per_instance` | 1 | Experimental admission limit, 1–4; not exposed in the Settings tab. Unresolved recovery blocks admission. |
| `passenger_carry_armor` | `true` | Armor carry over?: passengers take their worn armor through a gateway. Set it in the plugin's Settings tab under **Gateway passengers**; it is sent with the gateway configuration and applies to the next transfer. See [passenger transfer](passenger-transfer.md). |
| `passenger_carry_inventory` | `false` | Inventory carry over?: passengers take their main inventory, weapons, ammunition and logistic trash. Set it in the plugin's Settings tab under **Gateway passengers**; it is sent with the gateway configuration and applies to the next transfer. |
| `discord_invite` | empty | Discord invite link: printed in chat to each player who joins any server of the cluster. Empty prints nothing. Chat relay to Discord is the separate `discord_bridge` plugin; see [deployment](deployment.md#discord-bridge). |

The Settings tab shows configured and applied recovery modes and restart
requirements. Both modes retain active-transfer protections and existing outcomes.
See [save recovery](../technical/transfers.md).

## Instance settings

[InstancePlugin.sendConfigurationToLua](../../docker/seed-data/external_plugins/surface_export/instance.ts)
sends these settings, except `disabled_planets` and `default_planet`, at instance startup. [configure.lua](../../docker/seed-data/external_plugins/surface_export/module/interfaces/remote/configure.lua)
applies them to Lua storage. The two planet settings are applied as described in
[planets on each instance](#planets-on-each-instance). Changing the configuration
requires restarting the instance before its Lua behavior changes.

| Field | Default | Behavior |
|---|---|---|
| `disabled_planets` | Empty | Comma-separated installed planet names unavailable on this instance. Empty enables all planets; normal research still controls discovery. |
| `default_planet` | `nauvis` | Enabled planet for new players, displaced passengers and imports with no requested destination. Must have a safe arrival position near 0,0. |
| `batch_size` | 50 | Entities processed per batch; not a time limit on a callback. |
| `max_concurrent_jobs` | 1 | Combined import/export job steps advanced per tick. |
| `belt_batch_size` | 500 | Target stacks or belt lines per restoration batch. A lane group remains indivisible and can exceed the target. |
| `max_export_cache_size` | 10 | Positive integer count of completed exports retained in the instance save, raised to at least `max_concurrent_jobs + 1`. Transfer-owned exports are protected from eviction. Invalid persisted limits fall back to 10. |
| `show_progress` | `true` | In-game batch progress notifications. |
| `belt_trace` | `false` | Additional belt positions after successful restoration; failures retain evidence independently. |
| `profile_batches` | `false` | Up to 2,000 individual batch timing records per job. Phase totals remain available when off. |
| `sectioned_codec` | `false` | Experimental section encoding/decoding spread over ticks. |
| `debug_mode` | `true` | Diagnostic JSON output and development instruments, including selection-lab tools. Normal transfer logs and validation do not depend on this flag. |
| `debug_destination_snapshot` | `false` | Additional full destination scan after successful validation; also requires debug mode. |

For operational instances, set `debug_mode` to `false` unless diagnostics are needed.
Leave `debug_destination_snapshot`, `belt_trace`, and `profile_batches` off unless
investigating a problem. The plugin default for debug mode is `true`; installation
does not automatically replace it with the settings used by acceptance tests.

Test commands, self-tests, cloning, roster changes, and lifecycle fixtures require
`debug_mode` to be explicitly `true` at invocation, including their JSON aliases.
Read-only roster summaries and leftover checks remain available when it is off.

### Planets on each instance

Set `disabled_planets` and `default_planet` in that instance's Clusterio
configuration, then restart it. For example, set `default_planet` to `fulgora`
and `disabled_planets` to `nauvis,vulcanus,gleba,aquilo` for a Fulgora instance.
Names must match installed planets. The default cannot be disabled; invalid
configuration prevents startup recovery from releasing platforms.

The checked planet-policy exchange runs before the startup recovery gate opens;
it is separate from `configure.lua`. These are runtime restrictions, so instances
can share the same mod pack and startup settings. They do not filter the pre-game
map generator or remove planet prototypes, surfaces, factories or schedule stops.

Disabled planets are hidden from the surface list and locked against new journeys.
Prototypes, surfaces, factories and schedule stops are left as they are; a schedule
stop that names a disabled planet is the operator's to adjust.

Players on an unavailable planetary surface are moved near 0,0 on the default
planet. Occupants of valid platforms remain aboard. New players use the default
even if Nauvis is enabled; existing residents of enabled planets are not moved.
Relocation that Factorio temporarily refuses is retried once per second of
simulation time. Changing the default does not make its terrain or technology a
playable starting scenario; administrators still need to prepare the world.

The in-game **Instance** panel shows the applied instance name and unavailable
planets. A configuration edit does not change that panel until restart applies it.

## Portals

The gateway mod places four coloured portals around the Gateway on every server:
Blue, Green, Orange and Purple. The controller gives each server one colour and
keeps it across restarts and renames. On every other server, that colour's portal
leads to that server. A platform whose schedule stops there is sent to that server
and arrives at its Gateway. A server's own colour is locked on that server, and a
colour no server holds is locked everywhere.

At most four servers hold a colour. A server whose `surface_export.load_plugin` is off
and holds no colour is not counted; one that holds a colour keeps it, and so uses one
of the four, until an administrator releases it. A new server gets the lowest colour that no server has held.
Turning a server's `surface_export.load_plugin` off does not retire its colour.
While the plugin is off, that colour is locked on every other server, and
`clusterioctl surface-export gateways` and the Gateways page list it as held by
that server with its plugin off. When the plugin is turned back on, the server
leads through the same colour again. Deleting a server retires its colour: the
colour stays locked everywhere and is never assigned automatically, because
schedules on other servers may still stop there. A server that finds no unused
colour gets none. The controller log and
`clusterioctl surface-export gateways` report it, and the Gateways page shows it
and every retired colour greyed out. A server without a colour can still send
platforms through the Gateway, and other servers can reach it the same way.

An administrator decides what happens to a retired colour with
`clusterioctl surface-export portal assign <instance> <portal>`, and frees a colour
without deleting its server with `clusterioctl surface-export portal release <portal>`;
see [commands](commands.md#clusterio-control-client).

No restart is needed: the controller sends the assignment to every running server,
which unlocks or locks the portals immediately. When a colour passes to another
server, the controller logs a warning and every running server announces in chat
that the portal now leads there. Schedules that stop at that colour travel to the
new server. Server names shown in the transfer dialog and in alerts are the
Clusterio instance names.

The assignment and the retired colours are stored in `surface_export_portal_slots.json`
in the controller database directory. If that file cannot be read, every coloured
portal stays locked, the portal commands are refused, and the file is left unchanged
until it is repaired or removed. Removing it lets the controller assign the colours
again in instance id order and forgets the retired colours.

## Mod map setting

`surfexp-platform-boarding` is a runtime-global boolean in the companion mod,
defaulting to `true`. It permits boarding another enabled platform at the same
space location on the same instance. It does not connect players to another server.
Changes apply without an instance restart. Both the updated plugin and companion
mod are needed for this control.

## Verification

[The settings browser test](../../tests/integration/settings/run-tests.mjs) exercises
reads, intercepted writes, permissions, save errors, tab return, and layout without
changing live configuration. Native recovery-policy and restart checks are in
[the manual Docker lab](../../tests/manual/transfer-reliability/README.md#configurable-save-recovery).
