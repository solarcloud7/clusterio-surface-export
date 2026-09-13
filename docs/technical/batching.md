# Tick batching and queues

Factorio executes the plugin's Lua callbacks sequentially. A batched job stores
its progress and resumes in a later tick; it does not run Lua on a background
thread. Node handlers can wait asynchronously for messages, storage or RCON, but
that does not make a Lua engine call incremental.

## Two scheduling decisions

The controller admission queue limits transfers involving each instance. The
default is one admitted transfer per instance, with the reservation retained
through required cleanup. Unresolved ownership blocks that pair; unrelated
instances can still work. The experimental higher admission setting permits
overlap of external work and needs workload-specific acceptance.

Within each instance, one shared Lua scheduler serves imports and exports.
`max_concurrent_jobs` limits how many job entries advance in an invocation,
sequentially. `batch_size` limits entity work in applicable stages.
Neither setting is a millisecond budget or a limit on every callback.

## Current work boundaries

| Area | Work spread across callbacks | Work that can still be indivisible |
|---|---|---|
| Export preparation | None before admission to the Lua scheduler | Locking, schedule capture, entity collection/sorting, tile scanning and job setup run synchronously. |
| Entity capture | Entity entries | One entity's inventories or state can be large. |
| Belt capture | Separated from other export phases | The required moving-belt capture and paired cargo read share a callback. |
| Export encoding | Incremental entity/tile JSON assembly; separate compression/output phases | Native compression and a large individual record. |
| Import setup | Optional section decoding; platform preparation follows on a later callback for that format | The default document decode and platform preparation run synchronously. Section decoding still performs an indivisible decode per section; platform creation, starter-pack application and schedule setup are not batched. |
| Tiles and beacons | Tile passes and beacon creation batches | Individual engine operations. |
| Belt restoration | Captured lane groups packed into batches | Each group's insertion and physical delta check run together. A group can exceed the soft target. |
| State and inventories | Phase yields and inventory work batches | A single entity's restoration work; deferred circuit readiness has its own state. |
| Completion | Earlier phases yield before completion | Fluid restoration, cargo validation, activation and hold preparation share a callback. |
| Diagnostics and recovery | Separate from ordinary entity batching | Optional full snapshots and whole-platform cleanup can still be expensive. |

Belts continue to move between callbacks. Splitting reads or writes arbitrarily
can count the same item twice or miss it as it crosses a boundary. Lane-group
restoration therefore retains its physical delta check in the same callback.
The [belt experiments](../../tests/instruments/belt-boundary/README.md) record
failed candidates and the limits of the selected approach. Matching item and
quality counts on each side matters; exact position within a segment is not the
fixture's acceptance criterion.

The optional `sectioned_codec` encodes and decodes independently framed sections
across ticks. It is off by default. A large record can still exceed an intended
frame target. RCON chunk size concerns transport; sending a large JSON document
in smaller chunks does not divide the later whole-document parse.

## Tune from measurements

Use [instance configuration](../admins/configuration.md#instance-settings) to
adjust work counts, then restart the instance. Lower counts can reduce work in a
callback while increasing total transfer duration. They do not guarantee a frame
rate or eliminate long engine calls.

Compare whole-callback maxima, client/server tick-entry gaps and total operation
duration separately. Keep fixture size, engine/mod versions, settings and host
conditions with each result. The [callback probes](../../tests/instruments/callback-profile/README.md)
and [tick recorder](../../tests/instruments/tick-watch/README.md) measure different
boundaries. Their historical numbers are not limits for every platform.

Implementation entry points:
[scheduler](../../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua),
[export pipeline](../../docker/seed-data/external_plugins/surface_export/module/core/export-pipeline.lua),
[import completion](../../docker/seed-data/external_plugins/surface_export/module/core/import-completion.lua).
