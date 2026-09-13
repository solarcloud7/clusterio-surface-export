# Transfer troubleshooting

The [transfer protocol](TRANSFER_2PC.md), [execution flow](EXPORT_IMPORT_FLOW.md),
and [transaction log reference](TRANSFER_LOGS.md) describe the current runtime.
The [manual Docker lab](../tests/manual/transfer-reliability/README.md) retains
reproduced failures and bounded recovery results.

## What does Completed mean?

For a transfer, the controller has received successful destination validation,
verified the destination hold, received source deletion acknowledgement, and
received destination release acknowledgement. See
[TransferOrchestrator.handleValidationSuccess](../docker/seed-data/external_plugins/surface_export/lib/transfer-orchestrator.ts).
Standalone imports do not delete a source platform.

This outcome describes the observed operation. Loading an older save afterward
does not rewrite its result or prove the platform still exists in that world.

## What does Cleanup needs attention mean?

An operation did not confirm its required cleanup or release. A missing reply
does not prove the requested action failed. Retained recovery intents reserve the
participating instances and retry through the normal completion path when both
are available. The destination can remain protected while the outcome is unknown.

Preserve the worlds, controller intent, instance retirement journal, and diagnostic
report. Inspect both instances before retrying or changing any protection. Deleting
a journal or manually unlocking a platform is not a substitute for reconciliation.

## Does a timeout unlock the source?

A controller validation timeout retains uncertainty. It does not fabricate a failed
cargo check or authorize destination deletion. A late verdict can settle the same
operation. Ordinary uncommitted source locks have a separate game-tick expiry;
committed source locks and destination holds are not released by that expiry.
See [SurfaceLock](../docker/seed-data/external_plugins/surface_export/module/utils/surface-lock.lua).

## What happens after loading an older save?

The configured [save recovery policy](TRANSFER_2PC.md#save-recovery-policy) is
applied at instance startup after authority checks. `plugin_history` protects a
restored source recorded as transferred away. `save_game` can accept it with a new
persistent identity and a warning, provided no unresolved handoff owns it.
Neither mode automatically reconstructs a missing destination or changes old history.

**Restore from snapshot** starts a separate validated import when an importable
stored payload is available. A diagnostic-only file is not an importable snapshot.
Offline or uncertain identities are unverified, not evidence that a copy is missing.

## Why can items and fluids pass while the transfer fails?

The item, entity, and fluid panels describe different checks of the destination
attempt. Equal cargo totals do not establish entity state or belt structure.
Rollback success describes recovery and does not change the failed attempt's audit.
See [EntityAudit](../docker/seed-data/external_plugins/surface_export/web/logs/EntityAudit.tsx)
and [transfer-validation.lua](../docker/seed-data/external_plugins/surface_export/module/validators/transfer-validation.lua).

## How should I triage a failure black box?

Run `node tools/tests/testkit/cli.mjs blackbox explain <bundle.json>` to display
recorded item/fluid differences, tick boundaries, physical scan counts, belt
attribution, and replay-payload availability. Add `--json` for structured output.
The [explainer](../tools/tests/testkit/blackbox-explain.mjs) reads only the bundle;
it does not classify a root cause or recommend a retry from a signature.

Compare these records with the transaction's failed stage and entity evidence.
An empty item/fluid diff does not mean entity restoration succeeded. Recorded
test-hook failures can have the same differences as real cargo failures. Preserve
the original bundle and investigate the capture and restoration boundaries.

## Are ticks interchangeable with milliseconds?

No. [Timing records](async-processing.md#measurement-contract) keep Clusterio
monotonic-clock intervals, Lua profiler measurements, and exact tick information
separate. Tick counts describe scheduling; a callback with zero elapsed ticks can
still block the simulation. Independent process clocks are not aligned in the UI.

## Does debug mode enable normal transfer logging?

Normal transaction history, validation, and phase timings are independent of debug
mode. Debug mode enables diagnostic exports and development instruments. The
additional full destination snapshot requires both debug flags. See
[configuration](CONFIGURATION.md#instance-settings).

## Can passengers ride the platform to another instance?

Platform transfer does not move a player's connection. Source deletion attempts
evacuation locally; the separate teleport GUI offers a native server connection
prompt. Evacuation is best effort, with logged failure paths. See
[passenger handling](GATEWAYS.md#passenger-handling).
