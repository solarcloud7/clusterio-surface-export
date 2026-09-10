# Package install acceptance

Contract: pack the explicitly built candidate once, install that tarball through normal
npm dependency resolution in a disposable pinned Clusterio image, then boot both
Factorio 2.1.17 instances using only the installed package. No checkout files may fill
holes in the installed runtime. Preserve the tarball hash, file list and installed tree
hash, and require matching hashes in the lab. Verify entrypoint loading, peer identity,
web manifest files and Lua version. The existing lost-source-reply fixture must retain
exact physical cargo, one import and complete recovery after controller restart.

```powershell
./tools/clusterio/build-plugin.ps1 -Target all
node tests/manual/package-install/run.mjs --cleanup-proof
node tests/manual/package-install/run.mjs --run
node tests/manual/package-install/run.mjs --analyze ci-artifacts/<run>/result.json
```

The pack step uses `--ignore-scripts` because artifacts have already been explicitly
built; it does not test the publish lifecycle. The consumer install runs normal hooks
and peer resolution, without `--force` or `--legacy-peer-deps`. Installation and all
game tests occur in owned containers; no host package installation or live-cluster
deployment occurs. Cleanup uses the existing name-and-label guards. If interrupted,
use the manual transfer runner's `--cleanup <run-id>` command.

First prove cleanup after an intentional post-install failure, then run one full
fixture. Missing package files, incompatible peers or parser/setup errors are
`HARNESS_ERROR` with raw error evidence; valid cargo/recovery violations are `STOP`.
Stop before later stages when either occurs. The existing ten-minute setup/case and
bounded RCON limits apply; npm installation has a two-minute command deadline.
Observer, fixture and runtime hashes are retained. No new Factorio API is used.

## Upgrade and rollback boundary

Public npm metadata inspected on 2026-09-10 reports `0.9.82` as the latest published
release, with peer requirements `^2.0.0`. The candidate pins `2.0.0-alpha.27`; that
prerelease is outside the old package's declared peer range. An upgrade/downgrade
test must not bypass peer checks and call the result supported.

This fixture tests a candidate tarball on existing seed saves plus controller restart,
not a 0.9.82-to-current migration or an old-code rollback of current journals. Those
need a separately defined, compatible baseline and explicit recovery-state migration
acceptance. The candidate is not published by this tool. It does not test npm
provenance, graphical locale/icon export, an authenticated browser session or a
full consumer installation of the separate gateway mod.

## Recorded acceptance: 2026-09-10

Candidate `0.10.281` installed normally in the pinned image. Node entrypoint, four
Clusterio peer versions, shared library resolution, web manifest files and package/Lua
manifest version checks passed. The installed runtime tree was copied without
checkout additions and its hash matched the staged two-instance runtime.

- `se-manual-mtv104bu-cc550816`: intentional post-install failure, cleanup passed.
  [Raw cleanup report](evidence/cleanup-0.10.281.json).
- `se-manual-mtv10x67-8bc19d18`: package-only transfer and lost-source-reply recovery
  passed on Factorio 2.1.17. Exact physical cargo, one import and one usable destination
  after normal recovery; all lab resources removed.
  [Raw acceptance report](evidence/installed-0.10.281.json).
- [Published 0.9.82 metadata](evidence/published-0.9.82.json) retains its immutable npm
  integrity and peer ranges. The pinned image's `semver.satisfies('2.0.0-alpha.27',
  '^2.0.0')` returned false. No forced historical install or old-code rollback ran.

The final offline analyzer adds negative tests for missing packed files, mismatched
versions, substituted runtime trees, cargo changes, repeated imports and missing
cleanup. It replays the retained native result as PASS; these analyzer-only changes
did not require a second game run. The reports retain the hashes of the runner used
for the actual observation, rather than rewriting them to the later analyzer revision.

This is a tested candidate package, not a new npm release. The publish workflow still
builds its own artifact; this manual result does not certify a future publish's bytes.
Before shipping, test the final versioned artifact and define the compatible upgrade
baseline. The supported historical migration path remains undecided.
