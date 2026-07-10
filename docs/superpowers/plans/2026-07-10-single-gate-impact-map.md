# Single-gate rewrite impact map — every consumer of the two-stage verdict (task #30 input)

> **Provenance:** read-only code cartography, 2026-07-10, commissioned after fluid-lab R11 (`e8c7bbe`, audited)
> licensed the single frozen-world exact gate. Verified against `codex/composite-transfer-verdict` HEAD.
> `PLUGIN` = `docker/seed-data/external_plugins/surface_export`. This map feeds the #30 rewrite brief; the
> LANDMINES section lists what the rung spec did not anticipate. Owner-adjudication items are marked.

## 0. TOP LANDMINES

1. **Failed-entity FLUIDS are never subtracted from expected fluid counts.** Items are
   (`PLUGIN/module/core/import-completion.lua:288-306`); `adjusted_verification.fluid_counts` passes through
   untouched (:302,324). Today the band absorbs it; under an exact gate **any transfer with a fluid-bearing
   failed entity fails, always**. Rewrite must subtract `fel.fluids` (name-keyed, `entity_creation.lua:149`)
   distributing across temp keys like the write_rejected loop (:580-598). Regression guard: extend
   `tests/integration/failed-entity-loss` with a fluid-bearing failed-entity fixture.
2. **`FluidRestoration` does not return `dropped_fluids`** (`fluid_restoration.lua:79,168-174,202-208,220`) —
   capacity-overflow/partial-insert drops are logged but unattributed in the result. Under an exact gate a drop
   correctly FAILS, but undiagnosably. Return the attribution.
3. **`LossAnalysis.run` mutates the verdict object post-activation** (`loss-analysis.lua:328-343` overwrites
   `actualItemCounts/actualFluidCounts/totalActual*`, sets `postActivation=true`). Keeping it for reporting
   after a frozen-census verdict = stored result shows post-activation numbers under a frozen verdict.
   **Decision: write to a separate `postActivationReport` sub-object; gate fields immutable after verdict.**
4. **Prometheus `failure_stage` label consumes `failedStage`** (`lib/metrics.ts:101-107`) — externally-scraped
   schema. **Decision: keep the label, re-derive from which category mismatched in the single gate.**
5. **`clear_validation_result` on fluid failure** (:649) deletes the stored debug result — behavior disappears
   with the block; no in-repo consumer relies on the nil (E2E docs mention it).
6. **`emit_debug_import_result` runs 3×** (:485,638,736) — collapse to gate-time + final.
7. **`phase_spans` order** — fluids span currently after validation (:733-734); restamp at the new injection
   site or the web waterfall lies. `job.metrics.fluids_deferred` has zero consumers — delete.
8. **The single census must be fed `segment_temps`** — `validate_import` counts fluids via
   `SurfaceCounter.count_fluids(surface)` with NO segment_temps (`transfer-validation.lua:194`); the R11 seam
   passed them (:344-346) to avoid proxy-lag temp-key mismatch. An exact gate without them false-fails on
   cosmetic temp-key drift.
9. **Gate granularity is a real decision**: current fluid gate aggregates ALL fluids by name
   (`transfer-validation.lua:16-30`). R10/R11 measured by-name exactness. **Decision: exact BY-NAME**
   (volume conservation is the parity contract; temperature handled by the high-temp energy display).
   Consolidate the duplicate `aggregate_fluid_counts_by_name` helper (import-completion.lua:31-38).
10. **Destination disposition on single-gate failure — OWNER ADJUDICATION.** Today: item failure → dest left
    paused for investigation (:527-533); fluid failure → dest DISCARDED (:639-651) because already activated.
    Retiring the discard path leaves every failure as a paused dest copy + preserved source (safe — source
    canonical — but ENGINEERING_FAQ "handshake-or-discard" language and `fluid-gate-detects-loss`'s
    "dest discarded" assertion assume discard).
11. **Non-transfer imports (uploads/clones) still inject post-activation** (:236-256). **Decision: unify to
    frozen injection** (one order in the file); `test_defer_clone_activation`'s "no activation, no fluids"
    contract changes (no in-repo consumer today).
12. **Item exactness citation**: LAB-A residual 0/0 (`793e3f`-era evidence, commit `d666b23`) is the
    load-bearing justification for retiring STRICT_ABS/PCT — cite in the diff.

## 1. Lua core flow (change table)

`import-completion.lua`: header (5-8) rewrite · `quarantine_destination_after_discard_failure` (85-113)
DELETE (per #10) · ghost-buffer comment + `fluids_deferred` (130-135) DELETE · non-transfer branch (236-256)
per #11 · `restore_held_items_only` (334) KEEP pre-census · **R11 seam (339-366) RETIRES; its body is the
production blueprint** (injection call, segment_temps-fed census, write-rejected-adjusted expectations move
into the main path; `configure.lua:55-59` allowlist entry + `r11FrozenFluidMeasurement` (:604) go with it) ·
`test_force_item_loss` (368-419) KEEP · `validate_import(..., {skip_fluid_validation=true, strict=true})`
(421-425) becomes THE single gate (skip flag removed; expected fluids adjusted pre-call: write_rejected +
fel.fluids) · `test_force_validation_failure` (429-446) KEEP · verdict fields (448-458) set once ·
attachments (465-482) KEEP · first store+emit (484-485) becomes the ONLY store (verified: no subscriber fires
on store; controller driven solely by send_json :787) · failure branch (527-533) now covers ALL failures ·
unpause+activate (537-543) strictly after verdict · post-activation fluid restore (545-568) DELETE (optional:
keep R11d-style post-activation recount as a NON-GATING drift log) · write_rejected subtraction (577-598)
MOVES pre-gate · `LossAnalysis.run` (600-605) reporting-only per #3 · `test_force_fluid_loss` (607-632)
RE-SITE pre-gate (inflate `adjusted_verification.fluid_counts`; update `scripts/lint-test-hooks.mjs:38`
comment) · `validate_fluids_post_activation` + discard + quarantine + clear (635-654) DELETE · gateway park
(663-689) KEEP, `success` = single verdict · tick stamps/spans (695,733-734) restamp · perf print/history
(796-813) KEEP.

`transfer-validation.lua`: `FLUID_GAIN/LOSS_TOLERANCE` (13-14) DELETE · `aggregate_fluid_counts_by_name`
(16-23) keep per #9 · `validate_fluid_counts` (25-64) rewrite to exact compare, called inside `validate_import`
unconditionally for transfers · `skip_fluid_validation` (70) remove · `STRICT_ABS/PCT` (212-217) retire to
exact-with-epsilon · loose non-strict path (272-281) decide fate for non-transfer callers ·
`count_fluids` call (194) must pass segment_temps · `validate_fluids_post_activation` (363-389) DELETE ·
store/clear/get (391-451) KEEP (clear loses its only caller).

`loss-analysis.lua`: `LOSS_TOLERANCE_PCT/ABS` (15-16) display-only (highTempAggregates.reconciled) — keep,
must not influence verdict · `run()` reporting-only per #3 · keep producing `fluidReconciliation` for web.

**Retired-field consumers**: `destinationDiscarded/Escalated/Quarantined/QuarantineError` — writers
import-completion.lua:86,106,108,645; readers in code: NONE (confirmed); textual:
`test/composite-transfer-verdict.test.cjs:227`, the on-hold gate-hardening brief. `failedStage` consumers:
transfer-validation.lua:371-375 · import-completion.lua:454-456 · `shared/dto.ts:179` · `messages.ts:1339` ·
`lib/transfer-orchestrator.ts:304` · `lib/metrics.ts:101` · `web/TransactionLogsTab.tsx:283,575` · tests
(`fluid-gate-detects-loss/run-tests.ps1:83,102-105`, `composite-transfer-verdict.test.cjs:145-248`,
`run-r10.mjs:354,437`, `run-r11.mjs:368`) · docs (TRANSFER_2PC.md:93, ENGINEERING_FAQ.md:143,
CLAUDE.md:692,698,843, pr-3 plan:50).

## 2. Expected-count adjustments moving with the gate
write_rejected: run between injection and census; if gate is by-name use the R11 helper
(`expected_fluids_after_rejected_writes`, :46-52), else the temp-key loop (:580-598). Fixture
`entity-roundtrip/test-cases.json:461-478` (fusion, `fluidWriteRejected: true`) must stay meaningful.
fel.fluids: THE GAP (landmine #1). inventory_overflow: items-only, unchanged. dropped_fluids: landmine #2.

## 3. TS layer
`shared/dto.ts:176-213` ValidationResult (`failedStage`:179, `postActivation`:194, `fluidReconciliation`:
203-211) — index signature means no type errors on removal; grep-driven cleanup. `messages.ts:1339` mirror.
`instance.ts:676-786` — dual-success re-derivation ALREADY FIXED at HEAD (comment :718-720; success derived
once; fail-closed on missing payload :737-739). `transfer-orchestrator.ts` — 277-279 timeout synth keep;
303-304 update; 334-374/376-403 unchanged. `transaction-logger.ts:114-120,149` keep (actuals source per #3).
`controller.ts` — no direct validation-field reads. `tools/get-transaction-log.ps1:255-258,357-378,443`
update alongside.

## 4. Web UI (`.tsx`/`.ts`)
`TransactionLogsTab.tsx:283,575` failedStage render — update per #4/#10 · fluid rows (289-305,392-489,
675-688) KEEP; frozen-vs-post-activation actuals per #3 · `utils.ts` waterfall rows (147,270,305-332) keep,
tick source moves; high-temp thermal display (473-640) unchanged · `view-models.ts` clean.

## 5. Tests
**Goes RED, rewrite into the single-gate guard:** `test/composite-transfer-verdict.test.cjs` (wholesale —
becomes: injection-before-census, census-before-activation, no post-activation verdict writer,
hook-before-gate) · `tests/integration/fluid-gate-detects-loss` (re-sited hook; assert single gate fails +
source preserved + dest disposition per #10; the adversarial fixture MUST survive) ·
`tests/no-tick-sync-lab/run-pr0b.test.mjs:13` + `no-tick-sync-selftest.lua:80` (skip_fluid_validation
literal) · `run-r11.mjs` becomes historical (keep committed; decide re-point for version-bump re-cert).
**Stays green/meaningful (verify):** gate-detects-loss · transfer-fidelity (physically grounded) ·
force-bonus-sync · rollback · platform-roundtrip (becomes the primary clean-transfer evidence; README doc
update) · entity-roundtrip fusion cases · destination-hold/engine-invariants/ground-item-fidelity/
passenger/gateway/lock · node tests (messages.roundtrip auto-discovers; canonical-identity:222 shape-only).
**Extend:** failed-entity-loss + fluid-bearing fixture (landmine #1 guard). lint-test-hooks comment update;
the rewritten fluid test needs physical cross-grounding (lint-test-grounding).

## 6. Docs needing rewrite (list)
CLAUDE.md Import Phase Ordering steps 6-10 + "Steps 7→8 inseparable" (688-698) · #15 composite sentence ·
#17 re-scope (R11 landed) · #28 closing rule (:843) · Known-Limitations inject-after-activation bullet ·
api-notes rule re-scope · TRANSFER_2PC.md:89-93 + :46 · TRANSFER_WORKFLOW_GUIDE.md:115-137 ·
ENGINEERING_FAQ.md:142-143 + discard-language rows per #10 · gate-hardening brief (superseded) ·
pr-3 plan:50 · FAILED_ENTITY_LOSS_TRACKING.md (+fluid subtraction) · E2E_TEST_GUIDE.md:118-127,330 ·
TRANSFER_CODE_PATHS.md:161 (already stale re-fetch claim) · EXPORT_IMPORT_FLOW.md:171 ·
platform-roundtrip README:102-119 · memories: low-temp-fluid-gate (superseded), backlog GATE-4.

## 7. Ordering constraints — confirmed preserved
Phase-0 force sync upstream · hub inventories → belt single-tick → entity state (Phase 1) before Phase 2;
**entity state sets recipes and crafter fluidboxes exist per-recipe — injection must stay after state
restoration** (inherited recipe-enable + write-assert hazard; satisfied: injection lands in Phase 2) ·
beacon-first two-pass then blanket deactivate+re-pause (:174-229) precede injection (the R11 seam's exact
position :339) · `FluidRestoration` touches only fluidbox APIs, no inventories/active/crafting_speed; no
cross-dependency with inventory passes in either direction · held pass independent (held_stack vs fluidbox) ·
gate before activation; activation+unpause+gateway park one synchronous execution (no-tick-sync PR0b + R11d
at-scale proof).
