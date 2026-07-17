# Physical Truth Lab Standard

This document is the canonical standard for choosing, building, running, and promoting tests that depend on
Factorio's physical runtime. The goal is to build a reusable physical-truth corpus that replaces engine lore
with version-pinned evidence, exercises production behavior, preserves real failures, and exposes behavioral
and performance drift over time.

The evidence discipline and shared-cluster safety rules in [CLAUDE.md](../CLAUDE.md) still apply. This standard
adds the taxonomy and the single-use baked-fixture lifecycle; it does not weaken controls-first experiments,
independent grounding, engine-pin recertification, or cleanup tests whose subject is cleanup.

## Test taxonomy

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

## Physical Truth Lab mission

A physical lab converts an uncertain engine-dependent claim into version-pinned, reproducible evidence. It is
mandatory when a design depends on engine behavior that is not empirical at the current pin, when physical
measurements disagree, when an explanation relies on uninspectable internals, or when the engine pin changes.

Each lab starts with a falsifiable question and the cheapest control that establishes the measuring instrument.
It isolates one variable per rung, records negative and unexplained results, and never promotes a plausible
mechanism explanation into engine law merely because the observed behavior is consistent with it.

## Baked fixture contract

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

### Storage and bake-time configuration

Golden saves are committed to this repository under `docker/seed-data/lab-saves/`, beside their machine-readable
manifest — the live cluster is never the only copy of the corpus. A save is baked WITH the plugin configuration
it is meant to carry: `on_init` defaults apply only to fresh saves (Pitfall #13, debug mode lost after save
reset), so a configuration default added after a save was baked never reaches that save without a deliberate
re-bake or an explicit migration step recorded against the fixture revision.

### Golden saves across engine pins (owner ruling, 2026-07-16)

Golden saves are NOT re-baked when the Factorio pin bumps. Loading the existing save on the new engine and
accepting its save migration is the deliberate policy: it exercises exactly what players' saves experience, the
baked states are stable and human-inspectable, and re-baking from scripts would not by itself prevent
migration-class drift. Watch release changelogs for migration risks before a pin bump, and rely on the engine and
mod pins recorded in every longitudinal summary to attribute migration-coincident drift. A fixture revision does
not change merely because the engine migrated the save; it changes when the physical state or expected invariant
is deliberately edited.

### Minimality

A fixture contains the smallest physical state that proves its invariant. A large fixture is allowed only when
scale, capacity, batch size, or a workload boundary is the named variable and evidence shows that size is causal.
Historical reproductions may remain large until minimization preserves the failure; "small plus large" is not a
default test pattern.

### Standard fill harness (belt fixtures)

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

## Single-use batch lifecycle

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

**Failure attribution (owner ruling, 2026-07-16).** A production operation that reaches a terminal verdict —
including a failed frozen verdict with its banked black box — is a valid FAILED result. Before consuming the
next fixture, the runner re-verifies the same preflight it required at load (game unpaused, zero transient
plugin state). The first fixture whose run leaves that preflight unsatisfiable ends the batch: the runner
reloads the golden pair and reports every unconsumed fixture as **BLOCKED**, a status distinct from FAILED.
One real failure must never read as ten; no repair of hostile state is permitted to keep a batch alive.

There is no between-run cleanup for baked fixtures. Reloading the certified save pair is the normal reset. This
does not retire cleanup-specific tests, and it does not authorize a legacy probe to leave state behind on the
shared mutable cluster: runners outside the certified baked lifecycle continue to follow the zero-leftover rules
in [CLAUDE.md](../CLAUDE.md).

## Measurement and evidence

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

Engine knowledge keeps the evidence tags defined by the empirical-lab discipline:

- **[API]** establishes that the pinned public API exposes a field, method, role, or signature.
- **[empirical, `<pin>`]** records behavior measured by a valid live rung at that engine pin.
- **[hypothesis]** labels an unproven behavioral prediction or mechanism explanation.

API shape is not behavioral certification. A negative result is evidence, and an eliminated symptom without an
isolated mechanism remains unexplained rather than being retconned into a proven fix.

## Promotion and recertification

Once a physical lab settles a contract, promote that contract into an integration regression that exercises the
shipped production path and has an independent red tooth. Preserve the append-only notebook and original evidence.
Retain only the minimal live rung needed to recertify engine-dependent behavior; do not keep exploratory setup in
the integration runner.

**The bake gate (owner ruling, 2026-07-16).** A lab conclusion is not SETTLED until its decisive fixture is
baked into a golden save and the conclusion reproduces from the loaded save. A freshly constructed world and a
save-loaded world are not automatically identical — save/load changes entity registration, storage identity, and
`on_load` paths — so the reproduction gate catches contracts that hold only in the built-at-runtime state before
they become permanent regressions. Labs iterate freely with disposable state while investigating; the baked
lifecycle binds the permanent layers (integration and drift), and this gate is the bridge between the two.

An engine-version change requires rerunning every executable `tests/*-lab/` runner before its conclusions are
enabled at the new pin. [`tests/labs-certified.json`](../tests/labs-certified.json) records the resulting evidence
commits at the certified pin; it is an evidence ledger, not a substitute for inventorying every executable runner.
Promotion never upgrades a hypothesis or unexplained observation into law.

See [`tests/README.md`](../tests/README.md) for the repository test layout and entry points.
