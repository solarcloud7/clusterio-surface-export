# CI/CD

How continuous integration works for this project, and the non-obvious parts —
especially how Factorio is provisioned — that you need to debug or extend it.

## Table of Contents

- [Pipeline overview](#pipeline-overview)
- [Integration test flow](#integration-test-flow)
- [Factorio in CI — the runtime download](#factorio-in-ci--the-runtime-download)
- [Line endings](#line-endings)
- [Debugging a failed run](#debugging-a-failed-run)
- [Running the integration tests locally](#running-the-integration-tests-locally)

## Pipeline overview

`.github/workflows/ci.yml` runs on pull requests (including stacked PRs), pushes to `main`,
`v*` tags, and manual dispatch:

- **Fast checks** (every run) — lint, plugin and root unit tests, and Lua regressions.
  TypeScript builds reject unused locals and parameters. This runs alongside integration tests.
- **Integration Tests** (every PR/push) — build the plugin, stand up the full Docker
  cluster (controller + 2 hosts + 2 instances), and run the full integration suite
  against it via `tools/tests/run-integration-tests.mjs`, which auto-discovers every
  `tests/integration/*/run-tests.{ps1,mjs}`.
- **Test release package** (tags and manual dispatch) — build once, pack once, install
  the tarball normally and run native transfer/recovery acceptance. Retain the accepted
  tarball and report together as the immutable `tested-package-<attempt>` workflow artifact.
- **Verify package handoff** (after package acceptance) — download that artifact in a
  separate job, verify its hashes, version, commit and acceptance evidence, then run
  `npm publish <tarball> --ignore-scripts --dry-run`.
- **Publish to npm** (tags only) — after all checks pass, download and verify the same
  artifact again and publish it with provenance. No build, install, pack or lifecycle
  scripts run here. The tag must match `package.json`'s version.

## Integration test flow

The [package-install acceptance lab](../tests/manual/package-install/README.md)
packs an explicitly built candidate, installs it with normal npm peer resolution, then
boots the installed package in disposable Factorio instances and tests lost-reply
recovery with an independent cargo oracle. Tags require this gate; ordinary PRs and
branch pushes do not run it. A manual workflow dispatch on a branch rehearses the
artifact handoff without publishing. Downloads use the exact artifact ID produced by
the acceptance job in the current workflow run. Attempt-specific names avoid overwriting
earlier packages on retries. Reports must show successful cleanup and native
acceptance; both SHA256 and npm SHA512 integrity must match the accepted tarball.
Artifacts expire after 14 days; rerun acceptance if a pending release has expired.
The dry run does not prove npm credentials, OIDC provenance or registry publication.

1. **Build plugin** — `npm ci && npm run build` (TypeScript → `dist/node`, webpack → `dist/web`).
2. **Parallel fast checks** — `npm run lint` (correctness guards: TS/eslint, Lua invariants, webpack-cache,
   test-grounding, pcall-logging, catch-swallow, test-hooks, allow-manifest — see
   the guard table in CLAUDE.md "General Style", which is the one place that enumerates them).
   (`doc-refs`, `evidence-claims`, and `lint-commit-labels` are all retired — the first two with the
   pitfall/evidence corpus they policed, the label guard 2026-08-09 with the move away from
   doc-oracle commit boundaries.)
3. **Unit tests in fast checks** — plugin `npm test`, root `npm test`, and the workflow's Lua regressions.
4. **Verify the pins** — `CLUSTERIO_IMAGE_TAG` is set in `.env`, and both instances pin the same
   Factorio version (see [Version pinning](#version-pinning-single-source-of-truth)). Both are guards
   only: Compose consumes the image tag, and Clusterio downloads each instance's pinned Factorio version at runtime.
5. **Create `factorio-client-2117` volume** — compose declares it `external: true`; CI has no
   game client, but the volume must exist or `docker compose up` fails with
   "external volume not found".
6. **Start cluster** — `docker compose up -d`, then wait for controller health.
7. **Wait for instances** — wait until both instances are *created/assigned*, then drive
   `clusterioctl instance start-all` (retried) until both reach `running`. This is the reliable
   equivalent of the seed script's per-instance start, which can race the host's asynchronous
   instance-dir creation and silently leave an instance `stopped`. `running` only means the Factorio
   process exists, so the step then deadline-polls (90s) an exact RCON sentinel on both instances —
   `remote.interfaces["surface_export"]` must answer `ci-plugin-ready` — before any test may RCON in
   (this poll has measured ~57s of real unreadiness that the old fixed 10s sleep missed).
8. **Run integration suite** — `node tools/tests/run-integration-tests.mjs` auto-discovers and runs every
   `tests/integration/*/run-tests.{ps1,mjs}` sequentially against the shared cluster (Node spawns `pwsh`
   for the `.ps1` tests). The job fails if any test fails.
9. **On failure** — dump controller/host/Factorio logs, then capture and upload a re-importable repro
    (serialized source payload + host-2 save) as the `failing-repro` artifact. Saves complete
    asynchronously (`.tmp.zip` → atomic rename), so the capture resolves host-2's exact
    active save from `factorio-current.log`, deadline-polls tmp-gone + mtime + inode + size after the
    stop, and `unzip -t`-validates every captured zip before upload — a stale or truncated capture
    surfaces as a `::warning::`, never silently. The cluster is always torn down
    (`docker compose down -v`) afterward.

## Factorio in CI — the runtime download

The public `clusterio-docker-host` image **ships no Factorio**: Wube's EULA forbids
redistributing the server, so the base image leaves `/opt/factorio` empty (a multi-version
parent dir) and Clusterio downloads the mod-pack's target headless version **at runtime** on
first instance start. That is the base image's **designed** path, not a gap to work around.

CI relies on it directly. No image is built; the hosts run the published image and fetch
Factorio when their instances start.

### We used to bake it — measured, and stopped

Until 2026-07-25 CI layered a `Dockerfile.factorio-baked` image (plus `docker-compose.ci.yml`,
buildx, and a GitHub Actions layer cache) so instances would find Factorio already present. Its
stated reason was that the runtime download "raced the instance-startup wait".

Measured head-to-head on identical runners, that turned out to be false economy:

| | with bake | without |
|---|---|---|
| Build Factorio-baked image (cache **warm**) | 86s | — |
| Set up Docker Buildx | 5s | — |
| Wait for instances to start | 72s | 89s |
| **Total job** | **617s** | **523s** |

The download costs **~14s**. The bake cost **86s every run even on a cache hit**, because
restoring a ~300 MB layer is not free. Deleting it made CI **94s (15%) faster** and removed a
Dockerfile, an entire compose override file, the buildx step, and the cache scope.

It also **removed a Docker Hub dependency** — buildx pulls BuildKit from `registry-1.docker.io`,
and a run failed on exactly that the same day (`context deadline exceeded`). Our other images
come from `ghcr.io`. The trade is honest, not free: every run now contacts **factorio.com**
instead. Both are third-party availability couplings; this one is cheaper and, on the evidence
so far, no less reliable.

> The base `clusterio-docker` repo's own CI sidesteps the download differently — it provides
> `FACTORIO_USERNAME`/`FACTORIO_TOKEN` secrets so host-1 installs a **direct** client (which
> short-circuits the runtime fetch), and its second instance is `auto_start=false` so it never
> launches Factorio. We can't reuse that: we transfer between two **live** instances and run
> credential-free.

### Version pinning (single source of truth)

Both instances pin `factorio.version` in `docker/seed-data/hosts/.../instance.json` . Clusterio's host resolves the install by version (`findVersion` in `@clusterio/host`'s
`server.js`); because `/opt/factorio` is a **multi-version parent** and not a direct install, an
absent version is **downloaded** rather than a hard `"Unable to find Factorio version X"`.

**Guard.** `host-1`'s `instance.json` is canonical. CI's **Resolve & verify** step reads it and
**fails the build** if `host-2` disagrees — two instances wanting different engines would make the
hosts download two. (The third leg of this guard used to be the Dockerfile's
`FACTORIO_HEADLESS_TAG` default; it went with the bake.)

### Timing

The `Wait for instances to start` step logs `TIMER instances-running START/END`, so every run
reports what the download+start phase actually cost. Measured 2026-07-25: **~34s**, against a
180s timeout. If that number creeps, the log says so — no guessing.

## Line endings

The repository's working tree is CRLF (Windows dev). Files consumed on Linux are forced to LF via
`.gitattributes`. This mattered most for the CI Dockerfile and compose override (a CRLF Dockerfile
breaks `RUN … \` line continuations); both are gone as of 2026-07-25, but the rule still applies to
shell scripts and anything else Linux reads.

## Debugging a failed run

The **Collect logs on failure** step prints, in order: controller logs, host-1/host-2
logs, and each host's `factorio-current.log`.

- `Loaded plugin surface_export` in the host/controller logs confirms the plugin built and
  loaded — a failure after that is runtime, not a load error.
- **Phase 1 timeout** (instances never appear in `instance list`) → seeding didn't finish; check
  the controller log for `Instance seeding complete.`
- **Phase 2** drives `instance start-all` each iteration and prints its output followed by the
  current `instance list`. If the host rejects a start, the reason now surfaces in that output and
  the host logs (it used to be swallowed by the seed script's `|| true`). This phase includes the
  Factorio **download**, so a slow or failing `factorio.com` shows up here — check the host log for
  the fetch, and the `TIMER instances-running` lines for how long it actually took.
- An instance stuck `stopped`/`errored` with an **empty** `factorio-current.log` means Factorio
  launched-then-exited — look at the host-log error grep.

## Running the integration tests locally

Bring up the cluster with `./tools/clusterio/deploy.ps1 -Scope cluster` (or `docker compose up -d`), then run the whole
suite the same way CI does:

```powershell
node tools/tests/run-integration-tests.mjs                # every tests/integration/*/run-tests.{ps1,mjs}
node tools/tests/run-integration-tests.mjs --only gateway # filter by dir-name regex
node tools/tests/run-integration-tests.mjs --list         # dry-run: list discovered tests
```

The runner needs `pwsh` for the `.ps1` tests (`brew install powershell` on macOS). To run a single
test directly:

```powershell
node tests/integration/gallery-suite/run-tests.mjs
```

Locally you rarely hit the Factorio-download cost at all: with `FACTORIO_USERNAME` /
`FACTORIO_TOKEN` set, host-1 caches the game client in the persistent external
`factorio-client-2117` volume (which survives `down -v`), and you rarely `down -v`.

There is nothing to layer any more — `docker compose up -d` is the whole story, same as CI. The
old recipe here built a `clusterio-docker-host:factorio-baked` image and stacked
`docker-compose.ci.yml` on top of the base compose; both files were deleted 2026-07-25 when the
bake was measured and found to cost more than the download it avoided.
