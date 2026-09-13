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
| `gateway_mode` | `one_gate` | Gateway layout, with `multi` retained as an alternative. Not exposed in the Settings tab. Must match the gateway mod's startup setting. |

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

The [production profile](../../docker/production/settings.json) explicitly disables
`debug_mode`, `debug_destination_snapshot`, `belt_trace`, and `profile_batches`.
The plugin default for debug mode is still `true`; installations outside that
profile do not inherit its overrides automatically.

Test commands, self-tests, cloning, roster changes, and lifecycle fixtures require
`debug_mode` to be explicitly `true` at invocation, including their JSON aliases.
Read-only roster summaries and leftover checks remain available when it is off.

## Mod startup setting

[surfexp-gateway-layout](../../docker/seed-data/mods-src/surfexp_gateways/settings.lua)
belongs to the gateway mod and accepts `one_gate` or `multi`, defaulting to
`one_gate`. Restart affected instances and clients to load changed prototypes.
Changing layouts can remove routes, so return platforms to planets first.

## Verification

[The settings browser test](../../tests/integration/settings/run-tests.mjs) exercises
reads, intercepted writes, permissions, save errors, tab return, and layout without
changing live configuration. Native recovery-policy and restart checks are in
[the manual Docker lab](../../tests/manual/transfer-reliability/README.md#configurable-save-recovery).
