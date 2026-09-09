# Manual Docker transfer acceptance

These experiments are automated but run only when explicitly invoked. They are outside
`tests/integration`, so the ordinary integration runner does not discover them. The small
offline harness regressions run with `npm test` and do not use Docker.

Run from the canonical checkout with Docker Desktop running and the pinned images available:

```powershell
# Build the plugin artifacts if source changed; never npm install in the live plugin mount.
./tools/clusterio/build-plugin.ps1 -Target all
node tests/manual/transfer-reliability/run.mjs --list
node tests/manual/transfer-reliability/run.mjs --case lost-source-reply
node tests/manual/transfer-reliability/run.mjs --case lost-destination-reply
node tests/manual/transfer-reliability/run.mjs --case crash-source-before-save
node tests/manual/transfer-reliability/run.mjs --case restore-old-source
node tests/manual/transfer-reliability/run.mjs --case performance
```

The shorter entry point is `npm run test:manual:transfers -- --case <id>`.
Use `npm run test:manual:transfers -- --all` to run all five cases sequentially. It continues
after a recorded STOP so the other experiments still run, but stops on harness/cleanup errors.
Offline instrumentation checks are `node --test tests/manual/transfer-reliability/harness.test.mjs`
and `lua tests/manual/transfer-reliability/performance.test.lua`.

Run cases sequentially. Each invocation owns the repository workflow lock, stages built runtime
artifacts, creates a fresh controller and two headless hosts, seeds the committed golden saves,
and removes its Docker resources in `finally`. Startup and each case have separate ten-minute
deadlines. Individual commands and output are bounded. Image startup includes dependency/mod
setup; this time is outside the measured transfer callbacks.

The lab has a unique network, containers, volumes, generated credentials, and plugin runtime
copy under ignored `ci-artifacts`. It publishes no ports. It reads canonical mod archives through
read-only mounts; it never uses the live data or Steam client volumes. Resource deletion checks
both the exact run label and its name. There is no live-cluster target option. Host process
interception exists only in the disposable containers through `NODE_OPTIONS`.

## What each case proves

The versioned [contract](contract.json) states the invariant before a run. The physical probe
reads actual entity inventories, item qualities, belt sides, fluids, visibility, locks, holds,
and an activation canary. Its expected cargo is constructed independently of export and
validation code. Item position within a belt segment is not compared.

| Case | Intervention | Required evidence |
| --- | --- | --- |
| `lost-source-reply` | Let real source deletion succeed, hold its host response, kill/restart the controller | Real recovery retry, one import, completed operation, source absent, destination usable with exact cargo |
| `lost-destination-reply` | Let real destination release succeed, hold its host response, kill/restart the controller | Same guarantees, exercising release receipt replay |
| `crash-source-before-save` | Save before transfer; after deletion succeeds, kill the source host and load that earlier checkpoint | Sampled cargo and single-usable-copy safety; outcome records whether recovery progressed or remained protected |
| `restore-old-source` | Complete normally, then restore only the source from an earlier save | Detect whether an independently restored source creates two usable copies |
| `performance` | Transfer six-entity and 518-entity fixtures in three profiling modes, three repetitions each | Independent cargo parity plus real scheduler/setup callback profiler readings |

Lost-reply interception does not fabricate successful Lua results, edit validation, accelerate
recovery timers, or unlock anything. The real handler completes its mutation before the hook
withholds the response. The old request remains unresolved; retries execute the real handler.
This reproduces an accepted action with an unavailable response at the host/controller boundary,
not arbitrary packet loss throughout the network.

Save cases explicitly disable autosaving and select a named checkpoint, with ZIP verification and
SHA-256 evidence. They intentionally create different save ages between participants. They are
not a power-loss/filesystem durability test. Samples are sequential observations of two worlds,
not proof of every intervening tick. A protected copy can preserve safety without recovery
completing; that distinction remains in the report.

## Results and reruns

Each run prints its `ci-artifacts/se-manual-*/result.json`. This retains the contract, source and
runtime hashes, image identities, observations, fault events, outcome, and cleanup results.
Container log tails are saved beside it. These local artifacts may contain runtime details and
are ignored by Git. Re-evaluate a report without Docker:

```powershell
node tests/manual/transfer-reliability/run.mjs --analyze ci-artifacts/<run-id>/result.json
```

- **PASS / exit 0:** the case's stated observations satisfy its contract.
- **STOP / exit 2:** valid observations demonstrate a safety violation. Preserve the report;
  this is a reproduced product limitation, not permission to weaken the oracle.
- **HARNESS_ERROR / exit 1:** setup, instrumentation, required evidence, or cleanup failed.
  It cannot establish product safety either way.

Diagnostic log tails are capped at 1 MiB per container; `cleanup.logs[].truncated` explicitly
records that limit. This does not truncate the required physical observations or profiler records.
Missing or truncated measurement records invalidate the performance comparison.

Older-save restoration can legitimately produce STOP with the current save-local receipt design.
Do not turn that into an expected-success assertion or describe these cases as universal crash safety.

To exercise cleanup after an intentional harness error:

```powershell
node tests/manual/transfer-reliability/run.mjs --case lost-source-reply --fail-after-setup
```

Expect exit 1 and `cleanup.success: true`. A forcibly terminated runner cannot execute `finally`.
After verifying that the workflow-lock owner PID has exited, follow the shared lock recovery
instructions and remove only that stale lock. Then retry cleanup using the printed run identity:

```powershell
node tests/manual/transfer-reliability/run.mjs --cleanup <run-id>
```

Cleanup discovers exact-label resources even when container startup failed before returning a
container ID. A retry writes `cleanup-retry.json` and preserves the original failed report.

## Performance interpretation

Each fixed fixture is transferred in `off`, `normal`, and `debug` modes; mode order rotates over
three repetitions. The 512 additional steel chests contain 170 rare iron plates and 230 copper
plates each. The outer profiler measures individual scheduler callbacks, export queue setup, and
import queue setup. Records retain raw Factorio profiler text, parsed milliseconds, and separate
tick boundaries. No ticks are converted to milliseconds and nested intervals are not summed.

`off` disables only `operation-timing.lua`; legacy profiling and diagnostics remain. `normal`
retains phase timing; `debug` also retains batch records. The outer measurement profiler remains
enabled in all modes. Results include its overhead and local host scheduling noise. The report
groups sample counts, p50, p95 and maximum by fixture size, mode, host, and callback boundary.
Each host retains at most 2,000 outer records per transfer; truncation invalidates the comparison.

This matrix measures instrumentation overhead on fixed fixtures. It does not establish a maximum
supported platform size, bound a huge connected belt network, or prove a before/after lag reduction
from phase yielding. Those require separately specified workloads and comparisons.

## Verified runs

Results are recorded here only after the corresponding local experiment finishes. The original
setup failure is retained in `ci-artifacts/se-manual-mtsws6ko-0e05708b/result.json`: a read-only mount
parent lacked its child mount directory. Cleanup was corrected to discover containers that Docker
created but failed to start; a subsequent owner-checked cleanup removed those resources.

- `se-manual-mtswxtzf-eb6c6d0c`: lost source reply **PASS**, exact cargo, one import, real retry,
  completed destination, and verified resource removal. This predates the additional idle-seed
  preflight checks and does not prove the other cases.
- `se-manual-mtsx1s8x-b947ee3c`: lost destination reply **PASS**, including a real release retry,
  one import, exact cargo and resource removal. Also predates the added idle-seed preflight.
- `se-manual-mtsx5tfk-a131deaa`: checkpoint verification **HARNESS_ERROR**, because the headless
  image does not contain `unzip`. No crash was injected; cleanup succeeded. Verification now uses
  Clusterio's installed JSZip library with CRC checks.
- `se-manual-mtsxagk7-ed6c2241`: source crash before save **PASS for sampled safety only**. The
  earlier checkpoint restored a usable source with exact cargo. The destination remained held;
  the operation was `cleanup_failed`, so automatic recovery liveness was **not** established.
  All disposable resources were removed.
- `se-manual-mtsxev53-07be893a`: earlier source restore after completion **STOP**. Two subsequent
  physical observations found **two usable copies**, each with the original cargo. The controller
  still recorded the completed transfer. This reproduces the need for backup reconciliation;
  no production behavior or oracle was weakened to hide it. Cleanup succeeded.
- `se-manual-mtsxjw8s-81bc96f1`: all 18 performance transfers preserved cargo, but finalization
  reported **HARNESS_ERROR** because verbose log tails exceeded the command buffer. Docker
  resource removal completed. Log tails now retain a bounded prefix with explicit truncation;
  an offline regression reproduces the overflow. This original report is preserved unchanged.
- `se-manual-mtsxri9j-f85ba3ef`: performance matrix **PASS**. All 18 transfers retained exact
  physical cargo; all 396 outer profiler records were available, with no measurement truncation.
  All Docker resources were removed. Diagnostic host log tails reached their separately reported
  1 MiB limits. Re-analysis with the final oracle also passed.

Observed maximum callback durations in that second matrix, milliseconds (three transfers per cell):

| Fixture / boundary | Timing off | Normal timing | Batch timing |
| --- | ---: | ---: | ---: |
| 6 entities: source setup | 72.33 | 97.96 | 69.72 |
| 6 entities: source scheduler | 9.92 | 9.91 | 12.12 |
| 518 entities: source setup | 96.07 | 129.29 | 111.82 |
| 518 entities: source scheduler | 150.20 | 153.57 | 156.68 |
| 518 entities: destination setup | 49.73 | 50.04 | 50.46 |
| 518 entities: destination scheduler | 62.54 | 67.32 | 61.84 |

These are measured local elapsed times, not CPU-exclusive times or a guaranteed frame budget.
The long source callback exists with operation timing disabled. The variation between repeats,
especially setup, prevents a precise overhead percentage from these three repetitions alone.
The seeds retained debug mode; full destination snapshots and belt tracing were off. The complete
config snapshot, raw readings, tick boundaries, sample counts and percentiles are in the artifact.
