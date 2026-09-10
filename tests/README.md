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

## Local Lua checks

`./tools/tests/run-lua-tests.ps1` runs the Lua test list from CI with Lua 5.2 in a
locally built Docker image. Use `-List` to inspect the list, or
`-Test tests/lua/chunk-operation-isolation.lua` for a focused regression. Each test
runs without network access with only its source dependencies mounted read-only.
The runner stops at the first failure, returns a nonzero exit code, and retains
output and command elapsed time under `ci-artifacts/lua-tests-*/`. This elapsed time
includes Docker startup; it is not Factorio callback profiling. Tests not reached
after a failure are listed as requested but have no result.

This is standalone Lua, not Factorio's sandbox. Tests may use host-only loaders such
as `loadfile` and stub engine APIs; their success does not prove those facilities are
available to shipped mod code. Follow the [dependency compatibility check](../docs/testing.md#factorio-dependency-compatibility)
before adding a library, and prove engine-dependent behavior in the pinned game.

## Manual installation acceptance

The [consumer installation lab](manual/consumer-install/README.md) runs the published Clusterio
installer, installs a plugin tarball, creates fresh saves, exports real game assets, and checks
browser loading and transfer recovery in disposable containers. Run `npm run test:manual:consumer`
for its explicit inputs. It needs a locally installed licensed Factorio client; it is manually
triggered and does not run the game in ordinary CI.

The [packaged production-profile lab](manual/production-profile/README.md) boots the
actual Compose profile from baked image IDs, checks its settings, and repeats physical
cargo/restart and browser acceptance. It is also manual and uses disposable resources.

## Manual performance instruments

- [Simulation timing and full-transfer baseline](instruments/tick-watch/README.md):
  server/client tick cadence, with separate callback profiling and physical cargo checks.
- [Codec experiments and recorded results](instruments/tick-watch/import-setup.md):
  full versus sectional JSON decoding, external compression, and 1x/2x/4x workloads.
  Run `node tests/instruments/tick-watch/codec-scaling.mjs --recorded` to verify and
  re-analyze the retained evidence without Docker or a running game.
- [RCON throughput](instruments/rcon-throughput/README.md): transport-only comparison.

These are manually invoked instruments, not additional default CI suites.

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
