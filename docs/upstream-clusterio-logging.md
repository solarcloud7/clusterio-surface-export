# Upstream logging improvements for `@clusterio/host` (Factorio version resolution)

Tracking doc for diagnostics to add to **Clusterio's host package** in a future upstream PR.
These live in `@clusterio/host`, not in this repo, so they can't be fixed here — this file
records exactly what to change so it can be done later.

## Why

An instance silently failed to start and CI just timed out with `exit code 124` and no usable
error. The real cause — Clusterio's host throwing **`Unable to find Factorio version 2.0.73`**
because the installed/baked Factorio (`2.0.76`) didn't match the instance's pinned
`factorio.version` (`2.0.73`) — was thrown but never surfaced:

- it lands in the **host** log (not `factorio-current.log`, which stayed empty because Factorio
  never launched — we kept looking in the wrong file), and
- nothing reflected it in the instance's status, so `clusterioctl instance list` gave no hint.

It took hours to diagnose what should have been a one-line error. The changes below make the
failure self-explanatory.

> Refs are against the installed `2.0.0-alpha.25` build at
> `node_modules/@clusterio/host/dist/node/src/`. Re-check line numbers against the source
> (`packages/host/src/server.ts`, `Instance.ts`) when opening the PR.

## 1. `server.ts` — `findVersion()` (~`server.js:208`): put context in the throw

Today both failure branches throw a bare `Unable to find Factorio version ${targetVersion}`
(`server.js:215` direct, `:245` multi-version) — no indication of *where* it looked or *what*
was installed. Make the message actionable:

```js
// direct-install branch (~215)
throw new Error(
  `Unable to find Factorio version ${targetVersion} at direct install ${factorioDir} `
  + `(installed: ${directVersion ?? "none"})`
);
// multi-version branch (~245)
throw new Error(
  `Unable to find Factorio version ${targetVersion} in ${factorioDir} `
  + `(installed: [${[...versions.keys()].join(", ") || "none"}])`
);
```

Now the error alone says "instance wants 2.0.73, dir has [2.0.76]" — instantly diagnosable.

## 2. `server.ts` — `checkForUpdates()` (~`server.js:845`): log the resolution decision

It logs the download paths (`:858/:862/:865`) but not the "matched, using installed" case nor
the inputs. Add one info line up front summarising the decision:

```js
this._logger.info(
  `Factorio version resolution: target=${this._targetVersion}, `
  + `latest-available=${latestVersion?.version ?? "none"}, `
  + `installed=[${[...installedVersions.versions].join(", ")}], direct=${installedVersions.direct}`
);
```

Makes "why did/didn't it download" obvious in normal logs.

## 3. `Instance.ts` — surface start failures at the instance level (~`Instance.js:548`)

When `checkForUpdates()`/`findVersion()` (or any startup step) throws, ensure the reason is:

- logged at `error` level with the instance id/name, **and**
- reflected in the instance's status/error so `clusterioctl instance list` shows *why* it won't
  start — not just a silent transition to `stopped`/`errored`.

This is the highest-value change: an operator should see the cause from `instance list` without
reading raw container logs.

## Interim mitigation (already done, no upstream needed)

- This repo's CI (`.github/workflows/ci.yml`) greps the **full** host logs for these errors and
  dumps `instance list` on failure — see [CI_CD.md](CI_CD.md).
- The base image entrypoint logs the resolved `factorio_directory` + installed versions on
  startup — see `solarcloud7/clusterio-docker` (`scripts/host-entrypoint.sh`).
