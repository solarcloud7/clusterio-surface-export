# CI/CD

How continuous integration works for this project, and the non-obvious parts —
especially how Factorio is provisioned — that you need to debug or extend it.

## Table of Contents

- [Pipeline overview](#pipeline-overview)
- [Integration test flow](#integration-test-flow)
- [Factorio in CI — why we bake it](#factorio-in-ci--why-we-bake-it)
- [Line endings](#line-endings)
- [Debugging a failed run](#debugging-a-failed-run)
- [Running the integration tests locally](#running-the-integration-tests-locally)

## Pipeline overview

`.github/workflows/ci.yml` runs on PRs to `main`, pushes to `main`, and `v*` tags.
Two jobs:

- **Integration Tests** (every PR/push) — build the plugin, stand up the full Docker
  cluster (controller + 2 hosts + 2 instances), and run the full integration suite
  against it via `tools/run-integration-tests.mjs`, which auto-discovers every
  `tests/integration/*/run-tests.{ps1,mjs}`.
- **Publish to npm** (tags only) — build and publish the plugin after tests pass,
  verifying the git tag matches `package.json`'s version (`--provenance`).

## Integration test flow

1. **Build plugin** — `npm ci && npm run build` (TypeScript → `dist/node`, webpack → `dist/web`).
2. **Lint** — `npm run lint` (nine correctness guards: TS/eslint, Lua invariants, webpack-cache,
   test-grounding, pcall-logging, catch-swallow, test-hooks, doc-refs, allow-manifest — see the
   guard list in CLAUDE.md "General Style"). A tenth, `lint-commit-labels`, runs as its own PR-gated
   step (docs commits must touch only doc paths).
3. **Test** — `npm test` (message round-trip + wire contract).
4. **Resolve & verify pinned Factorio version** — see [Version pinning](#version-pinning-single-source-of-truth).
5. **Build Factorio-baked host image** — see [Factorio in CI](#factorio-in-ci--why-we-bake-it).
6. **Create `factorio-client` volume** — compose declares it `external: true`; CI has no
   game client, but the volume must exist or `docker compose up` fails with
   "external volume not found".
7. **Start cluster** — `docker compose up -d`, then wait for controller health.
8. **Wait for instances** — wait until both instances are *created/assigned*, then drive
   `clusterioctl instance start-all` (retried) until both reach `running`. This is the reliable
   equivalent of the seed script's per-instance start, which can race the host's asynchronous
   instance-dir creation and silently leave an instance `stopped`. `running` only means the Factorio
   process exists, so the step then deadline-polls (90s) an exact RCON sentinel on both instances —
   `remote.interfaces["surface_export"]` must answer `ci-plugin-ready` — before any test may RCON in
   (this poll has measured ~57s of real unreadiness that the old fixed 10s sleep missed).
9. **Run integration suite** — `node tools/run-integration-tests.mjs` auto-discovers and runs every
   `tests/integration/*/run-tests.{ps1,mjs}` sequentially against the shared cluster (Node spawns `pwsh`
   for the `.ps1` tests). The job fails if any test fails.
10. **On failure** — dump controller/host/Factorio logs, then capture and upload a re-importable repro
    (serialized source payload + host-2 save) as the `failing-repro` artifact. Saves complete
    asynchronously (`.tmp.zip` → atomic rename; see the save-completion entry in
    [factorio-2.0-api-notes.md](factorio-2.0-api-notes.md)), so the capture resolves host-2's exact
    active save from `factorio-current.log`, deadline-polls tmp-gone + mtime + inode + size after the
    stop, and `unzip -t`-validates every captured zip before upload — a stale or truncated capture
    surfaces as a `::warning::`, never silently. The cluster is always torn down
    (`docker compose down -v`) afterward.

## Factorio in CI — why we bake it

The public `clusterio-docker-host` image **ships no Factorio**. Wube's EULA forbids
redistributing the server, so the base image leaves `/opt/factorio` empty and Clusterio
downloads the headless server **at runtime** on first instance start (`checkForUpdates`
fires because `factorio_directory` points at a multi-version parent dir).

On CI that is a problem: every run is a fresh runner with `down -v`, and our tests need
**both** instances `running` with **no Factorio credentials**, so both hosts re-download
Factorio from scratch on every run. That download raced the instance-startup wait and
caused intermittent timeouts.

> The base `clusterio-docker` repo's own CI sidesteps this differently — it provides
> `FACTORIO_USERNAME`/`FACTORIO_TOKEN` secrets so host-1 installs a **direct** client
> (which short-circuits the runtime fetch), and its second instance is `auto_start=false`
> so it never launches Factorio. We can't reuse that: we transfer between two **live**
> instances and run credential-free.

### The fix: bake + layer-cache

- **`docker/ci/Dockerfile.factorio-baked`** — `FROM` the public host image and bake the
  headless server into `/opt/factorio` (the exact `curl … | tar -xJ` the base image
  documents under its `BAKE_FACTORIO_HEADLESS` build arg). Built and used **only on the
  runner, never pushed** — so the no-redistribution EULA is not implicated (the same
  condition the base image's bake path is documented for).
- **`docker-compose.ci.yml`** — overrides both host services to the locally-built
  `clusterio-docker-host:factorio-baked` image (`pull_policy: never`). Layered onto the
  base compose via `COMPOSE_FILE=docker-compose.yml:docker-compose.ci.yml`.
- **`ci.yml`** — `docker/setup-buildx-action` + `docker/build-push-action` with
  `cache-from/to: type=gha`. The build **layer** is cached across runs, so Factorio is
  downloaded at most once per cache lifetime; every later run restores the layer from the
  GitHub Actions cache.

Net effect: Factorio is present in the host image on **every** run (the cache only speeds
the *build*), so instances start with **no runtime download**. Cache-miss runs are ~4 min;
cache-hit runs ~3 min.

### Version pinning (single source of truth)

The baked version **must equal the instances' pinned `factorio.version`** (in both
`docker/seed-data/hosts/.../instance.json`, currently `2.0.77`). Clusterio's host resolves the
Factorio install by version (`findVersion` in `@clusterio/host`'s `server.js`): the multi-version
`/opt/factorio` dir **downloads** the requested version if the baked one differs, and a *direct*
install **throws** "Unable to find Factorio version X" — so an instance pinned to `2.0.77` must
have `2.0.77` baked.

**Single source + guard.** `host-1`'s `instance.json` is the canonical version. CI's **Resolve &
verify** step reads it, passes it as the `FACTORIO_HEADLESS_TAG` build-arg, and **fails the build**
if `host-2`'s `instance.json` or the Dockerfile fallback default disagree. To change the Factorio
version, set all three to the same value (host-1 / host-2 / the Dockerfile `ARG`) — the guard
catches any you miss. The gha cache key includes the build-arg, so a bump triggers a one-time rebuild.

The baked image uses the **multi-version** `/opt/factorio` layout (not a direct install): if the
baked version drifts from the pin, Clusterio downloads the requested version rather than
hard-failing on `findVersion()`.

## Line endings

The repository's working tree is CRLF (Windows dev). Files consumed on Linux — the CI
Dockerfile and the compose override — are forced to LF via `.gitattributes`, because a
CRLF Dockerfile breaks `RUN … \` line continuations during the Docker build.

## Debugging a failed run

The **Collect logs on failure** step prints, in order: controller logs, host-1/host-2
logs, and each host's `factorio-current.log`.

- `Loaded plugin surface_export` in the host/controller logs confirms the plugin built and
  loaded — a failure after that is runtime, not a load error.
- **Phase 1 timeout** (instances never appear in `instance list`) → seeding didn't finish; check
  the controller log for `Instance seeding complete.`
- **Phase 2** drives `instance start-all` each iteration and prints its output followed by the
  current `instance list`. If the host rejects a start, the reason now surfaces in that output and
  the host logs (it used to be swallowed by the seed script's `|| true`). `Unable to find Factorio
  version X` means the baked image isn't the pinned version (check the Resolve & verify output / a
  stale gha cache layer).
- An instance stuck `stopped`/`errored` with an **empty** `factorio-current.log` means Factorio
  launched-then-exited — look at the host-log error grep, not the bake.

## Running the integration tests locally

Bring up the cluster with `tools/deploy-cluster.ps1` (or `docker compose up -d`), then run the whole
suite the same way CI does:

```powershell
node tools/run-integration-tests.mjs                # every tests/integration/*/run-tests.{ps1,mjs}
node tools/run-integration-tests.mjs --only gateway # filter by dir-name regex
node tools/run-integration-tests.mjs --list         # dry-run: list discovered tests
```

The runner needs `pwsh` for the `.ps1` tests (`brew install powershell` on macOS). To run a single
test directly:

```powershell
pwsh ./tests/integration/platform-roundtrip/run-tests.ps1 -ShowDetails
```

Locally you usually don't hit the Factorio-download issue: with `FACTORIO_USERNAME` /
`FACTORIO_TOKEN` set, host-1 caches the game client in the persistent external
`factorio-client` volume (which survives `down -v`), and you rarely `down -v`. To get the
same fast, credential-free cold-start CI uses, layer the baked image locally:

```powershell
$env:COMPOSE_FILE = "docker-compose.yml:docker-compose.ci.yml"
docker build -f docker/ci/Dockerfile.factorio-baked -t clusterio-docker-host:factorio-baked docker/ci
docker compose up -d
```
