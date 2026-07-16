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

### Minimality

A fixture contains the smallest physical state that proves its invariant. A large fixture is allowed only when
scale, capacity, batch size, or a workload boundary is the named variable and evidence shows that size is causal.
Historical reproductions may remain large until minimization preserves the failure; "small plus large" is not a
default test pattern.

## Single-use batch lifecycle

A certified baked-fixture batch follows this lifecycle:

1. Load the paired golden source and destination saves.
2. Verify the expected save/fixture revision and require `game.tick_paused == false`; fail closed rather than
   silently repairing a dirty or paused save.
3. Resolve the exact named fixture and verify its minimal fingerprint.
4. Invoke the real production operation, such as `/transfer-platform`.
5. Capture the production transaction ID and wait for its terminal production record.
6. Consume the next untouched baked fixture without cleaning, cloning, rebuilding, or resetting the prior one.
7. Reload both golden saves at the batch boundary.

Within a loaded batch, every baked fixture is single-use. A runner must not clone platforms, construct the
physical case, scan prefixes for cleanup, delete prior fixtures, directly clear plugin storage, or unpause a game
it did not pause. Tests that require incompatible global state use a different golden-save pair.

There is no between-run cleanup for baked fixtures. Reloading the certified save pair is the normal reset. This
does not retire cleanup-specific tests, and it does not authorize a legacy probe to leave state behind on the
shared mutable cluster: runners outside the certified baked lifecycle continue to follow the zero-leftover rules
in [CLAUDE.md](../CLAUDE.md).

## Measurement and evidence

Use the production transfer record as the canonical operational-drift record. Do not add a second stopwatch,
entity count, percentile calculation, or phase total that merely remeasures fields already produced by the
production analytics. Compare a fixture only with earlier results carrying the same fixture ID and revision.

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

An engine-version change requires rerunning every applicable `tests/*-lab/` runner before its conclusions are
enabled at the new pin. [`tests/labs-certified.json`](../tests/labs-certified.json) records the resulting evidence
commits at the certified pin. Promotion never upgrades a hypothesis or unexplained observation into law.

See [`tests/README.md`](../tests/README.md) for the repository test layout and entry points.
