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
| `platform_source_of_truth` | `plugin_history` | `plugin_history` protects previously transferred source copies restored from saves. `save_game` accepts a restored copy with a fresh identity when no unresolved handoff owns it. Applied at instance restart. |
| `max_inflight_transfers_per_instance` | 1 | Experimental admission limit, 1–4; not exposed in the Settings tab. Unresolved recovery blocks admission. |
| `passenger_carry_armor` | `true` | Armor carry over?: passengers take their worn armor through a gateway. Set it in the plugin's Settings tab under **Gateway passengers**; it is sent with the gateway configuration and applies to the next transfer. See [passenger transfer](passenger-transfer.md). |
| `passenger_carry_inventory` | `false` | Inventory carry over?: passengers take their main inventory, weapons, ammunition and logistic trash. Set it in the plugin's Settings tab under **Gateway passengers**; it is sent with the gateway configuration and applies to the next transfer. |

The Settings tab shows configured and applied recovery modes and restart
requirements. Both modes retain active-transfer protections and existing outcomes.
See [save recovery](../technical/transfers.md).

## Instance settings

[InstancePlugin.sendConfigurationToLua](../../docker/seed-data/external_plugins/surface_export/instance.ts)
sends these settings at instance startup. [configure.lua](../../docker/seed-data/external_plugins/surface_export/module/interfaces/remote/configure.lua)
applies them to Lua storage. Changing the configuration requires restarting the
instance before its Lua behavior changes.

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

## Server destinations

`surfexp-gateway-instances` is a startup string setting in the
[gateway mod](../../docker/seed-data/mods-src/surfexp_gateways/settings.lua),
empty by default. It lists Clusterio instance ids, each followed by `=` and a label,
separated by commas, for example `836570928=Forge,902099405=Cinder`. Each entry
adds a destination orbiting the Gateway. Players see the label on the star map
and in platform schedules; an entry without a label is shown as `Server <id>`.
A platform that stops at a destination is sent to that server and arrives at its
Gateway. Ids must be digits and may appear once; otherwise the mod refuses to load.
Labels cannot contain commas. Keep the value identical on every server, and restart
the instances after changing it.

With the [reconciler](../../tools/clusterio/reconcile.mjs), set `serverDestinations`
in the desired-state file instead of writing the setting directly. It maps instance
names to labels, for example `"serverDestinations": { "Nauvis": "[planet=nauvis] Nauvis" }`.
The reconciler resolves each name to its instance id, writes the setting into the
desired mod pack and refuses an unknown instance, an empty label or a label with a
comma. Setting both `serverDestinations` and the startup setting is refused.

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
