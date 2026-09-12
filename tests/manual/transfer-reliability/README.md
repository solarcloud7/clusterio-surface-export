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
node tests/manual/transfer-reliability/run.mjs --case save-policy-game
node tests/manual/transfer-reliability/run.mjs --case save-policy-history
node tests/manual/transfer-reliability/run.mjs --case save-policy-pending
node tests/manual/transfer-reliability/run.mjs --case snapshot-recovery
node tests/manual/transfer-reliability/run.mjs --case performance
```

If an older source checkpoint predates its transfer lock and retirement record, but the
controller still owns that source, startup remains blocked for manual reconciliation.
The regression exercises that missing-lock boundary; it does not claim automatic recovery
of an arbitrary older checkpoint. Identifiable retired sources use the normal retry path.

The shorter entry point is `npm run test:manual:transfers -- --case <id>`.
Use `npm run test:manual:transfers -- --all` to run all listed cases sequentially. It continues
after a recorded STOP so the other experiments still run, but stops on harness/cleanup errors.
Offline instrumentation checks are `node --test tests/manual/transfer-reliability/harness.test.mjs`
and `lua tests/manual/transfer-reliability/performance.test.lua`.

Run cases sequentially. Each invocation owns the repository workflow lock, stages built runtime
artifacts, creates a fresh controller and two headless hosts, seeds the committed golden saves,
and removes its Docker resources in `finally`. Startup and each case have separate ten-minute
deadlines. Individual commands and output are bounded. Image startup includes dependency/mod
setup; this time is outside the measured transfer callbacks.

The lab has a unique network, containers, volumes, generated credentials, and plugin runtime
copy under ignored `ci-artifacts`. Recovery-policy and snapshot cases publish a random loopback
HTTP port for their browser assertions; other cases publish no ports. It reads canonical mod archives through
read-only mounts; it never uses the live data or Steam client volumes. Resource deletion checks
both the exact run label and its name. There is no live-cluster target option. Host process
interception exists only in the disposable containers through `NODE_OPTIONS`.

## What each case proves

### Configurable save recovery

`save-policy-game` and `save-policy-history` use the same mixed checkpoint. One unrelated
platform is deliberately destroyed and another is transferred away. Reloading the source
checkpoint must restore the unrelated platform with its physical cargo. The transferred
source is accepted with a fresh persistent identity in Save game mode, or remains protected
in Plugin history mode. The destination's cargo must remain intact in both cases.

The Save game arm also changes the configured policy before restarting, checks the browser's
restart notice, saves/reloads the accepted world, rejects old deletion and unlock requests,
and transfers the accepted copy again with a new export ID. Its deliberate duplicate is an
operator-approved restoration, not a successful exactly-once transfer claim.

`save-policy-pending` withholds the reply to an executed source deletion, then reloads the
earlier source checkpoint in Save game mode. The restored source must keep its old identity
and protection while that handoff is unresolved. After removing the communication fault and
restarting the controller, normal recovery must leave one usable destination with exact cargo.

`snapshot-recovery` reproduces the missing destination after loading its earlier checkpoint,
retains the original completed history, then submits a separate stored-snapshot import. A
repeated request UUID must return the same operation. Independent physical item/quality,
belt-side, fluid and fixture-entity observations must survive another save/restart. Passing
this arm does not turn the original unassisted destination-rollback STOP into a PASS.

These cases also exercise the inline warning, snapshot confirmation and Settings page in
headless Chromium. Install the repository's Playwright Chromium if it is not available.
Run `--sectioned` to exercise the sectional payload path. Ordinary runs exercise the existing
codec configuration. Each JSON result records which codec was enabled and the staged hashes.

Retained Factorio 2.1.17 observations (the reports include staged hashes; their `head` is
the implementation's base commit):

| Case | Evidence | Result |
|---|---|---|
| Save game mixed checkpoint and second transfer | [Physical observations](evidence/save-policy-game-2.1.17.json.gz) | PASS; fresh persistent identity, old delete/unlock rejected, cargo and browser checks |
| Plugin history mixed checkpoint | [Physical observations](evidence/save-policy-history-2.1.17.json.gz) | PASS; restored source protected, unrelated platform usable |
| Pending source-deletion acknowledgement | [Physical observations](evidence/save-policy-pending-2.1.17.json.gz) | PASS; adoption refused, normal recovery completed with exact cargo |
| Manual snapshot recovery | [Existing codec](evidence/snapshot-recovery-2.1.17.json.gz), [sectional codec](evidence/snapshot-recovery-sectional-2.1.17.json.gz) | PASS; missing-copy reproduction, fresh import, duplicate refusal and save/restart |
| Offline destination | [Physical and browser observations](evidence/snapshot-offline-recovery-2.1.17.json.gz) | PASS; offline instance reported as unverified, destination disabled, exact cargo after restart |

`save-policy.test.mjs` reads these reports and rejects cargo mutations. The original
[Factorio callback require error](evidence/save-policy-require-failure-2.1.17.json.gz) and
[unavailable post-transfer snapshot](evidence/snapshot-retention-failure-2.1.17.json.gz)
remain failed runs. The fixes move the require to module parsing and retain successful
transfer payloads under the existing storage cap. Missing-lock, unavailable-authority,
permission, malformed/diagnostic payload and completion-before-reply boundaries also have
regressions; those are simulated failures, not additional live-engine acceptance claims.

### Destination save rollback

```powershell
node --test tests/manual/transfer-reliability/destination-rollback.test.mjs
node tests/manual/transfer-reliability/run.mjs --case restore-old-destination --fail-after-control
node tests/manual/transfer-reliability/run.mjs --case restore-old-destination
node tests/manual/transfer-reliability/run.mjs --analyze ci-artifacts/<run>/result.json
```

The case saves the destination before a transfer, completes the transfer, and saves
the destination again. It first reloads the newer checkpoint as a control: the source
must remain absent, destination cargo must exactly match the independent physical
fixture, and history must retain the completed operation. Only then does it load the
older destination checkpoint. The controller and source are never restored or restarted.
Save hashes and a run-scoped storage marker verify the selected generation.

After rollback, at most 16 samples over at least 65 seconds observe both running worlds
and the retained transaction status. The runner makes no recovery requests or changes
to timers, receipts, journals or cargo. Read-only observation continues after a violation
to record whether normal recovery acts. Every sampled loss or duplicate remains a STOP,
even if a later sample recovers. Missing evidence, an invalid control, interrupted
observation or failed Docker cleanup is a HARNESS_ERROR.

Missing platforms mean no physical copy was observed in either running world. They do
not establish loss of every backup or cached payload. The newer checkpoint remains in
the lab until cleanup; restoring it is outside this experiment. Historical completion
is reported separately from current physical cargo. This case reuses the existing Lua
fixture and observer; its only additional save state is the harness generation marker.

The injected cleanup run fails after reloading the newer checkpoint, before the stale
save is loaded. Require its intentional error and `cleanup.success: true` before the
acceptance run. Both commands act only on the owned disposable cluster.

Retained Factorio 2.1.17 / plugin 0.10.281 evidence:

- [Cleanup exercise](evidence/destination-rollback-cleanup-2.1.17.json.gz): the completed
  checkpoint reloaded with exact cargo and completed history; the intentional failure
  ran before stale-save injection, and all owned Docker resources were removed.
- [Destination rollback](evidence/destination-rollback-2.1.17.json.gz): the same control
  passed, then the verified older checkpoint loaded. Ten samples during a measured
  67.236-second window found neither physical platform. History remained `completed`,
  one import request was recorded, and cleanup succeeded. Acceptance is **STOP**.

Both runs used identical harness hashes and staged plugin bytes. The gzip files contain
the raw JSON reports; decompress before passing them to `--analyze`. The offline regression
requires the retained failure to remain STOP. It is not a passing recovery certificate.
The observation did not attempt restoration of the retained newer save or cached payloads.

### Coordinated volume restore

The [restore contract](backup-restore.md) defines a quiesced backup of every disposable
lab volume, including a completed transfer and a pending source-deletion acknowledgement.
The runner erases the original volume contents, verifies emptiness, restores the archives,
and requires normal recovery, independent physical cargo parity and retained history.
This tests data restoration with the same container definitions and runtime. It does not
rebuild a lost Docker host or establish mixed-generation backup safety.

```powershell
node --test tests/manual/transfer-reliability/backup-restore.test.mjs
node tests/manual/transfer-reliability/run.mjs --case coordinated-restore --fail-after-backup
node tests/manual/transfer-reliability/run.mjs --case coordinated-restore
node tests/manual/transfer-reliability/run.mjs --analyze ci-artifacts/<run>/result.json
```

The injected cleanup run must end `HARNESS_ERROR` with the intentional failure and
`cleanup.success: true`; it is not a transfer pass. Archive hashes, comparisons,
checkpoint hashes, physical observations, history and recovery calls remain in the JSON
report. Archives contain generated credentials and stay inside an owned Docker volume
that is removed with the lab. Do not publish backup contents as test evidence.

### Golden-save settings comparison

```powershell
node --test tests/manual/transfer-reliability/settings-oracle.test.mjs
node tests/manual/transfer-reliability/settings-transfer.mjs --cleanup-proof
node tests/manual/transfer-reliability/settings-transfer.mjs --run
node tests/manual/transfer-reliability/settings-transfer.mjs --analyze ci-artifacts/<run>/result.json
```

This separate manual instrument stages the manifest's hash-pinned source golden save
on both disposable instances. It captures immutable settings observations before
transferring platforms; destination reference copies are renamed to avoid comparing
the wrong platform. The native Factorio blueprint reader does not call the plugin's
serializer, restorer or validator. Temporary blueprint inventories are destroyed on
success and on injected capture failure.

The comparator resolves blueprint entity numbers and wire endpoints to physical
identities. It compares every returned blueprint property, including filters, recipes,
control behavior and connections. Entities omitted by Factorio's blueprint capture
are explicitly listed as uncovered. Native blueprint configuration is only one layer:
this test does not certify inventory contents, fluids, belt-side quantities, circuit
memory or other dynamic runtime state. Existing independent physical cargo and pad
tests remain necessary. Two worlds disagreeing before transfer invalidate the reference;
their difference must not be blamed on transfer or normalized away without evidence.

Limits: 12 platforms, 12,000 entities per platform, bounded 32 KiB commands and 1 MiB
responses, and a 20-minute case deadline after setup. Stop at the first failed transfer
or settings mismatch and retain the observations before destroying the disposable
cluster. This is not a new production runtime scan or default CI workload.

The initial cleanup exercise `se-manual-mtus68sv-46c78022` passed: an intentional
observer exception destroyed its temporary inventory, then an intentional runner
exception removed the owned Docker resources. The artifact remains `HARNESS_ERROR`
with `cleanupProofPassed: true`; it is not a transfer pass. Six offline comparator
tests detect wrong filters, missing wires, altered control behavior, missing entities
and missing evidence while accepting renumbered equivalent entities.

First transfer observation `se-manual-mtus981c-74149521` stopped on a real settings
difference after a completed transfer of `lab-transfer-fixture-v1`. Both initial
worlds matched. All 1,358 blueprint-visible entities remained present; seven constant
combinators lost 15 `import_from` values in their signal filters. No other compared
blueprint properties differed. The following two platforms were not transferred.
Owned Docker resources were removed. Raw observations are retained in
[`evidence/settings-before-2.1.17.json.gz`](evidence/settings-before-2.1.17.json.gz)
and can be passed directly to `settings-transfer.mjs --analyze` (expected exit 2).

The scanner and restorer each omitted the `LogisticFilter` location metadata. The
candidate fix carries `import_from`, `minimum_delivery_count` and `request_from`
through both paths. The focused `tests/lua/restore-behavior.lua` regression covers
location IDs represented as strings or prototype objects. A live repeat is required
before declaring this fixed. This mismatch concerns settings, not evidence of item loss.

The first observer also keyed its uncovered-entity lookup by Lua object wrapper,
which overreported uncovered entities. This did not affect the blueprint property
comparison. The lookup now uses physical identity; the original evidence is retained
unchanged, and its uncovered lists must not be interpreted as real coverage gaps.

Revised capture cleanup passed in `se-manual-mtushydz-a70c7a09`, including an injected
failure after native blueprint creation. Repeat `se-manual-mtusl9iw-b663cb3c` then
completed the transfer fixture with zero settings differences across 1,358 entities,
proving the filter metadata fix at that boundary. The omnibus transfer completed but
lost 31 disabled section states across 28 constant combinators: the expected section
`active: false` was absent afterward. Its 408 blueprint-visible entities were present.
The one-of-each platform remained BLOCKED by this failure. The scanner omitted section
`active` and `multiplier`; the restorer consequently retained newly created defaults.
The next fix preserves both, with an explicit nil check so false survives. Original
second-rung evidence is
[`evidence/settings-sections-before-2.1.17.json.gz`](evidence/settings-sections-before-2.1.17.json.gz).

Repeat `se-manual-mtusqo9a-76373edc` verified zero settings differences for both the
transfer fixture (1,358 entities) and omnibus (408 entities). The third transfer
completed, but the harness then treated Factorio's empty source-platform table `{}`
as a JavaScript array. It failed before destination readback; that third comparison
is unverified and the run is `HARNESS_ERROR`, with Docker cleanup successful. Sequence
normalization now accepts empty/numeric-key Lua tables and rejects missing or sparse
evidence. The new regression reproduces the empty-table case offline.

Final physical run `se-manual-mtuswi2t-610d45c7` completed all three transfers,
confirmed source absence and removed its Docker resources. The first two platforms
matched exactly. The one-of-each comparison had one raw difference: an arithmetic
combinator's omitted first constant became explicit zero. The pinned
`ArithmeticCombinatorBlueprintControlBehavior` uses `ArithmeticCombinatorParameters`,
whose missing first/second constants default to zero. The comparator now fills those
defaults only when the operand has no signal. A nonzero change still fails. This
analysis change does not alter production or discard the raw observation.

Re-analysis with that documented normalization passes all 1,830 blueprint-visible
entities: 1,358 transfer-fixture, 408 omnibus, 64 one-of-each. The original run's STOP
verdict remains in the raw artifact; the final analyzer result is recorded separately.
The one-of-each reader leaves 59 source and 18 destination entities uncovered, including
dynamic segmented-unit body segments, robots and entities the blueprint API omits.
Those are coverage gaps, not certified matches. This is configuration acceptance,
not universal entity-state or cargo parity proof.

### Sectional codec and bounded overlap acceptance

These are opt-in experiments. Production defaults remain the legacy codec and one
admitted transfer per instance. Repeat the settings comparison with
`node tests/manual/transfer-reliability/settings-transfer.mjs --run --sectioned`.
Run the callback matrix with `run.mjs --case performance --sectioned` (omit the
flag for legacy). Each runner creates and cleans its own disposable cluster.

Sectional settings run `se-manual-mtutuyyy-ead15356` passed all 1,830 blueprint-visible
entity configurations and source-deletion checks. The large transfer fixture used
the explicit legacy fallback; omnibus and one-of-each used sectional compression.
Raw observations and profiler readings are banked in `evidence/settings-sectional-*`.
Blueprint-omitted entities remain outside this settings oracle.

Two separate performance runs each completed 18 transfers with exact independent
physical cargo checks: legacy `se-manual-mtuuelmt-0cb7cf27` and sectional
`se-manual-mtuu10lf-e53a08a5`. Normal-mode maxima across three repeats were:

| 518-entity fixture boundary | Legacy ms | Sectional ms |
| --- | ---: | ---: |
| Source setup | 16.03 | 21.13 |
| Source scheduler | 17.99 | 21.61 |
| Destination setup | 50.83 | 38.38 |
| Destination scheduler | 25.16 | 38.41 |

Sectional destination setup runs inside its scheduler callback: these rows overlap
and must not be added. Controller-observed durations increased from 755–772 ms to
1,184–1,219 ms; that boundary excludes earlier source-initiated export. These runs
were not randomized between codecs, measured no client FPS, and establish no general
lag reduction. Native platform preparation remains a long callback. Keep the codec
off by default. Raw matrices and their hashes are in `evidence/performance-*.json.gz`
and `evidence/codec-performance-comparison-2.1.17.json`.

```powershell
node tests/manual/transfer-reliability/pipeline-transfer.mjs --cleanup-proof
node tests/manual/transfer-reliability/pipeline-transfer.mjs --run
node tests/manual/transfer-reliability/pipeline-transfer.mjs --analyze tests/manual/transfer-reliability/evidence/pipeline-overlap-2.1.17.json.gz
```

Overlap run `se-manual-mtuus1cw-3014b57a` passed three opposing 518-entity transfers
with controller capacity two and one combined Lua step per tick. Samples observed
two active transfers, never more than two; a duplicate submission reused its ID and
each operation imported once. Sources were absent and destination cargo matched
the independent expected inventory. Cleanup succeeded. This is bounded overlap
acceptance, not a crash test or evidence for capacity four.

Review subsequently reproduced mixed chunks from two same-name uploads in the
production Lua receiver. `tests/lua/chunk-operation-isolation.lua` fails against
the name/force key and passes with operation-specific keys. It also checks identical
retries and rejects conflicting chunks and changed metadata. This exact handler
regression uses Lua 5.2 stubs; the live overlap fixture uses distinct platform names.

Recovery acceptance adds `--lost-reply=source` or `--lost-reply=destination` to
`pipeline-transfer.mjs --run`. Each case submits two opposing 518-entity transfers
at capacity two, with sectional encoding enabled and one combined Lua step per tick.
The host executes the real deletion/release, withholds its successful reply, and
the runner kills and restarts only the disposable controller. No recovery timer,
cargo, gate, or receipt is edited. The oracle requires an actual retry, one import
per operation, exact cargo at the lost-reply boundary and after recovery, source
absence, usable destinations, and owned Docker cleanup.

Both cases passed on Factorio 2.1.17: source `se-manual-mtux4ym5-3cd4fdc7` and
destination `se-manual-mtux99lb-b8388224`. The raw reports are banked as
`evidence/pipeline-lost-source-2.1.17.json.gz` and
`evidence/pipeline-lost-destination-2.1.17.json.gz`; replay them with `--analyze`.
This proves these two sampled crash/reply-loss paths, not arbitrary crash timing.

The initial source run `se-manual-mtux05hj-d6186b62` ended observation roughly ten
seconds after restart, before the normal 30-second recovery loop. Its STOP output
is a harness termination error, not evidence that product recovery failed. The
corrected runner waits for completion within the original bounded loop. It neither
changes the recovery timer nor treats an interrupted admission record as completion.
The original report remains under `ci-artifacts`; it was not rewritten as a pass.

The intended deployment configuration also passed in `se-manual-mtuxf8ec-c3ce35b4`:
three opposing transfers with `--legacy`, capacity two, one Lua step per tick,
duplicate admission reuse, exact physical cargo, and successful cleanup. Its raw
report is `evidence/pipeline-legacy-2.1.17.json.gz`. The analyzer checks the observed
instance codec settings against the requested configuration.

The local cluster was then deployed through `deploy.ps1 -Scope plugin -KeepSaves`.
Both `predeploy-20260909-225110-939.zip` backups were confirmed before stopping the
instances; platform lists and player positions matched after reload and configuration.
Readback verified the new sectional module was loaded, the shared Lua limit was one,
controller overlap was two, and sectional encoding remained off. The controller
served the newly built web bundle. Local evidence is in
`ci-artifacts/lessons-preserving-deploy.log` and `lessons-postdeploy-world.json`.
This is a local deployment result, not a claim that PR CI ran on these changes.

Publication review checked the changes against main `936b5a18bd3113188578add5a2079ef428c46717`,
including queue ownership through recovery, duplicate admission/import guards,
operation-specific chunk isolation, scheduler fairness, codec frame validation and
legacy fallback, and beacon/configuration restoration order. No additional
production blocker was identified in that local review; it is not independent
reviewer approval. Offline replay of the retained legacy overlap, both lost-reply
cases, and the final settings comparison passed again before publication.
The shared scheduler is a job-step count, not a wall-clock deadline; unscheduled
setup and atomic native calls remain outside that guarantee. Capacity four and
arbitrary crash timing remain unproven. Sectional encoding remains off by default.

### Recovery and performance cases

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

The original save-local receipt design produced STOP on older-source restoration.
The retirement-journal follow-up passes the same sampled safety contract. Retain both
results; neither establishes universal crash safety. Contract version 2 also requires
source-crash recovery to complete, whereas version 1 only required sampled safety.

`aged-recovery-intent` withholds a real deletion reply, stops the controller, and changes
only that owned transfer's persisted `startedAt` to one day earlier. It then restarts the
controller and requires a real retry, one import, completed recovery and exact physical
cargo. It tests retention/reload behavior without waiting a day; it does not simulate
a day of Factorio ticks or change receipt capacity or recovery timers.

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

- `se-manual-mtt3ae7g-789d3838`: prototype **HARNESS_ERROR** before transfer. An invalid
  Factorio event registration prevented startup; cleanup succeeded. Corrected to the
  supported surface-creation event, retaining the creation epoch before the hub exists.
- `se-manual-mtt3iyih-1db46f1d`: prototype **HARNESS_ERROR** before transfer. Recovery
  functions were not registered in the remote interface; seed locks remained and the
  preflight refused them. Registration was corrected; cleanup succeeded.
- `se-manual-mtt3mop4-023b3790`: older-source restore **PASS**. Completed transfer first
  left only the destination. Reloading the earlier checkpoint restored a protected source;
  both subsequent observations retained one usable destination and exact physical cargo.
- `se-manual-mtt3qqj0-030e24a4`: source crash before save **PASS for safety and liveness**.
  Real source deletion was retried after loading the checkpoint; recovery completed with
  source absent, one usable destination, exact physical cargo and one import request.
  Both successful follow-up runs verified Docker resource removal.
- `se-manual-mtt46hbt-7d62d5ad`: aged recovery intent **PASS**. With only the stopped
  controller's matching `startedAt` changed to one day earlier, restart retried the real
  source deletion and completed with exact physical cargo and one import. Cleanup succeeded.
- `se-manual-mtt3yb2o-a3a8c621`: export callback follow-up matrix **PASS**, all 18
  transfers preserved physical cargo and required profiler records; cleanup succeeded.
  Capture/checks, serialization and publication now run on separate scheduler visits,
  and the source diagnostic output reuses the serialized JSON. Maximum callbacks for
  the 518-entity source scheduler were 76.12/71.47/75.42 ms (off/normal/debug), compared
  with 150.20/153.57/156.68 ms in the earlier run. This is a fixture comparison, not a
  universal speedup or a simulation frame-budget guarantee.

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

Follow-up matrix `se-manual-mtt3yb2o-a3a8c621`, maximum callback milliseconds:

| Fixture / boundary | Timing off | Normal timing | Batch timing |
| --- | ---: | ---: | ---: |
| 6 entities: source setup | 102.25 | 123.29 | 74.77 |
| 6 entities: source scheduler | 4.92 | 19.44 | 3.72 |
| 518 entities: source setup | 94.49 | 104.78 | 135.99 |
| 518 entities: source scheduler | 76.12 | 71.47 | 75.42 |
| 518 entities: destination setup | 55.39 | 53.34 | 52.51 |
| 518 entities: destination scheduler | 63.27 | 60.50 | 62.12 |

Large source setup, JSON encoding and destination tile work remain synchronous. The
small-fixture normal-mode spike and setup variation also remain visible; these three
repetitions do not isolate instrumentation overhead from host scheduling noise.
