# CI and release artifacts

The [workflow](../../.github/workflows/ci.yml) runs on pull requests, pushes to
`main`, `v*` tags and manual dispatch. Read a result at its exact head revision;
a green run on an earlier revision does not cover later changes.

## Checks

Fast checks use Node 24, plugin lint/build and unit checks, root tooling tests and
Lua regressions. Integration runs in two independent matrix environments:
the gallery suite and the remaining suites. Each builds and seeds its own cluster.
This prevents save and recovery history left by one group from changing the
other group's starting world. It increases runner use, not necessarily elapsed
wall time by the same amount.

The Factorio runtime is pinned by `factorio.version` in the seed instance
configuration, and Clusterio 2.0.0-alpha.27 in package dependencies. `.env.example` selects the Docker
image revision. CI creates the declared external client volume and waits for
seeding/readiness before invoking integration discovery.

On failure, inspect the first failed stage and its retained artifacts. Setup,
download, readiness, test, and cleanup failures mean different things. A captured
save can be stale or incomplete if flush checks failed; a file's presence is not
a valid reproduction by itself. The workflow uploads bounded failing evidence
and tears down its own cluster.

## Package acceptance and publication

Tags and manual dispatch also build once, pack once, install the resulting
tarball normally and run native package acceptance. The accepted package and
report are retained together for 14 days. Later jobs download that exact artifact
ID, verify hashes, package version, commit and acceptance evidence, then rehearse
publication with lifecycle scripts disabled.

Tag publication additionally requires fast/integration checks and the
`npm-publish` environment. It publishes the same verified tarball with provenance;
it does not rebuild or repack. Prerelease versions use the derived prerelease
distribution tag rather than silently replacing the stable tag. A manual dry run
does not prove credentials, provenance exchange or actual registry publication.

The [package lab](../../tests/manual/package-install/README.md) records exactly
which artifact was exercised. The [fixture runtime builder](../../tests/manual/production-profile/build-runtime.mjs)
builds disposable acceptance images from accepted package bytes. These images are
test inputs, not the plugin's distribution. Source version,
accepted tarball, image identity, deployed runtime and published release are
separate facts. Do not describe a local source edit as deployed or published.

## Local iteration

Use [isolated checks](workflow.md) and [test selection](testing.md) before full CI.
Investigate a reproduced failure locally where possible; don't repeat full
integration solely to rediscover an already isolated syntax or lint error.
After a stacked base merges, check that the rebased PR head actually has workflow
runs. After an authorized merge, inspect `main`'s own run.

Historical timings depend on fixture sizes, image caches and runner conditions.
The current workflow establishes what runs; it does not promise the duration of
the next CI run.
