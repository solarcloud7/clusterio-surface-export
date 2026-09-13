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

## Review and delivery

Keep reproduction evidence with the fix. For cargo or ownership changes, compare
physical worlds independently and test missing, repeated and late replies, not
just the successful path. State whether failures were simulated or observed in
Factorio. Green CI does not replace review or prove universal safety.

Use [contribution guidance](contributing.md) for the PR and
[CI and release flow](ci.md) for artifact provenance. Review findings remain open
until checked; a checklist entry or existing file is not proof by itself.
