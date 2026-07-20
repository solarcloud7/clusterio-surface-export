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
- a source/destination role, physical invariant, and expected terminal verdict;
- a minimal machine-readable fingerprint; and
- provenance when derived from an incident or failure black box.

A platform or surface name is a lookup label, not sufficient destructive identity. A fixture revision changes
whenever its physical state or expected invariant changes, and longitudinal results from different revisions are
never compared as one series.

#### Storage and bake-time configuration

Golden saves are committed to this repository under `docker/seed-data/lab-saves/`, beside their machine-readable
manifest — the live cluster is never the only copy of the corpus. A save is baked WITH the plugin configuration
it is meant to carry: `on_init` defaults apply only to fresh saves (Pitfall #13, debug mode lost after save
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
a filtered loader** onto the circuit. It saturates the circuit to a deterministic steady state (owner-built
exemplars: the green-belt omnibus and the filtered-splitter fixture on `lab-omnibus-platform-v1`), needs no
hand-seeding, and reproduces natural kinetic compression — the hardest restore case. Operational facts
(canonical citations in the belt section of [factorio-2.0-api-notes.md](factorio-2.0-api-notes.md)):
loaders keep running on paused platforms and their `active` flag IS writable — deactivate the loaders to
freeze the feed for a measurement window; belt-class `active` writes are rejected and belts keep moving
(BELT-R13), so census reads must be same-execution. Clone the chests WITH the fixture
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
tooling (`tests/lab-gallery/deliver-omnibus.mjs`) redraws them from the manifest after a pad platform is
delivered.

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

Engine knowledge keeps the evidence tags defined in the "Testing discipline" section of [CLAUDE.md](../CLAUDE.md):

- **[API]** establishes that the pinned public API exposes a field, method, role, or signature.
- **[empirical, `<pin>`]** records behavior measured by a valid live rung at that engine pin.
- **[hypothesis]** labels an unproven behavioral prediction or mechanism explanation.

API shape is not behavioral certification. A negative result is evidence, and an eliminated symptom without an
isolated mechanism remains unexplained rather than being retconned into a proven fix.

**Citation-variable match.** An `[empirical]` tag on a MECHANISM claim must cite a rung that isolated **that
claim's variable** — citation presence is not citation match. The refuted "set_stack fails while deactivated"
lore wore a GROUNDED `[empirical]` stamp citing rungs that isolated force bonus, never activation. Corollary
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

An engine-version change requires a re-certification campaign before lab conclusions are enabled at the new pin:
restore the archived runners from the `labs-archive-2026-07-19` git tag (or author fresh probes), re-measure every
law production depends on, and record the resulting evidence commits in
[`tests/labs-certified.json`](../tests/labs-certified.json) — the engine-pin certificate that
`lint:version-certification` holds equal to the pinned Factorio version. Promotion never upgrades a hypothesis or
unexplained observation into law.

See [`tests/README.md`](../tests/README.md) for the repository test layout and entry points.

---

## How transfer fidelity is measured

How the plugin verifies that a transferred platform arrives with 100% of its restorable items and
fluids, which instruments that claim rests on, and — equally important — where the guarantee's
boundary sits. Read this before trusting, extending, or auditing any fidelity claim.

### The two meters

Every fidelity check in this project compares readings from two **independent instruments with
disjoint failure modes**:

| Meter | What it does | Where it lives | Natural failure mode |
|---|---|---|---|
| **Serializer walk** | Structured extraction: dispatches every entity to a per-category handler that decides which state to capture (inventories, fluids, belt lines, held items, settings) | [entity-handlers.lua](../docker/seed-data/external_plugins/surface_export/module/export_scanners/entity-handlers.lua), [inventory-scanner.lua](../docker/seed-data/external_plugins/surface_export/module/export_scanners/inventory-scanner.lua) | **Omission** — a handler forgets that a container of state exists |
| **Physical census** | Flat engine count: `surface.find_entities_filtered({})` enumerates every entity that exists; `entity.get_item_count(name)` returns the engine's total for that item anywhere inside the entity | [surface-counter.lua](../docker/seed-data/external_plugins/surface_export/module/validators/surface-counter.lua) (`count_items`, `count_fluids`) | Engine-level miscount only — the loop contains no per-category logic, so it cannot forget a container |

The census's independence is structural: the per-category handler taxonomy (the code that can
forget things) never appears in the census loop. A serializer omission therefore shows up as a
numeric disagreement between the two meters — it cannot hide.

Comparing the serializer against itself would prove nothing (extraction is deterministic; the same
walk returns the same answer twice). All checks below are serializer-vs-census or
census-vs-census comparisons across the transfer boundary, never ledger-vs-same-ledger.

### Verified engine facts the census relies on

Evidence tags and measurement details are in
[factorio-2.0-api-notes.md](factorio-2.0-api-notes.md) (see "Item counting").

- `LuaEntity.get_item_count(item)` is a per-entity total that **includes belt-line and held-stack
  items**; on a belt it equals that belt's own transport-line sum, so summing over every belt does
  not double-count a shared run.
- Ground items are entities (`item-entity`) and are counted by the same enumeration
  (`count_items` has a dedicated ground-item pass).
- Quality is a dimension of every item-domain reference (entities, stacks, held items, filters,
  requests, recipes, equipment, and circuit signals); fluids are the exception and have no quality.
- Counting must happen in a **frozen world** (entities deactivated, no elapsed tick between
  restoration and count), or machines craft in the gap and produce false deltas. The import
  pipeline's phase ordering exists to guarantee this (see "Import Phase Ordering" in
  [CLAUDE.md](../CLAUDE.md)).
- Reconciled conventions, applied on **both** sides of every comparison: any restoration write the engine
  rejects is subtracted from expected (see
  [fluid_restoration.lua](../docker/seed-data/external_plugins/surface_export/module/import_phases/fluid_restoration.lua)),
  and engine-owned-category fluids (fusion plasma) are excluded
  (`count_fluids(..., exclude_engine_owned)`). Note: fusion write rejection does not reproduce at 2.0.77
  (fluid-lab R14); the exclusion's revision is the queued shared-accessor /di-change.

### Where each comparison runs today

| Check | Compares | Runs | Anchor |
|---|---|---|---|
| **Exact transfer gate** | serialized-expected vs **destination** physical census (items exact per key; fluids exact aggregate-by-name, epsilon 1e-6) | production, every transfer, before source deletion | [transfer-validation.lua](../docker/seed-data/external_plugins/surface_export/module/validators/transfer-validation.lua) |
| **Meter-drift sentinel** | serialized-expected (`expectedItemCounts`) vs **source** physical census | integration test only | [transfer-fidelity](../tests/integration/transfer-fidelity/run-tests.ps1) |
| **Loss-injection teeth** | gate behavior under a forced physical shortfall (must fail closed, preserve source) | pad fixtures through the real transfer | the `gate-item-loss` / `gate-fluid-loss` / `rollback-validation-failure` pads, run by [pad-transfer-suite](../tests/integration/pad-transfer-suite/run-tests.mjs) |
| **Fidelity fixtures** | source physical census vs destination physical census for a placed, known quantity | integration tests | the `omnibus-ground-items` pad fixture (see [MIGRATION.md](../tests/integration/MIGRATION.md)), [belt-loss-replay](../tests/integration/belt-loss-replay/run-tests.ps1) |

The production export path performs **no source-side physical census**: the gate's expected counts
derive from the serializer's own output (verification is generated from serialized data — see
Pitfall #16, atomic belt scan, in [CLAUDE.md](../CLAUDE.md)). The meter-drift sentinel covers that
axis in CI only.

### Freeze policy by entity family

Measurement and serialization are only meaningful against a non-moving target. Different entity
families require different freeze mechanisms, and several intuitive ones are measured
non-starters. Current policy, per family:

| Family | Mechanism during export/import | Anchor |
|---|---|---|
| Machines, inserters, turrets, most activatables | `entity.active = false` at lock time; original states recorded and restored on unlock/activation ([surface-lock.lua](../docker/seed-data/external_plugins/surface_export/module/utils/surface-lock.lua) `freeze`, [active_state_restoration.lua](../docker/seed-data/external_plugins/surface_export/module/import_phases/active_state_restoration.lua)) | code |
| Asteroid collectors | `entity.active = false` through the same lock/deactivation path; collectors are activatable and were measured frozen by the lock ([game-utils.lua](../docker/seed-data/external_plugins/surface_export/module/utils/game-utils.lua) `is_activatable_entity`) | code + measured |
| Belts (transport-belt, underground, splitter) | **cannot be deactivated — items keep moving on locked platforms** (measured); read in one atomic Lua execution instead ([async-processor.lua](../docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua) atomic belt scan; Pitfall #16, atomic belt scan, in [CLAUDE.md](../CLAUDE.md)) | measured |
| Cargo pods in flight | not frozen — **completed** by the lock before export scanning ("completes cargo pods", [export-pipeline.lua](../docker/seed-data/external_plugins/surface_export/module/core/export-pipeline.lua)); a mover is retired, not paused | code |
| Ground items (`item-entity`) | static entities; no freeze needed | code |
| Beacons (import side) | deliberately kept **active** through restoration so `crafting_speed` propagates to crafters before inventory refill (see "Import Phase Ordering" in [CLAUDE.md](../CLAUDE.md)) | code |
| Inserter held items (import side) | per-inserter brief active-toggle inside one synchronous pass — no tick elapses, so no swing occurs (Pitfall #28, the gate must count a complete state, in [CLAUDE.md](../CLAUDE.md)) | measured |
| Whole platform (`platform.paused`) | parks held destinations; does **not** stop belt drift on the held surface (the observation behind Black-Box Discard's snapshot-then-delete design) | measured |
| Whole game (`game.tick_paused`) | labs and tests only; also halts the plugin's own async processing (`/step-tick` exists to step past it) | code |

The strongest freeze is not a pause mechanism at all: **within a single Lua execution, zero ticks
elapse and nothing in the simulation moves** (measured — see the no-tick-sync results referenced
from Pitfall #15, entity activation before validation, in [CLAUDE.md](../CLAUDE.md)). Reads that
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
| **1 — countable** | items and fluids (conserved quantities the engine can total) | measurement: physical census on the destination (production gate) and on the source (test sentinel) | a serializer omission is *detectable by measurement* wherever a census runs |
| **2 — non-countable** | circuit configuration, crafting progress, schedules, spoilage timers, health, energy, heat, … | enumeration: per-category handlers, per-dimension roundtrip fixtures, and static ownership/classification tests | no aggregate meter exists; an unenumerated dimension is silently absent and **no census can detect it** |

Consequences of the boundary:

- For tier 1, a census comparison converts any omission bug from *silent loss* into a *loud
  numeric mismatch* — but only on the side where a census actually runs. On the destination it
  runs in production; on the source it runs only in the CI sentinel.
- For tier 2, coverage is exactly the list of dimensions someone has enumerated and tested.
  "100% parity" statements should be scoped to tier 1 plus the enumerated tier-2 dimensions, never
  stated unqualified.
- Both tiers ultimately trust the engine's own meters. That trust is not axiomatic: the
  load-bearing engine facts above were measured in lab rungs before the gate was allowed to rely
  on them, and an engine pin bump requires the re-certification campaign recorded in
  `tests/labs-certified.json` (`lint:version-certification`).

---

## Hands-on E2E validation

A hands-on, repeatable procedure to validate the surface_export plugin end-to-end on the local 2-host
Docker cluster: **export → controller route → import → validation → source cleanup**, plus the gateway,
passenger, upload-import, and failure paths.

This complements [QUICK_START.md](QUICK_START.md) (the happy-path *usage* intro) — this is the *QA/validation*
checklist. The single source of truth for "does it all work" is the automated suite below; the manual sections
exist to inspect, debug, or demo individual flows.

> **Shell note (agents / non-interactive):** the `rc11`/`rc21` profile aliases are interactive-only. Use
> `./tools/rcon.ps1 11 "<cmd>"` (host-1) and `./tools/rcon.ps1 21 "<cmd>"` (host-2). All commands below assume
> repo root and PowerShell 7 (`pwsh`).

### 0. What "pass" means

A transfer is **correct** when, on the destination, all of the following hold and the source platform is gone:
- **Entity count** equals the source (failed placements are tallied, not silently dropped).
- **Items and fluids are exact**: the strict gate requires exact per-key item counts and exact
  aggregate-by-name fluid volume (epsilon `1e-6`); failed-entity losses and engine-rejected writes are
  subtracted from expected before the gate. There is no tolerance band.
- **Schedule** (records + interrupts + wait conditions) is preserved.
- The validation **gate passed** (`validation_success = true`) — this is the authoritative loss check.
- On failure, the source is **unlocked/rolled back**, never deleted (two-phase commit).

### 1. Prerequisites — bring the cluster up

```pwsh
docker volume create factorio-client          # one-time
docker compose up -d                            # or: ./tools/deploy-cluster.ps1 -SkipIncrement -KeepData
./tools/show-cluster-status.ps1                 # controller healthy + both instances running
```

Expect: `surface-export-controller`, `surface-export-host-1`, `surface-export-host-2` all **Up (healthy)**,
and both instances `running`.

If you changed plugin code first:
- **TS only:** `./tools/build-plugin.ps1 node -RestartHosts` (controller changes also need `-RestartController`)
- **Lua / full:** `./tools/patch-and-reset.ps1` (rebuilds + resets saves to re-patch Lua + restarts)

### 2. Smoke test — plugin loaded, debug on

```pwsh
# Remote interface is registered (must print 'true'):
./tools/rcon.ps1 11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"

# Debug mode on BOTH instances (writes debug_*.json artifacts used for inspection):
./tools/rcon.ps1 11 "/sc remote.call('surface_export','configure',{debug_mode=true})"
./tools/rcon.ps1 21 "/sc remote.call('surface_export','configure',{debug_mode=true})"

# Source platforms exist on host-1 (the seed 'test' platform = ~1359 entities):
./tools/rcon.ps1 11 "/list-platforms"
```

> Note the per-force **unique index** from `/list-platforms` — it is the key for every command below
> (names can collide; the index never does).

### 3. Automated suite — the fastest full E2E (do this first)

One auto-discovering runner drives every `tests/integration/*` scenario against the live cluster. This *is*
the CI step, so a green run here ≈ a green PR.

```pwsh
node tools/run-integration-tests.mjs --list           # see all scenarios
node tools/run-integration-tests.mjs                  # run the FULL suite (~3–4 min)
node tools/run-integration-tests.mjs --only platform-roundtrip   # one scenario
node tools/run-integration-tests.mjs --only 'fidelity|gate'      # regex filter
```

Expect the summary to end `N/N passed`. The scenario set is auto-discovered from
`tests/integration/*/run-tests.{ps1,mjs}` — `--list` prints the current roster. Roundtrip scenarios are
progressively absorbed as pad fixtures on the lab-gallery save; the deleted-test → pad-fixture mapping is in
[tests/integration/MIGRATION.md](../tests/integration/MIGRATION.md).

The remaining sections reproduce individual flows **manually** for inspection/demo/debugging.

### 4. Manual happy-path transfer (host-1 → host-2)

```pwsh
# Pick a source index from /list-platforms (e.g. the 'test' platform). Then:
./tools/transfer-platform.ps1 -PlatformIndex <idx> -Direction 1to2
```

This wraps the full `/transfer-platform` workflow (lock → export → route → import → validate → delete source
**or** rollback) and prints post-transfer state. Watch progress in chat/logs:

```pwsh
# Source side (host-1):  export progress + "Export Complete"
# Dest side  (host-2):  import progress + "Import Complete"
./tools/rcon.ps1 21 "/list-platforms"     # platform now on host-2
./tools/rcon.ps1 11 "/list-platforms"     # gone from host-1 (deleted on success)
```

For a clean repeatable source, clone the seed platform first (so you keep the original):

```pwsh
# clone_platform(source_index, dest_name) — source keyed on UNIQUE index, 2 args
./tools/rcon.ps1 11 "/sc remote.call('surface_export','clone_platform', <test_idx>, 'e2e-demo')"
```

### 5. Validation & fidelity — prove conservation independently

Don't trust only the validator's self-report — cross-check with a **physical count**.

```pwsh
# A) The controller's transaction record for the latest transfer (or pass -TransferId <canonical-id>):
./tools/get-transaction-log.ps1
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
./tools/rcon.ps1 11 "/export-platform <idx>"
./tools/rcon.ps1 11 "/sc rcon.print(remote.call('surface_export','list_exports_json'))"

# Export to a disk file:
./tools/rcon.ps1 11 "/export-platform-file <idx>"   # lands in host-1 script-output/

# Re-import a JSON file onto host-2 (chunks automatically; no source deleted):
./tools/rcon.ps1 21 "/plugin-import-file <filename> <new_platform_name>"
```

Or use the **web UI** (§11) → Manual Transfer per-platform **Export JSON**, or the global **Import JSON** button.

### 7. Gateway transfer (Phase 1a)

```pwsh
# Park a platform at a gateway, then:
./tools/rcon.ps1 11 "/gateway-transfer <idx> <dest_instance_id>"   # arrives paused at the gateway, hop stripped
# Or open the on-arrival chooser GUI (Model A):
./tools/rcon.ps1 11 "/gateway-gui <idx>"
```

Automated coverage: `--only 'gateway'` (`gateway-transfer`, `gateway-guard`).

### 8. Passenger evacuate (no hard block)

A transfer is **not** blocked when players/character bodies are aboard — they're **evacuated to Nauvis** at the
sole source-delete chokepoint before teardown. Validate via the suite:

```pwsh
node tools/run-integration-tests.mjs --only passenger-evacuate
```

(Manual connected-player verification is tracked separately.)

### 9. Failure / edge cases (the safety net)

```pwsh
# The sabotage teeth (gate detects item/fluid loss, rollback, failed-entity attribution,
# force-bonus sync) are pad fixtures run through the REAL transfer by one suite:
node tools/run-integration-tests.mjs --only pad-transfer-suite

# Name-collision delete (platforms with same name → keyed on unique index, correct one deleted):
node tools/run-integration-tests.mjs --only name-collision-delete
```

Manual lock/rollback inspection:

```pwsh
./tools/rcon.ps1 11 "/lock-status"                  # show locked platforms
./tools/rcon.ps1 11 "/unlock-platform <name_or_index>"
```

### 10. Persistence & observability

```pwsh
# In-game transaction dashboard (history + per-phase timing):
./tools/rcon.ps1 11 "/transaction-dashboard 25"

# Controller persistence files (written atomically via safeOutputFile — should be valid JSON, no *.tmp):
docker exec surface-export-controller sh -c 'ls -la /clusterio/data/database/surface_export_*.json'

# Trace a transfer end-to-end (the aggregated JSON logs docker logs hides):
./tools/check-cluster-logs.ps1
./tools/check-cluster-logs.ps1 -Grep "transfer|validation|fail"

# Prometheus metrics:
docker exec surface-export-controller sh -c 'curl -s http://localhost:8080/metrics | grep ^surface_export_'
```

Log homes (see [CLAUDE.md](../CLAUDE.md) "Observability"): controller `/clusterio/logs/cluster/cluster-*.log`
(best single stream for a cross-instance transfer), host `/clusterio/logs/host/host-*.log`, Factorio
`/clusterio/data/instances/<instance>/factorio-current.log`, debug dumps in that instance's `script-output/`.

### 11. Web UI walkthrough (per-feature checklist)

Open `http://localhost:8080` → **Surface Export** in the sidebar (auth: `./tools/get-admin-token.ps1` copies a
login token). The page has three tabs — **Manual Transfer**, **Transaction Logs**, **Gateways** — plus an
**Import JSON** button (top-right, shown **only on the Manual Transfer tab**) and a live WebSocket feed (no
manual refresh needed). Tick each feature:

#### 11.1 Page shell & live updates
- [ ] Page loads; the plugin **version** shows under the title; the **Surface Export** sidebar entry is present.
- [ ] All three tabs render. Switching tabs updates the URL (`?tab=manual` / `?tab=logs` / `?tab=gateways`);
      pasting `…/surface-export?tab=logs` opens straight to that tab.
- [ ] **Live**: start a transfer from RCON/CLI and watch the Manual Transfer tree **and** the Logs tab update on
      their own, with no page reload (WebSocket subscription).
- [ ] **Permissions**: a user without the log-view permission sees the **Transaction Logs** tab hidden and the
      page still loads (the subscription downgrades gracefully — no error toast).

#### 11.2 Manual Transfer tab — platform tree (left panel)
- [ ] Tree is grouped **Host → Instance → platform**. A connected host shows a **blue** tag, a disconnected one a
      grey tag; an instance that failed to list platforms shows an **error** tag.
- [ ] Only platforms with a space hub appear. Each row shows the platform **name** with its unique **`#index`**
      (disambiguates same-named platforms — two `test`s are distinguishable), its **location** (a space
      body, `→ <target> (ETA ~N min)` while flying, or *in transit*) with a **planet icon**, and an **orange
      "locked" tag** when the platform is locked (e.g. mid-transfer).
- [ ] Click a row → it highlights as the selected **source**.
- [ ] **Export JSON** (download icon on each row) → a `<platform>_<timestamp>.json` file downloads and a success
      toast shows the export id. Source is **not** deleted (export-only).

#### 11.3 Manual Transfer tab — transfer panel (right panel)
- [ ] With no source selected, the card shows a "Select a source platform" warning and both the destination
      picker and **Start Transfer** are disabled.
- [ ] Select a source → the card shows a source info alert; the **destination instance** dropdown lists every
      instance **except the source's own**.
- [ ] Pick a destination → **Start Transfer** enables. Click it → success toast with a transfer id (or an error
      toast on rejection); the new operation appears in **Transaction Logs**.

#### 11.4 Import JSON (Manual Transfer tab only)
- [ ] The **Import JSON** button appears **only** on the Manual Transfer tab — it is **absent** on Transaction
      Logs and Gateways (it lives in the tab bar, gated to the active tab).
- [ ] Click **Import JSON** (top-right). Choose a `.json` export file → a green "JSON parsed" alert shows the
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

#### 11.6 Gateways tab
- [ ] Lists every gateway (from the `surfexp_gateways` mod). If none, an Empty state explains the mod isn't
      loaded on the cluster.
- [ ] Per-gateway card: add **target** rows (destination instance — **offline instances are flagged**; a
      `→ gateway` picker), delete a row, **Add target**, **Save**.
- [ ] A gateway with **no targets** reads "disabled". Saving a row with **no instance picked** is refused with a
      toast (no silent-disable). Save → success toast; the resolved config is pushed to the instances (the
      in-game on-arrival chooser reads it).

#### 11.7 Icons / export-data sanity
- [ ] Item / entity / fluid / planet icons render everywhere they appear (Logs details, tree, Import planet
      picker). Blank `?` placeholders ⇒ the mod pack has no export-data — regenerate it (**Pitfall #27, web-UI icons blank — export-data/game-client**) and hard-refresh (the 404 is cached).

### 12. Cleanup / reset

```pwsh
# Remove a leftover test platform on an instance:
./tools/rcon.ps1 21 "/sc local p=game.forces['player'].platforms[<idx>]; if p then game.delete_surface(p.surface) end"

# Full clean re-seed (wipes runtime state back to the seed saves):
./tools/patch-and-reset.ps1
# Hard wipe (volumes):  docker compose down -v   then   docker compose up -d
```

### Quick reference

| Goal | Command |
|------|---------|
| Full E2E (all scenarios) | `node tools/run-integration-tests.mjs` |
| One scenario | `node tools/run-integration-tests.mjs --only <regex>` |
| Manual transfer | `./tools/transfer-platform.ps1 -PlatformIndex <idx> -Direction 1to2` |
| RCON (host-1 / host-2) | `./tools/rcon.ps1 11 "<cmd>"` / `./tools/rcon.ps1 21 "<cmd>"` |
| List platforms | `./tools/rcon.ps1 11 "/list-platforms"` |
| Validation result | `./tools/get-transaction-log.ps1 [-TransferId <canonical-id>]` |
| Trace a failure | `./tools/check-cluster-logs.ps1 -Grep "..."` |
| Reset cluster | `./tools/patch-and-reset.ps1` |
