# Tests and retained evidence

Use [test selection](../docs/developers/testing.md) for commands, prerequisites and
independent comparisons, [fixtures](../docs/developers/fixtures.md) for gallery
maintenance, and [CI](../docs/developers/ci.md) for the automated workflow.

| Directory or runner | Scope |
|---|---|
| `tests/integration/` | Live regressions on the configured cluster; discover with `node tools/tests/run-integration-tests.mjs --list`. |
| `tests/lua/` | Standalone Lua regressions with simulated engine objects. |
| [Gallery](lab-gallery/) | Baked save manifests, pads and physical observations. |
| [Transfer cleanup](integration/transfer-cleanup/README.md) | Original source-deletion failure and independent cargo/ownership checks. |
| [Manual reliability lab](manual/transfer-reliability/README.md) | Disposable crash, lost-reply, save-policy and recovery cases. |
| [Package install](manual/package-install/README.md) | Exact tarball installation and native acceptance. |
| [Consumer install](manual/consumer-install/README.md) | Clusterio initializer, fresh worlds and real exported assets. |
| [Production profile](manual/production-profile/README.md) | Packaged startup, complete checkpoint restore and another transfer. |
| [Belt experiments](instruments/belt-boundary/README.md) | Failed candidates, side-group restoration and physical parity. |
| [Circuit restoration](instruments/circuit-latch-rearm/README.md) | Stable memory reproduction and bounded restoration checks. |
| [Callback profiling](instruments/callback-profile/README.md) | Whole scheduler callbacks and separate preparation studies. |
| [Tick recording](instruments/tick-watch/README.md) | Local server/client simulation cadence, not rendered FPS. |
| [Codec study](instruments/tick-watch/import-setup.md) | Captured data, full/sectional codec comparisons and archived raw readings. |
| [RCON comparison](instruments/rcon-throughput/README.md) | Transport-only chunk-size study. |
| [Post-activation study](instruments/post-activation/README.md) | Declared comparison boundaries after activation. |

Plugin Node regressions live under
`docker/seed-data/external_plugins/surface_export/test/`.

For local Lua checks, `./tools/tests/run-lua-tests.ps1 -List` lists the existing
CI selection; `-Test tests/lua/chunk-operation-isolation.lua` runs one check in
Lua 5.2 inside an isolated Docker container. Its elapsed time includes startup and
is not Factorio profiling. Host-only test loaders are not evidence of availability
inside Factorio's sandbox.

These notebooks distinguish current runner usage from versioned observations.
Paths under `ci-artifacts/` refer to ignored local evidence and may be absent in a
fresh checkout. Committed `evidence/` files remain available for offline analysis.
A missing artifact is unavailable evidence, not a passed test. For example,
`node tests/instruments/tick-watch/codec-scaling.mjs --recorded` verifies and
reanalyzes its committed archive without running the game.

Live suites can mutate or reload worlds. Read their individual setup and cleanup;
do not run them blindly against valuable saves. The older standing labs are
available in Git history at `labs-archive-2026-07-19`; their historical assertions
must be checked before reuse on a new engine.
