# CI/CD

How continuous integration works for this project, and the non-obvious parts —
especially how Factorio is provisioned — that you need to debug or extend it.

## Pipeline overview

`.github/workflows/ci.yml` runs on PRs to `main`, pushes to `main`, and `v*` tags.
Two jobs:

- **Integration Tests** (every PR/push) — build the plugin, stand up the full Docker
  cluster (controller + 2 hosts + 2 instances), and run the entity- and
  platform-roundtrip suites against it.
- **Publish to npm** (tags only) — build and publish the plugin after tests pass,
  verifying the git tag matches `package.json`'s version (`--provenance`).

## Integration test flow

1. **Build plugin** — `npm ci && npm run build` (TypeScript → `dist/node`, webpack → `dist/web`).
2. **Build Factorio-baked host image** — see [Factorio in CI](#factorio-in-ci--why-we-bake-it).
3. **Create `factorio-client` volume** — compose declares it `external: true`; CI has no
   game client, but the volume must exist or `docker compose up` fails with
   "external volume not found".
4. **Start cluster** — `docker compose up -d`, then wait for controller health.
5. **Wait for instances** — both instances must reach `running`.
6. **Run test suites** — `tests/integration/{entity,platform}-roundtrip/run-tests.ps1`.
7. **Collect logs on failure** — dumps controller/host/Factorio logs (only when a step fails).

## Factorio in CI — why we bake it

This is the most important thing to understand about this pipeline.

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

### Version pinning

The bake uses `FACTORIO_HEADLESS_TAG=stable` (the base image's default, and the mod-pack's
target). If a run's logs show instances still downloading Factorio (a slow
`Wait for instances` step with empty `factorio-current.log`), the mod-pack targets a
different version — pin `FACTORIO_HEADLESS_TAG` to that exact version in the `build-args`
of the build step in `ci.yml`.

## Line endings

The repository's working tree is CRLF (Windows dev). Files consumed on Linux — the CI
Dockerfile and the compose override — are forced to LF via `.gitattributes`, because a
CRLF Dockerfile breaks `RUN … \` line continuations during the Docker build.

## Debugging a failed run

The **Collect logs on failure** step prints, in order: controller logs, host-1/host-2
logs, and each host's `factorio-current.log`.

- `Loaded plugin surface_export` in the host/controller logs confirms the plugin built and
  loaded — a failure after that is runtime, not a load error.
- An **empty** `factorio-current.log` means Factorio never launched — almost always the
  host is still acquiring the binary (check the bake/cache, not the plugin).
- `Wait for instances` timing out is the classic Factorio-acquisition symptom; see
  [Factorio in CI](#factorio-in-ci--why-we-bake-it).

## Running the integration tests locally

Bring up the cluster with `tools/deploy-cluster.ps1` (or `docker compose up -d`), then run
the suites:

```powershell
pwsh ./tests/integration/entity-roundtrip/run-tests.ps1
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
