# Process notebook

Append-only ledger for material execution anomalies that can change the interpretation, reproducibility, or safety of engineering work.
Routine command output, status narration, and session URLs do not belong here.
Do not rewrite prior entries; append a correction that cites the superseded entry.

Use `[empirical, process, YYYY-MM-DD]` for a committed or independently reproducible observation.
Use `[hypothesis, process]` when reproduction is still pending.

Record an entry only when at least one of these occurs:

- an environment assumption causes a command or verification failure;
- a tracked file changes unexpectedly;
- a workaround changes bytes or changes the evidence path;
- a lint exception is considered or escalated;
- evidence contradicts a named claim, rule, or prior conclusion.

## Entry template

### YYYY-MM-DD - Short title `[empirical, process, YYYY-MM-DD]`

- **Command/action:** Exact command or action that exposed the anomaly.
- **Expected result:** The named expectation or claim.
- **Actual result:** The observed result, including the decisive output.
- **Affected paths:** Repository-relative paths, or `none`.
- **Impact:** What evidence, scope, or safety decision could be wrong without this record.
- **Workaround:** The bounded workaround used, or `none`.
- **Final disposition:** `OPEN`, `UNEXPLAINED`, `FIXED-PROVEN`, `REFUTED`, or `SUPERSEDED`, with a short explanation.
- **Durable references:** Commit, file and line, test artifact, or reproducible command. Never a session URL.

### 2026-07-12 - Scope-test prerequisites absent from slim Node container `[empirical, process, 2026-07-12]`

- **Command/action:** Ran full plugin `npm test` in the repository's `node:24-bookworm-slim` build container after adding the pre-PR scope tests.
- **Expected result:** The new disposable-Git tests would execute alongside the existing Node tests.
- **Actual result:** All three scope tests failed before setup with `spawnSync git ENOENT`; the slim build container does not provide Git or PowerShell.
- **Affected paths:** `docker/seed-data/external_plugins/surface_export/test/check-pr-scope.test.cjs`.
- **Impact:** A tool-less build container could report a false suite failure even though the Windows-host integration test and production script are sound.
- **Workaround:** Detect both prerequisites and mark only these three tests skipped when either command is absent; execute them normally on the Windows host and GitHub runner.
- **Final disposition:** `FIXED-PROVEN` - the direct host run executes all three cases, while the slim-container run identifies the missing prerequisites and skips them.
- **Durable references:** `node --test docker/seed-data/external_plugins/surface_export/test/check-pr-scope.test.cjs`; this NOTEBOOK entry; `test/check-pr-scope.test.cjs` prerequisite detection.

### 2026-07-12 - Scope tests passed through PowerShell error promotion `[empirical, process, 2026-07-12]`

- **Command/action:** Audited the stale-base and no-origin paths of `tools/check-pr-scope.ps1` under `$ErrorActionPreference = 'Stop'`.
- **Expected result:** The stale path would explicitly exit 1 and genuine tool errors would print the intended message and explicitly exit 2.
- **Actual result:** `Write-Error` threw before both explicit exits; the stale test passed only because PowerShell's uncaught error also returned 1, while the no-origin path returned 1 with a raw line-number dump instead of 2.
- **Affected paths:** `tools/check-pr-scope.ps1`; `docker/seed-data/external_plugins/surface_export/test/check-pr-scope.test.cjs`.
- **Impact:** Tests appeared green without proving the script's documented exit-code mechanism, and callers could not distinguish stale ancestry from a broken evidence collection path.
- **Workaround:** Emit terminal failures directly to stderr with `[Console]::Error.WriteLine(...)`, preserve explicit exits 1 and 2, and add a no-origin regression case plus raw-dump exclusions.
- **Final disposition:** `FIXED-PROVEN` - disposable repositories now prove PASS=0, stale ancestry=1, and evidence-collection error=2 through the intended paths.
- **Durable references:** `node --test docker/seed-data/external_plugins/surface_export/test/check-pr-scope.test.cjs`; PR #96 audit finding; this NOTEBOOK entry.

### 2026-07-12 - Destination census ran after failed transfer discard `[empirical, process, 2026-07-12]`

- **Command/action:** Armed destination `test_force_item_loss=4` and ran the unchanged `tests/integration/ground-item-fidelity/run-tests.ps1` workflow against clone `groundfid-112256`.
- **Expected result:** A fidelity runner would adjudicate the debug verdict before interpreting destination physical counts.
- **Actual result:** `debug_import_result_groundfid-112256_398819.json` reported `validation_success=false` and `failedStage=items`; Black-Box Discard removed the destination and banked `failure_black_box_groundfid-112256_398819.json`, but the runner continued to census `GROUND=-1 TOTAL=-1` and reported a fictitious 55-item loss plus a restoration failure.
- **Affected paths:** `tests/integration/ground-item-fidelity/run-tests.ps1`; `tests/integration/lib/TestBase.psm1`; `docker/seed-data/external_plugins/surface_export/scripts/lint-test-grounding.mjs`.
- **Impact:** A correctly failed and discarded transfer is misclassified as physical fidelity loss, obscuring the real gate failure and its forensic artifact.
- **Workaround:** None during reproduction; the one-shot hook was disarmed in `finally`, and both instances ended with zero matching surfaces, jobs, holds, locks, tombstones, and `game.tick_paused=false`.
- **Final disposition:** `OPEN` - runtime reproduction promotes the W0 hypothesis and licenses the W3 shared verdict assertion and lint rule.
- **Durable references:** `debug_import_result_groundfid-112256_398819.json`; `failure_black_box_groundfid-112256_398819.json`; runner output `Dest: ground=-1 total=-1`; both-host cleanup JSON recorded in the W3 audit evidence.

### 2026-07-12 - Patch-reset checks controller after changing bytes `[empirical, process, 2026-07-12]`

- **Command/action:** Ran `./tools/patch-and-reset.ps1` while the primary surface-export controller was stopped.
- **Expected result:** The tool would reject the missing runtime precondition before mutating tracked files.
- **Actual result:** It incremented plugin/module versions from 0.10.88 to 0.10.89 and completed a build, then aborted because the controller was not running.
- **Affected paths:** `docker/seed-data/external_plugins/surface_export/package.json`; `docker/seed-data/external_plugins/surface_export/module/module.json`.
- **Impact:** A failed environment check leaves tracked version churn that can contaminate the task diff.
- **Workaround:** Restored only the attempted version bump before any feature edits; started the primary cluster separately.
- **Final disposition:** `OPEN` - banked as a tooling precondition defect; no patch-reset change is in W3 scope.
- **Durable references:** `tools/patch-and-reset.ps1`; command output ending `Clusterio controller is not running` after version/build output.

### 2026-07-12 - Compose project status hid stopped fixed-name containers `[empirical, process, 2026-07-12]`

- **Command/action:** Queried status and attempted `docker compose up -d` from the isolated W3 worktree.
- **Expected result:** No listed project containers meant the shared fixed-name cluster was absent.
- **Actual result:** Worktree Compose created project-scoped networks and volumes, then failed because stopped primary containers already owned `surface-export-controller`; the isolated `.env` was also absent until copied from the primary checkout.
- **Affected paths:** No tracked paths; temporary Compose project `factoriosurfaceexport-verdict-aware` only.
- **Impact:** Project-scoped status can falsely imply cluster ownership is free when fixed-name containers from another checkout still exist.
- **Workaround:** Removed only the isolated project's verified network/volumes and started the existing primary project; never touched `atlas-*`.
- **Final disposition:** `FIXED-PROVEN` for this session; future orientation must combine project status with fixed container-name inspection.
- **Durable references:** Docker conflict naming container `surface-export-controller`; verified removal of the isolated project's four volumes and network.

### 2026-07-12 - Missing PowerShell helper passed a success test `[empirical, process, 2026-07-12]`

- **Command/action:** Ran the first `Assert-TransferSucceeded` behavior tests before implementing the function.
- **Expected result:** Both helper tests would fail because the command did not exist.
- **Actual result:** The failure-path test failed, but the success-path test continued after PowerShell's nonterminating command-not-found error and printed `RETURNED`, producing a false green.
- **Affected paths:** `docker/seed-data/external_plugins/surface_export/test/verdict-aware-fidelity.test.cjs`.
- **Impact:** A test could claim the helper returned successfully without ever invoking it.
- **Workaround:** Set `$ErrorActionPreference='Stop'` in the spawned PowerShell test process before importing and invoking the module.
- **Final disposition:** `FIXED-PROVEN` - the tightened test went red on the missing helper, then all helper cases passed only after implementation.
- **Durable references:** `node --test docker/seed-data/external_plugins/surface_export/test/verdict-aware-fidelity.test.cjs`; this NOTEBOOK entry.

### 2026-07-12 - Verdict-blind destination census closed `[empirical, process, 2026-07-12]`

- **Command/action:** Re-ran normal ground-item and belt-replay transfers, then repeated the one-shot item-loss failure through the migrated runners.
- **Expected result:** Success verdicts permit physical census; a failed verdict throws with stage, mismatch, and black-box path before any destination census.
- **Actual result:** Ground-item passed 54/54 with six ground items; belt replay passed 19/19; the forced loss stopped with `failedStage=items` and `failure_black_box_groundfid-113447_124463.json` without printing a `Dest:` census line. Both hosts ended at zero state.
- **Affected paths:** `tests/integration/lib/TestBase.psm1`; `tests/integration/ground-item-fidelity/run-tests.ps1`; `tests/integration/belt-loss-replay/run-tests.ps1`; `docker/seed-data/external_plugins/surface_export/scripts/lint-test-grounding.mjs`.
- **Impact:** Success-path fidelity tests can no longer reinterpret Black-Box Discard as physical loss.
- **Workaround:** None.
- **Final disposition:** `FIXED-PROVEN` - shared helper behavior, two runner migrations, four lint fixtures, physical success runs, and an adversarial failed run all agree.
- **Durable references:** `verdict-aware-fidelity.test.cjs`; `lint-test-grounding.test.cjs`; debug/black-box artifact above; both-host cleanup evidence in the W3 audit report.

## 2026-07-13 - state-dimensions closer: stale bind-mount + @clusterio singleton (both recovered)

- **Command/action:** (a) First entity-burner run against a freshly patch-and-reset cluster; (b) CI-parity
  `npm ci && npm test/lint` in a node:24 container with the repo mounted at /repo.
- **Expected result:** (a) The cluster runs the primary checkout's Lua; (b) an isolated dependency install.
- **Actual result:** (a) The running containers were bind-mounted to a STALE codex worktree from a prior
  lane (`docker inspect` showed `.codex/visualizations/.../inventory-accounting` as the external_plugins
  source), so patch-and-reset patched saves with the WRONG tree's Lua — new serializer code silently absent.
  (b) npm ci executed in the real (bind-mounted) plugin dir and re-added the `@clusterio/*` peers, breaking
  clusterioctl with the documented duplicate-`@clusterio/lib` error.
- **Affected paths:** docker-compose bind mount `./docker/seed-data/external_plugins`; plugin `node_modules/@clusterio`.
- **Impact:** (a) One misleading red (burner state "not restored") + one wasted debug loop; (b) clusterioctl
  down until recovery (running instances unaffected — plugin already in memory).
- **Workaround/fix:** (a) `docker compose up -d --force-recreate` from the primary checkout, then
  patch-and-reset; verify with `docker inspect ... Mounts`. (b) `rm -rf node_modules/@clusterio` (never
  `npm prune`), verified clusterioctl + RCON + zero jobs/locks after.
- **Final disposition:** RECOVERED-PROVEN — both verified by re-runs; nine-test sweep and 31/31 full suite
  green afterwards.
- **Durable references:** `.superpowers/sdd/state-dims-report.md`; CLAUDE.md "DO NOT npm install on a
  running cluster" bullet; takeover addendum item 1 (primary-checkout requirement).
