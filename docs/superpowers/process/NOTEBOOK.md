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
