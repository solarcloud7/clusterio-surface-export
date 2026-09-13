# Build, verify and deploy a change

Work on a branch in the canonical checkout. Check `git status` before beginning;
coordinate with anyone using the shared development cluster before building into
its runtime, deploying or restarting services.

## Example: change a web component

1. Edit the component under `docker/seed-data/external_plugins/surface_export/web/`.
2. Run lint and an isolated build; run the affected component or browser regression.
3. Inspect the rendered state, errors and permissions as well as the successful path.
4. Deploy the web bundle to the development controller only when ready to inspect it.
5. Open a focused PR with the checks run, resulting behavior and remaining limits.

```powershell
npm test
./tools/clusterio/build-plugin.ps1 lint -OutputDirectory ci-artifacts/change-check
./tools/clusterio/build-plugin.ps1 test -OutputDirectory ci-artifacts/change-check
./tools/clusterio/build-plugin.ps1 all -OutputDirectory ci-artifacts/change-check
```

Run these sequentially. The wrapper uses an isolated Linux dependency environment;
the specified output directory keeps compilation away from the mounted runtime.
Do not install or prune npm packages inside the live plugin directory. A second
copy of `@clusterio/lib` there can break Clusterio's shared-library identity.

## Deploy to the development cluster

Use the existing deployment wrapper. Instance restarts disconnect players; arrange
a maintenance window and keep a backup outside the cluster for valuable worlds.

```powershell
# Web only: publish assets and reload the controller manifest.
./tools/clusterio/deploy.ps1 -Scope artifacts -Target web -RestartController
# Node handlers: restart both controller and hosts when both changed.
./tools/clusterio/deploy.ps1 -Scope artifacts -Target node -RestartController -RestartHosts
# Lua only: verify existing build artifacts, then patch current saves.
./tools/clusterio/deploy.ps1 -Scope lua -KeepSaves
# Combined plugin, web and Lua change.
./tools/clusterio/deploy.ps1 -Scope plugin -KeepSaves
```

The preserving reload takes pre-deploy saves and compares the existing world/player
observations after restart. Avoid player movement during that check. It is not an
off-host backup or proof of every entity property.

Lua/plugin deployment without `-KeepSaves` resets saves. Cluster deployment without
`-KeepData` destroys volumes. These reset paths are for deliberately disposable
worlds, not routine updates. `docker compose down -v` is also destructive.

Public alpha, beta and release-candidate versions are selected explicitly. The
deployment scripts refuse to increment them automatically. A save-preserving
update does not change the version. For an intentional fixture reset at the same
version, use `-Scope lua -SkipIncrement` or `-Scope plugin -SkipIncrement`;
these commands still reset saves. Do not combine `-SkipIncrement` with `-KeepSaves`.

Builds, deployments and integration browsers share `ci-artifacts/workflow.lock`.
If it reports an owner, let that operation finish. After a crash, verify that the
owner process has stopped before removing that specific lock.

## Serial verification and review evidence

`npm run verify` runs root tooling tests and repository lint sequentially. It does
not replace plugin unit tests or execute live acceptance by default.
`npm run verify:status` summarizes the current branch's PR and local report.
An absent or unavailable check is not a pass.

For a packaged candidate:

```text
node tools/verify-workflow.mjs --runtime <runtime.json> --startup
node tools/verify-workflow.mjs --runtime <runtime.json> --acceptance --client-volume <licensed-volume>
node tools/verification-status.mjs --offline --report <result.json>
```

The startup case tests container bootstrap without Factorio worlds. Acceptance
uses the [disposable production fixture](../../tests/manual/production-profile/README.md).
Reports retain source/candidate identity, command outcomes and bounded redacted
output. Review evidence before sharing; filtering cannot recognize every secret.
An old report does not certify changed code or a different image recipe.

To build a runtime as part of verification, pass `--build-config build.json`
instead of `--runtime`. The JSON object requires these string fields:

```json
{
  "artifact": "ci-artifacts/accepted-package",
  "commit": "<40-character source commit SHA>",
  "version": "<accepted package version>",
  "gateway": "docker/seed-data/mods/surfexp_gateways_0.6.5.zip",
  "gatewaySha256": "<64-character SHA-256 of that archive>",
  "output": "ci-artifacts/new-runtime"
}
```

Replace the placeholders with the accepted artifact's actual values. The config
file path resolves from the calling directory; build inputs and output resolve
from the repository root. `artifact` is the accepted package directory, not an
unbuilt source checkout. Use a new output directory.

Private review dispositions can be supplied to
`node tools/verification-status.mjs --findings findings.json`:

```json
{
  "schemaVersion": 1,
  "findings": [
    { "id": "R1", "summary": "Repeated request handling", "status": "fixed", "evidence": [] }
  ]
}
```

IDs must be unique. Status is `open`, `reproduced`, `fixed`, `verified` or
`not reproduced`; the last two require at least one evidence file. Evidence paths
resolve relative to the findings file. The status command reports file availability
and the declared disposition; it does not independently verify the claim. Unavailable
status exits with code 2. In PowerShell, use the direct `node` commands when passing
options to avoid npm wrapper argument handling.

## Review and delivery

Keep reproduction evidence with the fix. For cargo or ownership changes, compare
physical worlds independently and test missing, repeated and late replies, not
just the successful path. State whether failures were simulated or observed in
Factorio. Green CI does not replace review or prove universal safety.

Use [contribution guidance](contributing.md) for the PR and
[CI and release flow](ci.md) for artifact provenance. Review findings remain open
until checked; a checklist entry or existing file is not proof by itself.
