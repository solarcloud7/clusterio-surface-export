# ONE-SHOT agent brief — cheap fixtures (or LAB-TAIL fallback)

[Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md)

> ONE-SHOT TASK. Do not stop to ask questions: every decision you might need is pre-adjudicated below.
> The ONLY valid stops are (a) finished and audit-ready, (b) a hard stop condition listed at the end.
> Work the phases in order.

## Phase 0 — Orient (5 min, no cluster writes)
1. Fresh branch off current main (`b07d11d` or later). The repo checks out LF everywhere as of today:
   run `git config core.autocrlf false && git rm -rf --cached . -q && git reset --hard` in your clone
   before editing anything.
2. Duplicate-work check: if a branch or PR matching `*cheap-fixture*`/`*bare-platform*` already exists
   on origin, OR `./tools/rcon.ps1 11 "/sc rcon.print(table_size(storage.async_jobs or {}))"` returns
   nonzero (someone owns the cluster), SKIP to **Phase L** at the bottom instead. Otherwise you own the
   cluster until you stop; verify health: `./tools/show-cluster-status.ps1`.
3. Shell facts: `rc11`/`rc21` aliases DO NOT exist for you — always `./tools/rcon.ps1 11|21 "..."`.
   Plugin/instance logs live in files, not `docker logs` (CLAUDE.md Observability table). PowerShell
   scripts run via `pwsh`.

## Phase 1 — Execute [2026-07-10-cheap-fixtures-agent-brief.md](2026-07-10-cheap-fixtures-agent-brief.md)
Read it fully, then apply verbatim WITH these pre-made decisions:
- **Post-gate baseline:** the tests it names were re-baselined by the single exact gate (validation is
  exact items + by-name fluids, no tolerances for transfers). Take their CURRENT main shape as the
  start point. The failed-entity-loss test already carries a legendary-quality fixture — your
  `New-KnownContentPlatform` manifest kit MUST also include one non-normal-quality item (3 legendary
  speed modules in an assembler is the proven pattern; chemical plants cap at 3 module slots).
- **Manifest grounding:** the helper physically counts the built kit ONCE and asserts ==
  `tests/integration/lib/known-kit-manifest.json`; tests then assert against the manifest. If your
  physical count disagrees with prediction, the MANIFEST follows the physical count (never the
  reverse), with a comment naming the surprise.
- **Teardown:** `Remove-PlatformSurfacesWhere` + the storage sweep. NEVER `platform.destroy()`
  (lint:lua blocks it). Poll readiness with deadline loops, never fixed sleeps (the CI
  `ci-plugin-ready` sentinel pattern is the reference).
- **Iterate per-section:** debug one migrated test with its own runner, not full-suite reruns. No
  docker restarts in debug loops.
- **Guards that will scan you:** `lint:test-grounding` (extend it with the `SCALE_FIDELITY_TESTS`
  allowlist per the brief — seed the 4 keep-the-clone tests + destination-hold), `lint:catch-swallow`
  + the pcall value-selection rule on anything you touch, `lint-commit-labels` (a docs commit touches
  doc paths only). If any DI guard fires on your change: fix the code, never add an allow (allows are
  owner-adjudicated; none is pre-approved here).
- **Commit BEFORE every teeth-test** (uncommitted work has been lost to resets twice in this campaign).

## Phase 2 — Contingencies (pre-adjudicated, do not stop to ask)
- A migrated test goes red and it looks like a FIXTURE difference: fix the fixture/migration.
- A migrated test goes red and it looks like a REAL product defect the big clone was masking: do NOT
  paper over and do NOT halt everything. Quarantine that one test (revert it to the clone fixture, add
  it to `SCALE_FIDELITY_TESTS` with a comment "pending defect investigation"), capture the evidence
  (logs + the failing assertion + repro command), continue the other migrations, and put the finding
  at the TOP of your report labeled **POSSIBLE-DEFECT**.
- Wall-clock evidence: record per-test before/after from actual run timestamps; derive all totals from
  recorded results (never hardcode).

## Phase 3 — Verify (in order, all required)
1. Allowlist teeth: unlisted clone → red → revert → green.
2. Manifest grounding assertion green.
3. `node tools/run-integration-tests.mjs` — TWO consecutive full green runs; zero leftovers after each
   (surfaces AND storage records: `locked_platforms`, `destination_holds`, `async_jobs` — assert empty,
   game unpaused, both hosts).
4. Full `npm run lint` (all 11 guards) + host-container `npm test`.
5. `package-lock.json` byte-identical, never staged. No session URLs anywhere.

Then commit, push, open the PR (body: migration table, wall-clock evidence, teeth evidence, any
POSSIBLE-DEFECT findings first) and **STOP for audit**. Do not merge.

## Hard stop conditions (the only mid-task stops)
Cluster containers unhealthy/unrecoverable · a physical census ever shows data loss on a shipped path
(not a fixture artifact) · you cannot make the full suite green twice without weakening an assertion.

## Phase L — LAB-TAIL fallback (ONLY if Phase 0 step 2 detected fixtures work already exists/running)
Wait until the cluster is idle (poll `async_jobs == 0` on both hosts, 10-minute deadline loop, then
proceed), then execute [2026-07-10-lab-tail-agent-brief.md](2026-07-10-lab-tail-agent-brief.md)
verbatim. Priority T1 (thermal V×T): its result grounds or replaces `HIGH_TEMP_THRESHOLD = 10000` —
record the measurement; changing the constant is a SEPARATE reviewed change, include the
recommendation in your report. Certify all results into `tests/labs-certified.json` in the same PR.
Same discipline block as above; stop for audit.
