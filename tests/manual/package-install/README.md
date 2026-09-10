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
# Retain exactly the tested bytes for a release handoff (new directory required):
node tests/manual/package-install/run.mjs --run --artifact-dir ci-artifacts/release-package
node tools/release/verify-package.mjs ci-artifacts/release-package
npm publish ./ci-artifacts/release-package/package.tgz --ignore-scripts --dry-run --access public
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

These historical reports certify a candidate, not a new npm release. They predate
the release handoff metadata and cannot authorize publication through the new gate.
The supported historical migration path remains undecided.

## Release artifact handoff

On version tags and manual dispatch, CI builds and packs once, then runs this lab.
Only a passing run with verified cleanup exports `package.tgz` and `acceptance.json`.
The report records the checkout commit, packed version, SHA256 and npm integrity.
A separate job downloads the immutable artifact by its acceptance-job output ID, replays the independent acceptance
oracle, checks both hashes and commit/version, and rehearses npm publication with
`--ignore-scripts --dry-run`. The tag-only publish job repeats verification and submits
that tarball with provenance, without rebuilding or running lifecycle scripts.
Artifact names include the workflow attempt; retries do not overwrite earlier packages
or select packages by a shared name. The publisher uses the same acceptance-job ID.

To rehearse without releasing, dispatch CI on a branch:
`gh workflow run ci.yml --ref <branch>`. Do not create a version tag for a rehearsal.
Manual dispatch on a version tag follows the release path. A dry run cannot establish
registry authentication, provenance or publication success. Local commit metadata
identifies HEAD; local dirty builds are experiments, not release authorization. CI
acceptance builds from a fresh checkout. No historical report is reused for a release.

Local handoff rehearsal on 2026-09-10: `se-manual-mtv86zp7-1eba438f` passed native
acceptance and cleanup, then passed the release verifier and npm dry run. The dry run's
name, version and SHA512 integrity matched the accepted package. Tarball SHA256:
`d6c6bbf37933d3deba4564db086719f1e75ea403919165e9ffe52c9f87e3e1d2`.
[Raw handoff report](evidence/handoff-0.10.281.json) records the base HEAD plus the
experimental runner hashes; this was a local dirty-checkout rehearsal. GitHub artifact
transport is a separate check, and no npm publication was performed.

The first hosted rehearsal passed native acceptance and artifact verification, then
exposed a preview-reader error: npm 11.19 returns JSON keyed by package name, whereas
local npm 11.6 returned a flat object. Reproduced with `node:24.20.0-bookworm-slim`;
the reader now accepts both observed shapes while requiring identical name, version
and integrity. Regression cases reject mismatches and extra package entries.
