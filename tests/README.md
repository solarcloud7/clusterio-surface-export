# Tests

The canonical testing taxonomy, baked-fixture lifecycle, measurement rules, and promotion policy are in
[`docs/testing.md`](../docs/testing.md).

## Repository layout

- `tests/integration/` contains live regressions for established production contracts. Discover and run them with
  `node tools/tests/run-integration-tests.mjs --list` and `node tools/tests/run-integration-tests.mjs` from the repository root.
- The standing lab suite was removed 2026-07-19 (owner ruling); its runners and notebooks are archived at git tag
  `labs-archive-2026-07-19`. At an engine bump, re-measure the law you are about to rely on in the PR that
  relies on it — restore a runner from the archive tag or author a fresh probe. The `labs-certified.json`
  certificate and its lint were deleted 2026-07-31 (owner ruling): a green certificate was permission to
  assume, and the last one asserted laws its own cited pads never exercised.
- [`runner-inventory.md`](runner-inventory.md) records each executable's evidence-backed category and disposition;
  absent rows are unclassified while SC-41 remains in progress.
- `docker/seed-data/external_plugins/surface_export/test/` contains Node unit and contract tests for the plugin.
- `docker/seed-data/external_plugins/surface_export/scripts/` contains the static guards used by the plugin lint
  suite.

A test is not a lab merely because it lives under the top-level `tests/` directory. Choose its category from the
question it answers and the oracle it requires.

## Baked physical batches

A baked batch consumes each certified fixture once, invokes the real production path, and reloads the paired
golden saves in an unconditional batch finalizer. It does not clone, construct, clean, or reset fixtures between
runs. A runner must own or exclusively lease both instances, refuse in-flight transient state, and verify the
certified baseline again before releasing them. The first fixture that leaves the per-fixture preflight
unsatisfiable aborts the batch; unconsumed fixtures report BLOCKED, distinct from FAILED. Operational drift uses
the production transaction analytics plus fixture/save identity metadata. Correctness tests add an independent
physical oracle only when the production serializer, restorer, validator, gate, or analytics meter is under test.
Golden saves are committed under `docker/seed-data/lab-saves/`; engine pin bumps load them through native save
migration by owner ruling (see the standard).
