# Testing & Verification

The single testing doc: how tests are classified and run (the Physical Truth Lab Standard), how transfer
fidelity is measured (the parity-verification model), and the hands-on E2E validation checklist. (Absorbed the
former `lab-tests.md`, `parity-verification-model.md`, and `E2E_TEST_GUIDE.md`.)

The evidence discipline and shared-cluster safety rules in [CLAUDE.md](../CLAUDE.md) still apply throughout.

- [The Physical Truth Lab Standard](#the-physical-truth-lab-standard)
- [How transfer fidelity is measured](#how-transfer-fidelity-is-measured)
- [Hands-on E2E validation](#hands-on-e2e-validation)

---

## The Physical Truth Lab Standard

The canonical standard for choosing, building, running, and promoting tests that depend on Factorio's physical
runtime. The goal is a reusable physical-truth corpus that replaces engine lore with version-pinned evidence,
exercises production behavior, preserves real failures, and exposes behavioral and performance drift over time.

### Test taxonomy

Choose the cheapest layer that can prove the claim. A directory name does not decide the category; the question
and the oracle do.

| Category | Question answered | Normal evidence |
| --- | --- | --- |
| Unit or contract test | Does isolated Lua, TypeScript, message, schema, or guard logic behave correctly? | Deterministic process-local assertions; no live Factorio world. |
| Integration test | Does the shipped system satisfy an already-established production contract? | The real production path plus an oracle independent of any production meter under test. |
| Physical lab | What does the pinned Factorio runtime actually do, and is the proposed contract valid? | A minimal physical fixture, controls-first rung, tick-stamped readings, and an append-only conclusion. |
| Drift benchmark | Did one stable fixture's production behavior change across versions or commits? | Production transaction analytics for the same fixture ID and revision over time. |

Static guards enforce repository rules across these categories; they are not substitutes for physical or
integration evidence.

### Legacy gallery save isolation

CI runs `gallery-suite` in its own fresh cluster; the remaining suites share a separate
cluster. The gallery's golden saves predate source recovery identities. Loading them after
other tests have retired platforms correctly triggers the unidentified-save guard. Run
34288000057 reproduced this refusal; the original instance snapshots were restored.

The gallery loader now checks both external recovery journals before replacing either world.
It requires empty retirement history and refuses missing or malformed authority. Use fresh
disposable instances for this fixture; never clear an existing recovery journal to run it.
Both CI partitions are required to cover the full suite. Their artifacts are
`instrument-reports-gallery` and `instrument-reports` (failure bundles use the same suffix).
Completed source-deletion receipts remain in ordinary fixture worlds for replay protection;
preflight accepts them only with completed deletion evidence and an absent source surface
and platform. Pending locks, holds and unresolved receipts still refuse a fixture.

### Pipeline timing baseline — 2026-09-07

These are observed command/job durations, not Factorio processing time. Two successful CI runs
provide the initial baseline: [34064616979](https://github.com/solarcloud7/clusterio-surface-export/actions/runs/34064616979)
and [34048463170](https://github.com/solarcloud7/clusterio-surface-export/actions/runs/34048463170).
They ran different revisions on hosted runners; the ranges are two observations, not percentiles
or a controlled before/after benchmark. Neither run includes the current local circuit fix.

| Layer or method | Observed elapsed time | What is included |
| --- | --- | --- |
| CI fast-check job | 1m07s–1m09s | Checkout/setup, dependency install, guards, plugin/root unit tests and gateway Lua tests |
| CI plugin unit-test step (latest run) | 14s | Node compilation and unit execution |
| CI root unit-test step (latest run) | 20s | Repository tooling/manifest/fixture contract tests |
| CI gateway Lua step (latest run) | 8s | Lua setup and both gateway layouts |
| CI integration job | 16m51s–18m55s | Cluster provisioning, readiness, browser setup, sequential tests, teardown |
| Sequential live integration tests | 14m22s–16m08s | 36 suite subprocesses, including their own fixture construction, waits and cleanup |
| CI integration overhead outside those suites | About 2m29s–2m47s | Build, images, seeding, readiness, browsers, runner overhead and teardown |
| Warm local plugin unit command | 7.31s | Docker startup, cached build dependencies, TypeScript compilation and tests; test execution itself was 4.00s |
| Local installed memory experiment | 15.48s | Preflight, construction, cleanup proof, six physical checks and final cleanup |
| Local coupled-memory transfer experiment | 27.78s | Constructor cleanup proof, stable-source checks, real transfer, downstream readback and final cleanup |
| Local latch/counter transfer regression | 29.43s | Fixture construction, payload inspection, real transfer, running-counter observations and cleanup |
| Local powered/unpowered regression | 67.33s | Real power-status checks, deliberate power-deadline observation, original-rule checks and cleanup |
| Local save-preserving plugin deployment | 65.95s–72.09s | Build, both save backups/reloads, controller restart and preservation checks; this is deployment cost, not a test |

Largest individual CI suites across those two runs:

| Suite | Observed seconds |
| --- | --- |
| belt-freeze (removed) | 65.9–100.8 |
| latch-rearm-liveness | 64.4–65.8 |
| gallery-suite | 56.0–60.9 |
| platform-paused-restore | 49.6–52.2 |
| config-attrs | 42.2–70.9 |
| belt-item-state | 36.4–72.0 |

The historical liveness test contained 55.5 seconds of fixed sleeps. Its replacement removes
those sleeps and checks exact powered memory, unpowered failure, original rules and measured
tick boundaries. The production 1800-tick power retry was removed after a real transfer showed
readiness at the first seed callback (two ticks after scheduling). Before and after that change,
the fixture restored memory in six ticks. The replacement live test took 9.80 seconds locally,
including construction-failure cleanup proof and final cleanup, versus the earlier local 67.33
seconds. This is a test-runtime observation, not a production speedup or a new CI measurement.
Pause preservation is now checked on existing transfers: `ghost-tags` explicitly arms a paused
source; `ghost-item-requests` arms an unpaused source. Both independently read destination
`paused` and platform state, then read again on a later tick after verifying source deletion.
The standalone `platform-paused-restore` runner, its ungraded power rig, two 15-second waits,
and the source-text-only plugin tests were removed. Both modified suites passed locally;
production validation was not changed and no new transfer or fixed sleep was added.

Five read-only local control requests took 701–752 ms each (median 705 ms). This measures
the whole `docker exec` + fresh `clusterioctl` process + RCON request/reply path, not wire latency
or Lua execution alone. Raw samples: `ci-artifacts/test-rcon-roundtrip-timing.json`. Repeated
CLI startup is therefore a concrete candidate for measurement and connection reuse; its share
of each suite has not yet been instrumented.

Next optimization work should measure setup, RCON/CLI round trips, observation waits, actual
transfer and cleanup separately inside the slow suites. Then replace surplus fixed padding
with bounded condition/tick checks, reuse a control connection where measured startup dominates,
and run focused suites during development using `--only`. Keep the full regression gate.
Do not parallelize suites that mutate the same two instances. Sharding would require independent
cluster data and explicit ownership, and is not part of this change.

Breakdown of the 16m51s integration job (run 34064616979):

| Portion | Seconds |
| --- | ---: |
| Run integration suite | 864 |
| Start cluster, seed saves, verify instances | 82 |
| Pull Docker images | 21 |
| Build plugin | 20 |
| Root dependencies and browser cache/install | 15 |
| Remaining setup, teardown and timestamp granularity | 9 |
| **Total** | **1011** |

The 36 child-suite durations sum to 861.7 seconds; the surrounding step takes 864 seconds.
The eight largest suites account for 414.6 seconds (6m54.6s). The four canvas suites plus
log-evidence total 59.3 seconds. The main cost is shared-game tests, not browser rendering.
The runner deliberately uses synchronous child processes because these suites share mutable
instance/save state.

Existing timestamped CI output permits further attribution, with an important limit: intervals
between log messages are inclusive envelopes, not instrumented processing spans.

- **belt-freeze (removed):** the historical runs below include this retired experiment.
  Its CI wrapper and research helpers have been removed; restoration, item-state and batching tests remain.
- **latch-rearm-liveness, historical 65.8s:** 55.5s of explicit sleeps (5 + 2.5 + 6 + 42), plus
  construction, status reads, CLI/RCON and cleanup. The 42s sleep alone occupies about 65%
  of this suite. That timeout policy and these fixed sleeps have since been removed;
  the replacement checks successful restoration and non-evaluating failure directly.
- **gallery-suite, historical 56.0s:** reloads both golden saves, pushes/verifies the fixture roster,
  tests a successful transfer, forced rejection/rollback and a refused upload, then restores
  both live saves. Log envelopes are about 13.3s for initial load/preflight, 5.2s for the two
  roster pushes, 9.7s for successful-transfer observation, 5.5s for refusal observation,
  4.1s for rejected upload, and 13.4s from the final server-alive check through restoration.
  These include control calls and polling; they are not pure transfer processing durations.
  The current suite retains pad, transfer and rollback checks. The duplicate rejected-upload
  case now belongs to `upload-import-verdict`, which also checks the exact missing-position
  error. Its large legacy JSON fixture was deleted. Save handling now snapshots the current
  worlds before loading golden fixtures and restores those snapshots afterward, rather than
  replacing the developer's worlds with golden saves. Snapshot verification adds work; no
  net runtime improvement is claimed without a new comparable measurement.
- **platform-paused-restore, historical 52.2s (removed):** two cases, each watched for 15 seconds
  after arrival. Those two windows alone are 30 seconds. Each transfer-to-terminal observation
  takes about 4.3 seconds; each post-arrival read/wait/read envelope about 17.6 seconds.
- **config-attrs, 42.2s:** broad attribute checks plus a cloned 1,359-entity platform.
  Clone/ready log envelopes total about 10.5s; the transfer/arrival envelope is about 14.8s,
  and the final cleanup verification includes about 4.6s. Its older run took 70.9s.

<details>
<summary>All 36 suite durations from run 34064616979</summary>

| Suite | Seconds |
| --- | ---: |
| belt-freeze (removed) | 65.9 |
| latch-rearm-liveness | 65.8 |
| gallery-suite | 56.0 |
| platform-paused-restore | 52.2 |
| lab-force-resurrection | 48.1 |
| transfer-shaped-upload | 42.5 |
| config-attrs | 42.2 |
| one-of-each-sweep | 41.9 |
| belt-item-state | 36.4 |
| inventory-item-state | 35.9 |
| mining-progress-gate | 34.8 |
| inactive-drill-transfer | 31.5 |
| latch-rearm-adversarial | 28.9 |
| loader-freeze | 27.4 |
| segmented-unit-sleep | 26.5 |
| engine-invariants | 23.3 |
| canvas-motion | 21.4 |
| lab-paste-conflict | 20.8 |
| upload-import-verdict | 20.6 |
| log-evidence | 19.2 |
| hub-request-sections | 18.1 |
| gateway-config-chunking | 16.4 |
| ghost-tags | 15.0 |
| ghost-item-requests | 11.8 |
| gateway-park-proxies | 9.6 |
| canvas-locking | 8.8 |
| surface-delete-rebroadcast | 8.7 |
| unarmed-fluid-registry | 8.1 |
| canvas-drag | 5.6 |
| canvas-navigation | 4.3 |
| evacuation-coverage | 4.0 |
| descending-pod-overflow | 2.8 |
| pole-copper-prune | 2.2 |
| fluid-segment-law | 2.1 |
| selftests | 1.6 |
| gateway-lock-state | 1.3 |

</details>

The existing integration runner prints per-suite seconds. For local whole-command measurements:

```powershell
node tools/tests/measure-command.mjs ci-artifacts/my-test-timing.json -- node tests/integration/latch-rearm-adversarial/run-tests.mjs
```

This wrapper uses a monotonic clock, records UTC correlation timestamps, includes setup and
cleanup, and preserves nonzero exits. Its JSON omits command arguments to avoid recording tokens.
Raw CI job/step metadata, logs and the extracted suite table are retained under
`ci-artifacts/pipeline-ci-*` and `ci-artifacts/test-pipeline-baseline.json`. The experiment directory
retains its own physical evidence; these wall-time records must not replace those oracles.

`lua5.2 tests/lua/restore-behavior.lua` loads the production deserializer and connection-restoration
module with small entity/connector doubles. It checks failed inventory and display writes, connection
replay, positional target lookup, and pruning of real and ghost copper connections. It runs in CI
alongside the gateway Lua tests. These are Lua unit tests; real engine behavior remains covered by
the existing `config-attrs` and transfer integration suites. The inventory-bar behavior cases replace
the former source-text ordering assertion in `restore-rules-safecall.test.cjs`.

Controller persistence is separated into `lib/export-storage.ts` (stored export loading, identity
migration, and writes) and `lib/controller-audit.ts` (audit migration, indexing, and append handling).
`test/controller-persistence.test.cjs` verifies real temporary-file round trips, damaged audit lines,
late start records, and write failures. The controller retains its existing entry points, and its
existing recovery and replay tests continue to exercise those entry points.

### Physical Truth Lab mission

A physical lab converts an uncertain engine-dependent claim into version-pinned, reproducible evidence. It is
mandatory when a design depends on engine behavior that is not empirical at the current pin, when physical
measurements disagree, when an explanation relies on uninspectable internals, or when the engine pin changes.

Each lab starts with a falsifiable question and the cheapest control that establishes the measuring instrument.
It isolates one variable per rung, records negative and unexplained results, and never promotes a plausible
mechanism explanation into engine law merely because the observed behavior is consistent with it.

### Baked fixture contract

Repeatable physical tests use dedicated, paired golden saves: a source save containing the fixtures and a
destination save without conflicting platform identities. Fixture construction belongs in the save-building
workflow, not in the test runner.

Every fixture has:

- a stable fixture ID and revision;
- a human-readable purpose and owning test;
- the Factorio version and exact enabled-mod set;
- a source/destination role and physical invariant;
- a minimal machine-readable fingerprint; and
- provenance when derived from an incident or failure black box.

A platform or surface name is a lookup label, not sufficient destructive identity. A fixture revision changes
whenever its physical state or expected invariant changes, and longitudinal results from different revisions are
never compared as one series.

#### Storage and bake-time configuration

Golden saves are committed to this repository under `docker/seed-data/lab-saves/`, beside their machine-readable
manifest — the live cluster is never the only copy of the corpus. A save is baked WITH the plugin configuration
it is meant to carry: `on_init` defaults apply only to fresh saves (debug mode lost after save
reset), so a configuration default added after a save was baked never reaches that save without a deliberate
re-bake or an explicit migration step recorded against the fixture revision.

#### Golden saves across engine pins

Golden saves are NOT re-baked when the Factorio pin bumps (owner ruling). Loading the existing save on the new
engine and accepting its save migration is the deliberate policy: it exercises exactly what players' saves
experience, the baked states are stable and human-inspectable, and re-baking from scripts would not by itself
prevent migration-class drift. Watch release changelogs for migration risks before a pin bump, and rely on the
engine and mod pins recorded in every longitudinal summary to attribute migration-coincident drift. A fixture
revision does not change merely because the engine migrated the save; it changes when the physical state or
expected invariant is deliberately edited.

#### Minimality

A fixture contains the smallest physical state that proves its invariant. A large fixture is allowed only when
scale, capacity, batch size, or a workload boundary is the named variable and evidence shows that size is causal.
Historical reproductions may remain large until minimization preserves the failure; "small plus large" is not a
default test pattern.

#### Standard fill harness (belt fixtures)

The standard instrument for populating a belt fixture is an **infinity chest (filtered, `at-least N`) feeding
a filtered loader** onto the circuit. It saturates the circuit to a deterministic steady state, needs no
hand-seeding, and reproduces natural kinetic compression — the hardest restore case. The recipe is buildable
from script: `tests/instruments/loader-freeze/run-rung.mjs` constructs it on a throwaway clone. Operational facts:
loaders keep running on paused platforms, and belts keep moving, so census reads must be same-execution.
**Freeze the feed with `disabled_by_script = true`, NOT by writing `active`.** [empirical, 2.1.11,
tests/instruments/loader-freeze/run-rung.mjs 2026-08-12: on a turbo-loader the write reads back `true`,
status becomes `disabled_by_script`, and 0 items feed over a 221-tick window versus 4 in the control and
re-enable arms.] This paragraph used to say
the loader's `active` flag is writable and to deactivate loaders for a measurement window; that is FALSE at
the 2.1.11 pin — measured 2026-07-31, assignment throws `LuaEntity::active is read only.` on a loader and on
a crafter alike (it was `RW` at 2.0.77). Any instrument still built on the old recipe does not work. Clone the chests WITH the fixture
(`infinity_container_filters` + `remove_unfiltered_items` copy cleanly) so a cloned fixture remains
self-sustaining.

### Test-foundation pads and the in-game runner

Every positional fixture on the golden omnibus (`lab-omnibus-state-v1`) lives on a **test-foundation pad**: a
26x12 stamped cell whose canonical tile/trio source is `tests/lab-gallery/test-foundation.mjs`
(`seed-prep-ops.lua stamp_test_cell` is its bake-side port). A pad has a 12x12 build area holding the fixture,
a divider column, and a clear compare area for paste-and-audit runs. Its border row carries the **status
trio**: a description display-panel rendering the fixture's LAW/ACTION/EXPECT/FORBIDDEN card (single card
source: the fixture's `testCard` in `tests/lab-gallery/manifest.json`), a constant combinator with
`signal-check`/`signal-deny` sections (both inactive is the waiting state), and a red-wired status
display-panel whose messages render Success, `Failure {failure-message}`, or a waiting clock — with
always-show-in-alt-mode and show-tag-in-chart set. A name rendering text sits at origin+(6,-1.5): blue while
waiting, green on pass, red on fail.

The pads occupy a hub-adjacent, walkway-joined grid — columns x=8/36/64/92, rows y=-20/-6/8/22 — so the whole
test floor is visible and walkable from the hub without the editor. `omnibus-platform-schedule` is the one
hub-state fixture: non-positional, exercised by transfer rather than by a pad.

`/test-clear` and `/test-run` are the in-game runner pair. Discovery is structural: a cell is a name text at
the pad offset plus a present trio. Per cell, `/test-run` resets the compare area and trio, drives a
selection-lab copy of the build area, pastes at +14,0, and physically audits both halves (audit windows stop
at oy+11 so the trio never counts itself). Failures carry named conflict details — entity, position, blocker —
into both chat and the status panel's `{failure-message}` slot. The runner tests real contracts through the
production serialize/create/restore paths: its first full night (2026-07-18/19) surfaced 13 defects, including
two measured transfer losses (item-request-proxy drop; display-panel configuration strip) that the strict
item/fluid gate is structurally blind to.

Engine limitation: rendering texts (the pad name labels) are script state and cannot ride a transfer; delivery
tooling (`tests/lab-gallery/deliver-all-fixtures.mjs`) redraws them from the manifest after a pad platform
is delivered.

### Declarative reads — one verify list, every runner (2026-07-26)

A fixture whose `lifecycle.verify` carries dest-end `physical_read` checks needs **no bespoke meter and no
dispatch entry**: `/test-run` evaluates the same declared checks on both pad halves (left at dx 0, paste at
dx 14) that the gallery suite (`tests/integration/gallery-suite/run-tests.mjs`) evaluates on a real transfer's
destination. The `property` read takes a dotted path walked by INDEXING only (`temperature`,
`burner.remaining_burning_fuel`, `force.bulk_inserter_capacity_bonus`). The other declared reads are `item_count`,
`held`, `crafting_progress`, `spoil_percent`, `fluid`, `fluid_stats`, `infinity_pipe_filter`, `belt_stats`,
`entity_present`, `platform_present`, `surface_entity_count` and `surface_entity_count_stable` (the
`PHYSICAL_READS` set in `tests/lab-gallery/manifest.mjs`). Method-shaped reads (`get_recipe()`, `get_module_inventory()`, circuit sections) keep bespoke meters —
extending the walk to call methods would trade away its injection-unrepresentability.

**Promoting or adding a pad assertion is a `tests/lab-gallery/manifest.json` edit alone.** The workflow:

```powershell
# 1. measure the live value first (never author an expected value from memory):
node tools/tests/testkit/cli.mjs probe lab-omnibus-state-v1 'heat-pipe@43,-13:temperature'
# 2. declare the same path in the fixture's lifecycle.verify (op eq, or approx for progress doubles)
# 3. re-push the roster and run it:
node tests/lab-gallery/push-roster.mjs --instance clusterio-host-1-instance-1
./tools/clusterio/rcon.ps1 11 "/test-run <name-filter>"
# 4. teeth: sabotage the expected value by one unit, confirm RED, restore (di-change discipline)
```

Fail-closed rules baked into the path for a fixture WITHOUT a bespoke `DISPATCH` entry: zero evaluated
physical reads is a FAIL, never a vacuous green; a typo'd path fails the check carrying the engine's own message
(pcall-caught; a nil resolution reports "resolved NIL", never a pass). A `DISPATCH` fixture's declared reads
run once, at dx 14, through `run_verify` with no zero-read guard — its bespoke meter is what keeps it honest.
Ambiguity is NOT refused by the runner: the anchor locator reads the first entity of the anchor's name inside a
0.6-tile box (`find_at` in `module/utils/lifecycle-engine.lua`), so two same-name entities in that box read
whichever the engine lists first; only `testkit probe` refuses a multi-match, and the "matches N anchors"
refusal is about duplicate anchor NAMES in the manifest. Anchor entities that stand alone in their box. The
check name carries the property path (`heat-pipe.property(temperature)`), so two reads on one pad are
distinguishable in a failure.

### Single-use batch lifecycle

A certified baked-fixture batch follows this lifecycle:

1. Use a dedicated source/destination pair or acquire an exclusive lease on both instances before replacing any
   save. Refuse the batch if either instance has an instance-wide game tick pause, job, lock, hold, tombstone, or
   other in-flight operation; never clear or unpause that state to make preflight pass.
2. Load the paired golden source and destination saves via Clusterio-native save assignment, on both instances
   in lockstep.
3. Poll both instances to readiness, verify the expected save/fixture revision, require
   `game.tick_paused == false`, and require zero transient plugin state.
4. Resolve the exact named fixture and verify its minimal fingerprint.
5. Invoke the real production operation, such as `/transfer-platform`.
6. Capture the production transaction ID and wait for its terminal production record. An unexpected
   `cleanup_failed` result aborts the batch.
7. Consume the next untouched baked fixture without cleaning, cloning, rebuilding, or resetting the prior one.
8. In an unconditional finalizer on success or failure, reload both golden saves, poll readiness, and re-verify
   the save revisions, unpaused state, and zero transient plugin state before releasing the instance pair.

Within a loaded batch, every baked fixture is single-use. A runner must not clone platforms, construct the
physical case, scan prefixes for cleanup, delete prior fixtures, directly clear plugin storage, or unpause a game
it did not pause. Tests that require incompatible global state use a different golden-save pair.

**Failure attribution (owner ruling).** A production operation that reaches a terminal verdict —
including a failed frozen verdict with its banked black box — is a valid FAILED result. Before consuming the
next fixture, the runner re-verifies the same preflight it required at load (game unpaused, zero transient
plugin state). The first fixture whose run leaves that preflight unsatisfiable ends the batch: the runner
reloads the golden pair and reports every unconsumed fixture as **BLOCKED**, a status distinct from FAILED.
One real failure must never read as ten; no repair of hostile state is permitted to keep a batch alive.

There is no between-run cleanup for baked fixtures. Reloading the certified save pair is the normal reset. This
does not retire cleanup-specific tests, and it does not authorize a legacy probe to leave state behind on the
shared mutable cluster: runners outside the certified baked lifecycle continue to follow the zero-leftover rules
in [CLAUDE.md](../CLAUDE.md).

### Measurement and evidence

Use the production transfer record as the canonical operational-drift record. Do not add a second stopwatch,
entity count, percentile calculation, or phase total that merely remeasures fields already produced by the
production analytics. Compare a fixture only with earlier results carrying the same fixture ID and revision.

The longitudinal harvester stores a provenance envelope alongside the untouched production summary: the
preflight-verified fixture ID and revision, source/destination golden-save fingerprints, production transaction
ID, plugin commit, and Factorio/mod pins. This envelope supplies identity and provenance; it must not copy,
recompute, or reinterpret the production measurements.

Independent physical grounding is required when the serializer, restorer, validator, gate, or analytics meter is
itself under test. In that case, measure through an independent physical API and adjudicate the production verdict
before reading a destination that failure handling may have discarded. A benchmark whose subject is operational
drift does not duplicate the production analytics with a parallel runner-owned meter.

On a failed frozen verdict, retain and reference the production failure black box. It is the durable incident
artifact for the replay payload, physical destination state, diffs, and available restoration attribution. A
successful transfer uses its production validation and transaction analytics; it does not manufacture a failure
black box for symmetry.

Engine knowledge lives in executable form, not tagged prose. The `[empirical, <pin>]` tag convention is
RETIRED (owner ruling 2026-09-05; the [API] and [hypothesis] tiers were abolished 2026-07-31): tags let
prose certify itself — pins moved while tags stayed green, and audited tags cited probes that had not
isolated the claimed variable. A prose engine claim is a lead. Authority is a rung in `tests/instruments/`
that re-measures the fact, an upstream <https://lua-api.factorio.com/> page linked at the point of use
(never mirrored — a mirror rots when upstream moves), or a fresh measurement in the PR that needs the fact.
Tags remaining in older docs are historical markers, not certification — re-measure before relying on one,
and mint no new ones. A negative result is evidence, and an eliminated symptom without an isolated mechanism
remains unexplained rather than being retconned into a proven fix.

**Citation-variable match.** A measurement backing a MECHANISM claim must have isolated **that claim's
variable** — citation presence is not citation match. The refuted "set_stack fails while deactivated"
lore wore a GROUNDED empirical stamp citing rungs that isolated force bonus, never activation. Corollary
for instruments: **a probe harness may not embed the ritual under test** — a probe that runs "briefly-active,
mimicking production" is structurally blind to the activation variable it exists to examine. When a claim names
a variable, at least one rung must hold everything else constant and flip exactly that variable.

**Bundled-fix attribution.** When a green fix ships multiple changes together, each component stays individually
`[unverified]` until a kill-measurement separates causal from cargo — a fix that works does not certify every
part of itself.

### Promotion and recertification

Once a physical lab settles a contract, promote that contract into an integration regression that exercises the
shipped production path and has an independent red tooth. Preserve the append-only notebook and original evidence.
Retain only the minimal live rung needed to recertify engine-dependent behavior; do not keep exploratory setup in
the integration runner.

**The bake gate (owner ruling).** A lab conclusion is not SETTLED until its decisive fixture is
baked into a golden save and the conclusion reproduces from the loaded save. A freshly constructed world and a
save-loaded world are not automatically identical — save/load changes entity registration, storage identity, and
`on_load` paths — so the reproduction gate catches contracts that hold only in the built-at-runtime state before
they become permanent regressions. Labs iterate freely with disposable state while investigating; the baked
lifecycle binds the permanent layers (integration and drift), and this gate is the bridge between the two.

An engine-version change invalidates every measurement taken on the old pin. Re-measure the law you are about to
rely on, in the PR that relies on it, against the engine actually running — restoring an archived runner from the
`labs-archive-2026-07-19` git tag or authoring a fresh probe. **There is no certificate file and no
version-certification lint** (both deleted 2026-07-31, owner ruling): a committed record asserting that a campaign
re-measured "every law production depends on" is unfalsifiable, and the last one was caught claiming laws whose
cited pads never exercised them. A measurement stands on its own or not at all. Promotion never upgrades a
hypothesis or unexplained observation into law.

See [`tests/README.md`](../tests/README.md) for the repository test layout and entry points.

---

## How transfer fidelity is measured

How the plugin compares captured and restored items and fluids, which instruments it uses,
and where their coverage ends. Read this before trusting, extending, or auditing a fidelity claim.

### Cargo integrity: scope and boundaries

Cargo integrity checks conserved quantities during a transfer. It is not a post-run test
or a complete entity-state comparison. The two runtime checks cover different boundaries:

| Check | Comparison | Failure behavior |
| --- | --- | --- |
| **Source cargo integrity** | Each captured entity's live cargo vs its serialized cargo, read in the same Lua execution | Mismatch or unavailable required read aborts export before destination contact |
| **Destination cargo integrity** | Original payload expectations vs physically restored cargo, before activation and source deletion | Mismatch or unavailable required read rejects the destination attempt |
| **Historical post-activation cargo report** | A second physical count retained in older records | Removed from new transfers after the audit below; never authorized source deletion |

[Source cargo integrity](../docker/seed-data/external_plugins/surface_export/module/export_scanners/source-cargo-integrity.lua)
checks the source-to-payload boundary.
[Transfer validation](../docker/seed-data/external_plugins/surface_export/module/validators/transfer-validation.lua)
checks the payload-to-destination boundary. A destination matching an incomplete payload
cannot detect the original source omission.

### How quantities are read

The [cargo counter](../docker/seed-data/external_plugins/surface_export/module/validators/cargo-counter.lua)
reads inventory and transport-line `get_contents()` directly. It does not reuse the
serializer's rich inventory/stack extraction. Both engine APIs return item name, quality and count
([LuaInventory](https://lua-api.factorio.com/2.1.17/classes/LuaInventory.html#get_contents),
[LuaTransportLine](https://lua-api.factorio.com/2.1.17/classes/LuaTransportLine.html#get_contents)).
Held and ground stacks use name, quality and count. Aliased inventory slots are counted once.
Fluid segment IDs prevent counting the same segment repeatedly.

Item quantities compare by name and quality. Fluid quantities compare by fluid name, with
an absolute tolerance of 1e-6; temperature keys are retained as evidence but are not a
temperature-fidelity verdict. Ground items have a dedicated destination pass; the source
paired per-entity check does not independently validate the separate ground-item export pass.
Shared enumeration and key conventions remain possible common failure points. This is not a
claim that all item metadata, entity properties or supported inventory types have been independently tested.

Required read exceptions propagate as `measurementAvailable=false`, with errors and no
invented actual totals. Source read failures are sticky for the job. The instance also refuses
to forward success when measurement availability is explicitly false.

### What can authorize source deletion

Original cargo expectations are preserved. Failed-placement cargo, inventory overflow and
rejected fluid writes remain loss evidence; they are not subtracted to make a shortage pass.
An ordinary failed entity also rejects restoration when it contained no cargo. The
test-only forced-failure flag does not supply a separate verdict policy.

The instance requires explicit Lua success and both item/fluid match flags. The controller
then requests source deletion and completes only after its successful acknowledgement.
Belt structural checks remain separate vetoes. Historical post-activation diagnostics do not override
this decision. A successful cargo comparison does not prove schedules, circuit state,
crafting progress, health or other entity settings were restored.

The destination count is synchronous in the completion callback. It is not currently
batched across ticks. Belts can move between callbacks, so yielding during a comparison
requires a consistent snapshot design; moving the check into CI is not equivalent protection.

### Removed duplication and compatibility

The earlier import phase census was diagnostic attribution only. Its baseline, hub,
inventory and held-item recounts did not control any verdict and were removed, along with
their logs and metrics. The separate post-activation recount and its per-type breakdown were also removed.
No measured performance improvement is claimed.

Current module names and displayed labels say cargo integrity or cargo count. Legacy
`job.census`, `census_*` event/debug fields and timing stage IDs remain compatible with saved
jobs, historical records and fixtures. An entity count is still separate from cargo integrity.

### Verification of the cargo-integrity correction (2026-09-07)

The pre-change controlled probe reproduced three false-success paths: a swallowed read error
with empty expectations, an omitted inventory hidden by a shared serializer helper, and
known losses subtracted from original expectations. It also showed that the forced-placement
test override was stricter than ordinary empty-entity failure.

The permanent [Lua regression](../tests/lua/cargo-integrity.lua) now requires rejection in
those cases. It executes production counting, source comparison, destination validation and
completion policy with controlled engine objects, stopping at verdict storage. It also covers
quality keys, inventory aliasing, belt quantities, held/ground stacks and shared fluid segments.
It does not exercise live event transport or source deletion. CI runs it with Lua 5.2.

The save-preserving deployment passed version, surface/platform and player-position checks on
both Factorio 2.1.17 hosts. Live `ghost-tags` passed a real transfer and source-deletion check.
The [upload/import fixture](../tests/integration/upload-import-verdict/run-tests.mjs) passed
successful import, malformed-belt refusal, a 5,000-item mismatch, and an ordinary missing
request-proxy target. The last case kept matching cargo flags yet rejected for `entities`,
removed the destination and used no test-only verdict override. The original fixture remained;
this upload arm does not request source deletion and is not a two-phase rollback test.
Both runners cleaned their state and passed lease checks.

Local evidence: `ci-artifacts/cargo-integrity-deploy.log`,
`ci-artifacts/cargo-integrity-live.log` (including the first fixture-setup failure),
and `ci-artifacts/cargo-upload-live.log` (corrected fixture, all arms passed).
The final deployment also passed preservation checks (
`ci-artifacts/cargo-integrity-final-deploy.log`). The browser suite passed, including unavailable
cargo readings in the UI and downloaded diagnostics (`ci-artifacts/cargo-browser-tests.log`).
The plugin suite passed 622 tests with eight skipped; repository tests passed 429 with three
skipped; 48 targeted guards and the 124-file Lua syntax check passed. Full GitHub CI has not been run.
No benchmark or exhaustive coverage claim follows from these fixtures.

### Optional full destination snapshots

`surface_export.debug_destination_snapshot` defaults to false. With this and `debug_mode`
enabled on the receiving instance, successful validated transfers rescan the destination and
write `debug_destination_platform_<name>_<tick>.json`. It stays enabled until switched off;
it is not a one-shot capture. Instance settings are sent to Lua on instance start, so restart
the receiving instance after changing the saved setting. For a temporary live investigation,
the existing remote `configure` API accepts `debug_destination_snapshot=true/false`; a later
instance start reapplies the saved setting.

General debug mode alone still supplies the compact `debug_import_result` used by tests.
Transfer logs, cargo verdicts, timing, downloaded transaction reports and failure black boxes
do not require full snapshots. Failed imports skip this optional scan and use their black box.
This avoids a duplicate scan on failure. Snapshot scan/output errors leave the transfer verdict
unchanged and mark diagnostic timing failed. A failed black-box physical scan is explicitly
unavailable while retaining the verdict and replay payload.

Verified with dedicated Lua behavior checks and 622 passing plugin tests (eight skipped).
Live disposable transfers produced no full snapshot with the flag off and one with it on;
both retained compact results and successful transaction verdicts. Failed upload fixtures
retained physical black-box evidence and replay payloads without duplicate destination dumps,
even with the snapshot flag on. The flag was restored off and cleanup checks passed. Evidence:
`ci-artifacts/destination-snapshot-live.json`, `ci-artifacts/destination-snapshot-failure-live.log`.
The first wrapper checked files after fixture cleanup; the permanent fixture now checks their
contents before deleting them. Full GitHub CI has not been run.

### Post-activation recount audit (2026-09-07)

Removed the unconditional post-activation item/fluid recount, its mismatch-only rich per-type
scan, logs, profiler and phase registration. The required source and destination cargo checks
remain. Fluid-reconciliation arithmetic used by the destination validator remains; the old
`postActivationReport` DTO and recorded previews remain readable as historical evidence.

The recount ran after activation in the same callback, without a simulation tick. Activation
restores activity flags, repeats a conditional held-stack repair, queues mining-progress work
and reasserts segmented-unit state. Latch scheduling only queues later work. The held-stack
restoration already runs before cargo validation for transfer and standalone import paths.
The recount never affected the commit verdict, and cannot observe later latch or mining work.

In 48 retained reports, item-key counts and fluid quantities aggregated by name were unchanged
between the gate and recount. Historical `loss_analysis` execution readings on the large belt
fixture ranged from about 86 to 195 ms. These span earlier implementations, including the rich
counter; they are not a current benchmark or measured speedup from this removal. Raw evidence:
`ci-artifacts/post-activation-records.json` and `ci-artifacts/post-activation-analysis.json`.

The bounded [activation probe](../tests/instruments/post-activation/README.md) on Factorio 2.1.17
preserved 12 items (including a rare held item) and 100 water through the production activation
helper with zero elapsed ticks. A cleared held stack reduced the earlier counter to 11 items.
Injected-error and normal fixture deletion were independently checked. This is evidence for
the fixture, not a claim that every future activation API change is cargo-neutral.

Verification after removal: 621 plugin tests passed, eight skipped; 36 targeted phase/verdict
guards and the 124-file Lua syntax check passed. Save-preserving deployment passed on both
hosts. The live activation probe, a real ghost-tag transfer with source deletion, and all four
upload/import verdict arms passed with cleanup. The new successful record
`836570928:151_ghosttags-mtrrkrsr` has a passing 10-item cargo verdict and neither a
`postActivationReport` nor a `loss_analysis` timing span. Evidence:
`ci-artifacts/post-activation-live.json`, `ci-artifacts/post-activation-transfers.log`,
`ci-artifacts/post-activation-deploy.log`. Full GitHub CI has not been run.

### Freeze policy by entity family

Measurement and serialization are only meaningful against a non-moving target. Different entity
families require different freeze mechanisms, and several intuitive ones are measured
non-starters. Current policy, per family:

| Family | Mechanism during export/import | Anchor |
|---|---|---|
| Machines, inserters, turrets, most activatables | `entity.active = false` at lock time; original states recorded and restored on unlock/activation ([surface-lock.lua](../docker/seed-data/external_plugins/surface_export/module/utils/surface-lock.lua) `freeze`, [active_state_restoration.lua](../docker/seed-data/external_plugins/surface_export/module/import_phases/active_state_restoration.lua)) | code |
| Asteroid collectors | `entity.active = false` through the same lock/deactivation path; collectors are activatable and were measured frozen by the lock ([game-utils.lua](../docker/seed-data/external_plugins/surface_export/module/utils/game-utils.lua) `is_activatable_entity`) | code + measured |
| Belts (transport-belt, underground, splitter) | **cannot be deactivated — items keep moving on locked platforms** (measured); read in one atomic Lua execution instead ([async-processor.lua](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua) atomic belt scan; atomic belt scan, in [CLAUDE.md](../CLAUDE.md)) | measured |
| Cargo pods in flight | not frozen — **completed** by the lock before export scanning ("completes cargo pods", [export-pipeline.lua](../docker/seed-data/external_plugins/surface_export/module/core/export-pipeline.lua)); a mover is retired, not paused | code |
| Ground items (`item-entity`) | static entities; no freeze needed | code |
| Beacons (import side) | deliberately kept **active** through restoration so `crafting_speed` propagates to crafters before inventory refill (see "Import Phase Ordering" in [CLAUDE.md](../CLAUDE.md)) | code |
| Inserter held items (import side) | `restore_held_items_only` seats held stacks before exact validation; this helper does not toggle entity activation ([active_state_restoration.lua](../docker/seed-data/external_plugins/surface_export/module/import_phases/active_state_restoration.lua)) | code; `no_tick_sync_selftest` records tick and crafting-progress before/after |
| Whole platform (`platform.paused`) | parks held destinations; does **not** stop belt drift on the held surface (the observation behind Black-Box Discard's snapshot-then-delete design) | measured |
| Whole game (`game.tick_paused`) | labs and tests only; also halts the plugin's own async processing (`/step-tick` exists to step past it) | code |

The strongest freeze is not a pause mechanism at all: **within a single Lua execution, zero ticks
elapse and nothing in the simulation moves** (measured). Reads that
must be mutually consistent are placed in the same execution; freezing across ticks is required
only when work cannot fit in one execution, and then only the families above that support it.

### The guarantee boundary — read this before claiming "100%"

The gate's guarantee is precisely: **what was serialized equals what was restored.** It is *not*,
by itself, "what was on the source platform equals what is on the destination." The difference is
exactly the serializer-omission case: state the serializer never captured is absent from *both*
sides of the gate's comparison, so the gate passes while the state is lost with the deleted
source. The gate is an honest accountant working from a possibly-incomplete ledger.

Fidelity claims therefore live in two tiers with different protection mechanisms:

| Tier | State | Protection | Unknown-unknown exposure |
|---|---|---|---|
| **1 — countable** | items and fluids (conserved quantities the engine can total) | measurement: physical census on the destination (production gate) and on the source (paired runtime check) | a serializer omission is *detectable by measurement* wherever a census runs |
| **2 — non-countable** | circuit configuration, crafting progress, schedules, spoilage timers, health, energy, heat, … | enumeration: per-category handlers, per-dimension roundtrip fixtures, and static ownership/classification tests | no aggregate meter exists; an unenumerated dimension is silently absent and **no census can detect it** |

Consequences of the boundary:

- For tier 1, a census comparison converts any omission bug from *silent loss* into a *loud
  numeric mismatch* — but only on the side where a census actually runs. On the destination it
  runs in production; source entity cargo is also checked in production, with the ground-item limitation above.
- For tier 2, coverage is exactly the list of dimensions someone has enumerated and tested.
  "100% parity" statements should be scoped to tier 1 plus the enumerated tier-2 dimensions, never
  stated unqualified.
- Both tiers ultimately trust the engine's own meters. That trust is not axiomatic: the
  load-bearing engine facts above were measured in lab rungs before the gate was allowed to rely
  on them, and those measurements are only as current as the pin they were taken on — re-measure
  at a bump rather than looking for a record that says someone already did.

---

## Hands-on E2E validation

A hands-on, repeatable procedure to validate the surface_export plugin end-to-end on the local 2-host
Docker cluster: **export → controller route → import → validation → source cleanup**, plus the gateway,
passenger, upload-import, and failure paths.

This complements [QUICK_START.md](QUICK_START.md) (the happy-path *usage* intro) — this is the *QA/validation*
checklist. The single source of truth for "does it all work" is the automated suite below; the manual sections
exist to inspect, debug, or demo individual flows.

> **Shell note (agents / non-interactive):** the `rc11`/`rc21` profile aliases are interactive-only. Use
> `./tools/clusterio/rcon.ps1 11 "<cmd>"` (host-1) and `./tools/clusterio/rcon.ps1 21 "<cmd>"` (host-2). All commands below assume
> repo root and PowerShell 7 (`pwsh`).

### 0. What "pass" means

A transfer is **correct** when, on the destination, all of the following hold and the source platform is gone:
- **Entity count** equals the source (failed placements are tallied, not silently dropped).
- **Items and fluids are exact**: the strict gate requires exact per-key item counts and exact
  aggregate-by-name fluid volume (epsilon `1e-6`), against original expectations. Failed-entity
  losses and engine-rejected writes do not reduce those expectations.
- **Schedule** (records + interrupts + wait conditions) is preserved.
- The validation **gate passed** (`validation_success = true`) — this is the authoritative loss check.
- On failure, the source is **unlocked/rolled back**, never deleted (two-phase commit).

### 1. Prerequisites — bring the cluster up

```pwsh
docker volume create factorio-client-2117     # one-time
docker compose up -d                            # or: ./tools/clusterio/deploy.ps1 -Scope cluster -SkipIncrement -KeepData
./tools/clusterio/show-cluster-status.ps1                 # controller healthy + both instances running
```

Expect: `surface-export-controller`, `surface-export-host-1`, `surface-export-host-2` all **Up (healthy)**,
and both instances `running`.

If you changed plugin code first:
- **TS only:** `./tools/clusterio/deploy.ps1 -Scope artifacts -Target node -RestartHosts` (controller changes also need `-RestartController`)
- **Lua / full:** `./tools/clusterio/deploy.ps1 -Scope plugin` (rebuilds + resets saves to re-patch Lua + restarts)

### 2. Smoke test — plugin loaded, debug on

```pwsh
# Remote interface is registered (must print 'true'):
./tools/clusterio/rcon.ps1 11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"

# Debug mode on BOTH instances (writes debug_*.json artifacts used for inspection):
./tools/clusterio/rcon.ps1 11 "/sc remote.call('surface_export','configure',{debug_mode=true})"
./tools/clusterio/rcon.ps1 21 "/sc remote.call('surface_export','configure',{debug_mode=true})"

# Source platforms exist on host-1 (the seed 'test' platform = ~1359 entities):
./tools/clusterio/rcon.ps1 11 "/list-platforms"
```

> Note the per-force **unique index** from `/list-platforms` — it is the key for every command below
> (names can collide; the index never does).

### 3. Automated suite — the fastest full E2E (do this first)

One auto-discovering runner drives every `tests/integration/*` scenario against the live cluster. This *is*
the CI step, so a green run here ≈ a green PR.

```pwsh
node tools/tests/run-integration-tests.mjs --list           # see all scenarios
node tools/tests/run-integration-tests.mjs                  # full suite; see the measured timing baseline above
node tools/tests/run-integration-tests.mjs --only gallery-suite   # pad boards, transfer and rollback
node tools/tests/run-integration-tests.mjs --only 'fidelity|gate'      # regex filter
```

Expect the summary to end `N/N passed`. The scenario set is auto-discovered from
`tests/integration/*/run-tests.{ps1,mjs}` — `--list` prints the current roster. The roundtrip scenarios are
absorbed as pad fixtures on the lab-gallery save; their ownership is recorded in
`tests/lab-gallery/manifest.json`.

`gallery-suite` holds the shared workflow lock. It refuses connected players, active transfers,
holds, tombstones, paused ticks or pending circuit restoration before taking snapshots. Both
`pretest-gallery-suite-<uuid>-<host>.zip` files must exist with stable nonzero sizes before either
instance stops. A journal under `ci-artifacts/gallery-suite-save-session-<uuid>.json` records
their names and the pre-test world census. The suite restores those exact saves on success
or failure, then compares surfaces, platforms and player positions. Snapshot saves are retained;
only the suite's temporary golden save copies and markers are removed. A failed restore retains
the snapshots and reports failure. Offline tests cover partial loading, incomplete backups and
restore retries; the local seven-step gallery run passed with original-world verification.

The remaining sections reproduce individual flows **manually** for inspection/demo/debugging.

### 4. Manual happy-path transfer (host-1 → host-2)

```pwsh
# Pick a source index from /list-platforms (e.g. the 'test' platform). Then:
./tools/surface-export/transfer-platform.ps1 -PlatformIndex <idx> -Direction 1to2
```

This wraps the full `/transfer-platform` workflow (lock → export → route → import → validate → delete source
**or** rollback) and prints post-transfer state. Watch progress in chat/logs:

```pwsh
# Source side (host-1):  export progress + "Export Complete"
# Dest side  (host-2):  import progress + "Import Complete"
./tools/clusterio/rcon.ps1 21 "/list-platforms"     # platform now on host-2
./tools/clusterio/rcon.ps1 11 "/list-platforms"     # gone from host-1 (deleted on success)
```

For a clean repeatable source, clone the seed platform first (so you keep the original):

```pwsh
# clone_platform(source_index, dest_name) — source keyed on UNIQUE index, 2 args
./tools/clusterio/rcon.ps1 11 "/sc remote.call('surface_export','clone_platform', <test_idx>, 'e2e-demo')"
```

### 5. Validation & fidelity — prove conservation independently

Don't trust only the validator's self-report — cross-check with a **physical count**.

```pwsh
# A) The controller's transaction record for the latest transfer (or pass -TransferId <canonical-id>):
./tools/surface-export/get-transaction-log.ps1
#    look for: success, itemCountMatch=true, fluidCountMatch=true, and exact by-name totals.
#    Transfer validation is carried in the import-complete event; do not refetch it by platform name.
```

The conclusive artifact is the on-disk import result (debug_mode on):

```bash
docker exec surface-export-host-2 sh -c 'ls -t /clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_*.json | head -1'
# Inspect: validation_success, totalExpectedItems == totalActualItems, totalItemLoss:0, itemLossByType:{},
#          entityCount, failedEntityLosses (should be absent/empty), forceDataMismatches (raise-only warnings)
```

> **The transfer gate requires exact restorable data.** A flaky *held-item* sub-count is a measurement artifact, not loss —
> held items cycle belt↔hand and are craftable, so dst-held ≠ src-held at zero loss. Trust
> `totalItemLoss`/`expected==actual` + entity count, not a raw held sub-count. `get_item_count` is itself a
> complete physical meter (it includes belt + held items).

### 6. Export-only + upload-import (no source delete)

```pwsh
# Export to controller storage only (source stays put, then unlocks):
./tools/clusterio/rcon.ps1 11 "/export-platform <idx>"
./tools/clusterio/rcon.ps1 11 "/sc rcon.print(remote.call('surface_export','list_exports_json'))"

# Export to a disk file:
./tools/clusterio/rcon.ps1 11 "/export-platform-file <idx>"   # lands in host-1 script-output/

# Re-import a JSON file onto host-2 (chunks automatically; no source deleted):
./tools/clusterio/rcon.ps1 21 "/plugin-import-file <filename> <new_platform_name>"
```

Or use the **web UI** (§11) → the Gateways canvas: per-platform **Export JSON**, or the **Import** button.

### 7. Gateway transfer (Phase 1a)

```pwsh
# Park a platform at a gateway, then:
./tools/clusterio/rcon.ps1 11 "/gateway-transfer <idx> <dest_instance_id>"   # arrives paused at the gateway, hop stripped
# Or open the on-arrival chooser GUI (Model A):
./tools/clusterio/rcon.ps1 11 "/gateway-gui <idx>"
```

Automated coverage: the dedicated gateway-transfer runner was deleted 2026-07-27 (owner law: no
testing of WHEN a platform may teleport); the gateway selftests ride `tests/instruments/selftests`.
`gateway` self-test inside `tests/instruments/selftests`. `--only 'gateway'` alone matches the live test
ONLY and silently leaves the guard unrun.

### 8. Passenger evacuate (no hard block)

A transfer is **not** blocked when players/character bodies are aboard — they're **evacuated to Nauvis** at the
sole source-delete chokepoint before teardown. Validate via the suite:

```pwsh
node tools/tests/run-integration-tests.mjs --only passenger-evacuate
```

(Manual connected-player verification is tracked separately.)

### 9. Failure / edge cases (the safety net)

```pwsh
# The sabotage teeth (gate detects item/fluid loss, rollback, failed-entity attribution,
# force-bonus sync) are pad fixtures run through the REAL transfer by one suite:
node tools/tests/run-integration-tests.mjs --only gallery-suite
# Name-collision delete (platforms with same name → keyed on unique index, correct one deleted):
node tools/tests/run-integration-tests.mjs --only name-collision-delete
```

Manual lock/rollback inspection:

```pwsh
./tools/clusterio/rcon.ps1 11 "/lock-status"                  # show locked platforms
./tools/clusterio/rcon.ps1 11 "/unlock-platform <name_or_index>"
```

### 10. Persistence & observability

```pwsh
# In-game transaction dashboard (history + per-phase timing):
./tools/clusterio/rcon.ps1 11 "/transaction-dashboard 25"

# Controller persistence files (written atomically via safeOutputFile — should be valid JSON, no *.tmp):
docker exec surface-export-controller sh -c 'ls -la /clusterio/data/database/surface_export_*.json'

# Trace a transfer end-to-end (the aggregated JSON logs docker logs hides):
./tools/clusterio/check-cluster-logs.ps1
./tools/clusterio/check-cluster-logs.ps1 -Grep "transfer|validation|fail"

# Prometheus metrics:
docker exec surface-export-controller sh -c 'curl -s http://localhost:8080/metrics | grep ^surface_export_'
```

Log homes (see [CLAUDE.md](../CLAUDE.md) "Observability"): controller `/clusterio/logs/cluster/cluster-*.log`
(best single stream for a cross-instance transfer), host `/clusterio/logs/host/host-*.log`, Factorio
`/clusterio/data/instances/<instance>/factorio-current.log`, debug dumps in that instance's `script-output/`.

### 11. Web UI walkthrough (per-feature checklist)

Open `http://localhost:8080` → **Surface Export** in the sidebar (auth: `./tools/clusterio/get-admin-token.ps1` copies a
login token). The page has two tabs — **Transaction Logs** and **Gateways** — and a live WebSocket feed (no
manual refresh needed). Export and import live on the Gateways canvas: per-platform **Export JSON** in an
instance's platform list, and the top-left **Import** button. Tick each feature:

#### 11.1 Page shell & live updates
- [ ] Page loads; the plugin **version** shows under the title; the **Surface Export** sidebar entry is present.
- [ ] Both tabs render. Switching tabs updates the URL (`?tab=logs` / `?tab=gateways`); pasting
      `…/surface-export?tab=logs` opens straight to that tab, and an unknown `?tab=` lands on Gateways.
- [ ] **Live**: start a transfer from RCON/CLI and watch the Gateways canvas **and** the Logs tab update on
      their own, with no page reload (WebSocket subscription).
- [ ] **Permissions**: a user without the log-view permission sees the **Transaction Logs** tab hidden and the
      page still loads (the subscription downgrades gracefully — no error toast).

#### 11.2 Gateways canvas — platform list
- [ ] Clicking or hovering an instance opens its platform list; it auto-hides a few seconds after release.
- [ ] Only platforms with a space hub appear, and **every** one is listed — there is no row cap and no
      "+N more" row.
- [ ] Each row shows the platform **name**, its **location** (a space body, `→ <target> (ETA ~N min)` while
      flying, or *in transit*) with a **planet icon**, and an **orange "locked" tag** when the platform is
      locked (e.g. mid-transfer).
- [ ] **Export JSON** (download icon on each row) → a `<platform>_<timestamp>.json` file downloads and a success
      toast shows the export id. Source is **not** deleted (export-only).

#### 11.3 Gateways canvas — starting a transfer
- [ ] Drag a platform row's handle onto another instance's gateway → the Transfer dialog opens with that
      instance **preselected**. Clicking the handle instead opens the dialog with no destination chosen.
- [ ] The **destination instance** dropdown lists every instance **except the source's own**.
- [ ] Pick a destination → **Start Transfer** enables. Click it → success toast with a transfer id (or an error
      toast on rejection); the new operation appears in **Transaction Logs**.
- [ ] A platform drag stages **no** gateway config change (the Save panel stays clean).

#### 11.4 Import
- [ ] Click **Import** (Gateways canvas, top-left). Choose a `.json` export file → a green "JSON parsed" alert shows the
      file's `platform_name` (or warns if it's missing); a malformed file shows a red parse-error alert.
- [ ] Fields: **Target instance** (required), **destination planet** (optional — aquilo/fulgora/gleba/nauvis/
      vulcanus, with icons, clearable), **force name** (default `player`), optional **platform-name override**.
- [ ] **Import** stays disabled until a file is parsed **and** a target instance is chosen. Import → success
      toast, the modal closes, and the import shows up in **Transaction Logs**. Upload-import deletes no source.

#### 11.5 Transaction Logs tab
- [ ] **Recent Transfer Logs** table lists operations with **Type** (transfer/export/import tag), **Platform**,
      **Status** (colour-coded), **Timestamp**, **Size**, and a **Download** action (enabled only for rows with a
      stored, downloadable export). Download → the export JSON saves to disk.
- [ ] Click a row → **Transfer Summary** card: a success/error/in-progress alert with the platform name, outcome,
      total duration, and any error message.
- [ ] **Transfer Flow** timeline renders as horizontal phase bars + event markers with per-phase millisecond
      timing (export → delivery → import phases → validation → cleanup).
- [ ] **Details** sub-tabs each populate:
  - [ ] **Metrics** — compression summary + operation counts.
  - [ ] **Entities** — an informational **"Entities: N on destination · M in source payload"** line (neutral,
        *not* a pass/fail — the two counts legitimately differ by failed-to-place / filtered / belt-surplus),
        plus the per-entity-type breakdown; **icons render** (not `?` placeholders — see §11.7).
  - [ ] **Items** — Expected / Actual / Δ / Preserved% per item type (Δ green/red). An **API-stack-cap** info
        alert and a **"destination force under-researched → bonuses raised"** warning appear when relevant.
  - [ ] **Fluids** — per fluid/bucket table with thermal (Volume×Temperature) validation for high-temp fluids
        (gold tags) and status tags (Match / Thermal match / Reconciled / Mismatch).

#### 11.6 Gateways canvas — linking gateways
- [ ] Every instance renders as a node with its gateway(s). If the `surfexp_gateways` mod isn't loaded on the
      cluster, an Empty state explains that rather than drawing an empty canvas.
- [ ] Drag from one instance's gateway to another's → a link stages **both** directions, and the panel counts
      the unsaved change. **Save** pushes it (the in-game on-arrival chooser reads the resolved config);
      **Revert** drops every staged change.
- [ ] The drag line is **straight**, and it turns **green** over a legal target and **red** over an illegal one
      (same instance, a platform row, a mock node, or a Multi-Cluster-mode rule violation). Releasing over an
      illegal target names the refusal instead of silently snapping back.
- [ ] Click an edge to stage its removal; **the padlock in the Controls stack blocks that** — locked, clicking
      an edge changes nothing. The canvas owns this padlock; React Flow's own interactivity toggle is gone.
- [ ] Ctrl+click a second instance → both read green and **Link selected** / **Unlink selected** appear.
      Bulk-linking refuses Multi-mode violations **by name** rather than truncating silently.
- [ ] The edge-shape dropdown (bezier / straight / step / smoothstep) redraws every link and survives a reload,
      as do node positions; **Reset** forgets the saved layout and re-frames.
- [ ] A live transfer rides its edge: a ship animates while in transit, then one marker per phase parks at its
      position — **validating** mid-edge, **arrived** at the destination end, **failed** back at the source —
      carrying a count when more than one transfer is in that phase. Terminal markers hold ~10s, then fade.

#### 11.7 Icons / export-data sanity
- [ ] Item / entity / fluid / planet icons render everywhere they appear (Logs details, tree, Import planet
      picker). Blank `?` placeholders ⇒ the mod pack has no export-data — regenerate it (the mod pack needs export-data, which requires the game client on the export host) and
      hard-refresh (the 404 is cached).

The connected-player instrument is operator-only: with one consenting player in character or god mode
on host-1, run `node tests/instruments/connected-player-access/run-tests.mjs view`, then `hide`,
`leave`, and `hide-platform` as separate actions while recording the platform-list observations.
Always finish with `cleanup`, which restores the player's controller, position, and preserved god inventory.
The separate `measure` action checks script entry into a hidden platform and connected-character evacuation
both with and without remote view; it restores the player and checks platform deletion after the call.
`--fail-after-build` exercises cleanup (expected nonzero exit), and `--analyze <report.json>` checks a saved measurement without RCON.
These API readings do not substitute for the operator's observation of the interface.

The descending-pod overflow instrument runs through the integration suite. To run it independently:
`node tests/instruments/descending-pod-overflow/run-tests.mjs --host 2` (default host: 1).
It requires an idle instance and checks both platform entries and surfaces after cleanup.

### 12. Cleanup / reset

```pwsh
# Remove a leftover test platform on an instance:
./tools/clusterio/rcon.ps1 21 "/sc local p=game.forces['player'].platforms[<idx>]; if p then game.delete_surface(p.surface) end"

# Full clean re-seed (wipes runtime state back to the seed saves):
./tools/clusterio/deploy.ps1 -Scope plugin
# Hard wipe (volumes):  docker compose down -v   then   docker compose up -d
```

### Quick reference

| Goal | Command |
|------|---------|
| Full E2E (all scenarios) | `node tools/tests/run-integration-tests.mjs` |
| One scenario | `node tools/tests/run-integration-tests.mjs --only <regex>` |
| Manual transfer | `./tools/surface-export/transfer-platform.ps1 -PlatformIndex <idx> -Direction 1to2` |
| RCON (host-1 / host-2) | `./tools/clusterio/rcon.ps1 11 "<cmd>"` / `./tools/clusterio/rcon.ps1 21 "<cmd>"` |
| List platforms | `./tools/clusterio/rcon.ps1 11 "/list-platforms"` |
| Validation result | `./tools/surface-export/get-transaction-log.ps1 [-TransferId <canonical-id>]` |
| Trace a failure | `./tools/clusterio/check-cluster-logs.ps1 -Grep "..."` |
| Reset cluster | `./tools/clusterio/deploy.ps1 -Scope plugin` |
