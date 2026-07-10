# Cheap-fixtures agent brief — standard test fixtures + clone allowlist (queued AFTER #76 merges)

> You are the **implementer**, on a fresh branch off `main` taken AFTER PR #76 (the single-gate rewrite) has
> merged — this work re-baselines tests that #76 also touches; do not start before it lands. Orchestrator
> audits; **stop for audit before any merge.** Standard discipline: commit labels are audit boundaries
> (`lint-commit-labels` is live — docs commits touch only doc paths), pitfall citations are number + short
> name, DI-lint fires = escalate, package-lock byte-identical and never staged, no session URLs, one
> cluster-touching agent at a time.

## Why (measured)
15 of 19 integration tests clone the 1,359-entity platform (~60–90s each, the full async export→import
pipeline — `module/interfaces/remote/clone-platform.lua:63,76-78`) while only platform-roundtrip clearly
needs scale: ~12 avoidable clones ≈ 12–18 min per suite run against a 15-minute CI job timeout. The cheap
pattern already exists in every lab runner and inside destination-hold; it was never promoted into
`tests/integration/lib/TestBase.psm1`, whose only fixture primitive is the expensive clone. CLAUDE.md's
iteration-discipline rule 2 already mandates the cheapest fixture — this PR operationalizes and mechanically
enforces it.

## Build (assembled from existing proven code — do not invent new mechanics)

1. **`New-BarePlatform -Name <n> [-Width 17 -Height 17]`** in `TestBase.psm1`: hub-bearing, transfer-capable.
   Sequence (verbatim template: `tests/inserter-lab/run-b1-b4.mjs:23-26`, `tests/integration/destination-hold/
   run-tests.ps1:360-392`): `force.create_space_platform{name=..., planet='nauvis',
   starter_pack='space-platform-starter-pack'}` → `apply_starter_pack()` → unhide + unpause → parameterized
   `set_tiles` foundation loop (`space-platform-foundation`, fixed WxH, per-platform offset). Deterministic
   readiness check (hub valid + surface valid), NOT a fixed sleep. Teardown routes through
   `Remove-PlatformSurfacesWhere` + the storage sweep — never `platform.destroy()` (Pitfall #19,
   platform.destroy is a no-op; route through GameUtils/game.delete_surface).
2. **`New-KnownContentPlatform -Name <n>`**: `New-BarePlatform` + a deterministic ~30-entity mini-factory —
   belt loop with fixed item load, inserter with held stack, assembler with modules including ONE non-normal-
   quality item, pipe run + tank with fixed fluid, chest with fixed inventory. Exact entity/item/fluid totals
   committed as `tests/integration/lib/known-kit-manifest.json`; the helper PHYSICALLY COUNTS the built kit
   once and asserts == manifest (grounding), then tests assert against the manifest. The non-normal-quality
   content bakes the adversarial-fixture rule in by default.
3. **`tests/lib/lab-helpers.mjs`** (new shared lab module): extract the duplicated `rcon/lua/luaString`,
   `mk`/`read_entity`, the seven-field `cleanupInstance/zero/ok` trio (reference:
   `tests/inserter-lab/run-b1-b4.mjs:68-71`), and the `--sections` parser. New labs MUST use it. Do NOT churn
   existing committed lab runners (historical instruments) — migrate one (your choice) as the usage example.
   Labs already comply with the cheap-fixture rule; their win is consolidation (they are the version-bump
   re-certification suite — a hazard fix must become one shared edit, not 25 hand-propagated ones).

## Migrate (worst offenders ONLY — exactly these 9)
`entity-roundtrip`, `force-bonus-sync`, `gateway-transfer` (×2 clones), `passenger-evacuate` →
**New-BarePlatform**. `rollback`, `gate-detects-loss`, `fluid-gate-detects-loss`, `failed-entity-loss` →
**New-KnownContentPlatform** (manifest-exact assertions; these tests were re-baselined by #76 — take their
post-#76 shape as the starting point, including the non-normal-quality failed-entity fixture that PR added).
`destination-hold` → gate `New-HoldClone` behind its existing `-Sections` so clone-free sections never pay it.
Replace each migrated test's clone-settling `Start-Sleep`s with the helper's deterministic readiness.
**Do NOT touch:** platform-roundtrip, transfer-fidelity, ground-item-fidelity, engine-invariants (scale/
borderline — they keep the clone), the labs' committed runners, anything under module/ or the plugin TS.

## Enforce
Extend `scripts/lint-test-grounding.mjs`: a `scale-fidelity-allowlist` rule — any integration test invoking
`New-TestPlatform`/`New-IsolatedTestSurface`/`clone_platform` must be enumerated in a `SCALE_FIDELITY_TESTS`
list in the script (reviewable act, same pattern as FAIL_SAFE_HOOKS). Seed it with the 4 keep-the-clone tests
+ destination-hold. Teeth-verify: unlisted clone → red → revert → green (commit BEFORE teeth-testing; a
reset --hard has eaten uncommitted work twice in this campaign).

## Docs (pure-docs commit)
CLAUDE.md iteration-discipline rule 2 gains the pointer ("use `New-BarePlatform` / `New-KnownContentPlatform`
— clone requires the SCALE_FIDELITY_TESTS allowlist"); mirror AGENTS.md locally.

## Verification (in order)
1. Guard teeth (above). 2. Manifest grounding assertion green. 3. Per-test wall-clock BEFORE vs AFTER for all
9 migrations — the evidence table goes in the PR body (expect ~12–18 min/run saved). 4. Full
`node tools/run-integration-tests.mjs` — two consecutive green runs, zero-leftover intact. 5. All lint guards
+ host-container `npm test`. Then **stop for audit**.

## Stop conditions
A migrated test goes red for a reason that looks like a REAL product defect rather than a fixture difference
(report, don't paper over — the cheap fixture seeing something the big clone masked is a finding, not a bug
in your work) · DI-lint fires · cluster failures.
