# Paired-Reads Source Census Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Follow the canonical [Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md). This is a
> data-integrity change on the transfer spine; `/di-change` and an external adversarial audit are
> mandatory before merge. Background: [parity-verification-model.md](../../parity-verification-model.md)
> — read it first; this plan implements its tier-1 closure.

**Goal:** Every transfer export cross-checks the serializer's ledger against an independent
per-entity physical census taken in the same Lua execution, and aborts fail-closed (source
preserved, entity-attributed report) on any disagreement — converting every serializer-omission
bug, present or future, from silent loss into a loud pre-transfer abort.

**Architecture:** Paired reads. During the existing async export walk, immediately after each
entity is serialized and *within the same Lua execution*, the same entity is physically counted by
the census meter (the engine-enumerated `SurfaceCounter` logic, refactored to a per-entity
function — never the handler taxonomy). Frozen/static families pair across the multi-tick walk
(safe: deactivated entities cannot exchange items between ticks); belts pair inside the existing
atomic single-tick pass in `complete_export_job`. Mismatches are recorded per entity; any mismatch
on a transfer export aborts before the destination is contacted.

**Tech Stack:** Factorio 2.0.77 Lua (save-patched module), PowerShell integration probes, Node
test/lint harness, two-host Clusterio dev cluster.

## Global Constraints

- Do not alter the exact gate, its tolerances, expected-count subtraction, source-delete
  semantics, or quality-key formatting. This plan adds a check *before* the transfer; the gate is
  untouched.
- Exact comparison for items (per quality key); fluids aggregate-by-name at epsilon `1e-6` — the
  gate's existing constants, no new thresholds or bands (owner law: no floors/bands on the
  transfer spine).
- ONE census meter: reuse `SurfaceCounter` logic. Do not write a second physical counter
  (Decision 2 below locks this).
- Reconciled conventions apply to both meters identically: engine-owned-category fluids excluded;
  fusion-reactor output behavior is import-side only and does not affect the source census.
- The paired read for any entity MUST occur in the same Lua execution as that entity's
  serialization. Never split the pair across executions.
- `package-lock.json` byte-identical; no new lint allow without owner adjudication; no session
  URLs; stop for audit before merge; watch main's post-merge run.
- **Line-cite caveat:** Phase-2 file/line anchors must be re-resolved at execution HEAD — this
  plan is written before the state-dimensions and inventory-accounting branches merge, and they
  touch the same files.

## Lane Scheduling — how this avoids blocking other work

| Phase | Needs cluster? | Conflicts with running lanes? | May start |
|---|---|---|---|
| 0 — stall-budget rung + decisions | briefly (idle window, read-mostly) | none (no repo files touched; lab runner is a new untracked file) | now |
| 1 — census core, new files + unit tests | no | none (new files only) | now, in parallel with anything |
| 2 — export-walk integration | no (code) | **yes** — `async-processor.lua`, `export-pipeline.lua` overlap state-dimensions and PR #98 | only after state-dimensions merges and main is green |
| 3 — live evidence | yes (owns cluster) | scheduling only (one cluster owner at a time) | after Phase 2 |
| 4 — /di-change, audit, PR | no | none | after Phase 3 |

The critical path (state-dimensions → cheap fixtures → PR-3) is not delayed: Phases 0–1 are
file-disjoint and mostly cluster-free, and Phase 2 deliberately queues behind the lanes it would
otherwise conflict with.

## Decisions — ADJUDICATED (owner-approved 2026-07-12, all five as recommended)

> Owner ruling, verbatim intent: "we want this just like this." Executors implement these as
> settled law; do not re-open them. The original decision text is retained below for the record.

1. **Abort scope.** Hard-abort on *transfer* exports (fail-closed, source stays locked-then-
   unlocked, destination never contacted). Export-to-file and upload paths: census runs, mismatch
   is a loud warning + annotation in the payload metadata, not an abort (no deletion risk on those
   paths). Recommended: yes.
2. **Meter reuse.** Refactor `SurfaceCounter.count_items`/`count_fluids` to expose per-entity
   functions and build the surface totals from them, so gate and census share one meter
   implementation. Recommended: yes (a second counter would eventually drift from the first).
3. **Fluids in scope.** Census fluids per-entity in the same walk, compared aggregate-by-name at
   the end. Recommended: yes — same walk, machinery exists.
4. **Report channel.** Mismatch bundle reuses the always-on black-box pattern (JSON to
   script-output + summary through the transaction log), entity-attributed rows included.
   Recommended: yes.
5. **Test hook.** New debug-gated one-shot `test_force_census_omission` (drops one serialized
   inventory record post-serialization, pre-census-comparison). It is fail-safe on leak by
   construction — a leaked hook makes the next export ABORT loudly and preserve its source — but
   it must still be enumerated for `lint:test-hooks` (`FAIL_SAFE_HOOKS` is for `test_force_*`
   names; adjudicate the entry). Recommended: approve with the FAIL_SAFE_HOOKS entry.

---

### Task 1 (Phase 0): Stall-budget rung — measure the census at production scale

**Files:**
- Create: `tests/census-lab/run-r1-stall-budget.mjs` (untracked until conclusions are banked, per lab discipline)
- Create: `tests/census-lab/NOTEBOOK.md` (append-only)

**Interfaces:**
- Consumes: running cluster, the 1,359-entity `test` platform, `tools/rcon.ps1` conventions (send RCON via `docker exec` clusterioctl).
- Produces: a banked `[empirical, 2.0.77]` number: wall-clock cost of one full-surface `SurfaceCounter.count_items` + `count_fluids` pass at 1,359 entities, and the derived per-entity cost. This number becomes the Phase-2 acceptance budget.

- [ ] **Step 1: Write the rung runner.** It must: (a) resolve the `test` platform surface; (b) time, from the Node side (`process.hrtime.bigint()` around the RCON round-trip), a `/sc` that runs `SurfaceCounter.count_items(surface)` once, then a `/sc` that runs it 10× in one execution; (c) same for `count_fluids`; (d) subtract the measured empty-command RCON round-trip baseline (time a bare `/sc rcon.print(1)` 5× and average); (e) print all raw readings tick-stamped. LuaProfiler is display-only (Pitfall #24, LuaProfiler serialization) — external wall-clock timing is the instrument, baseline-corrected.
- [ ] **Step 2: Run controls first.** The empty-command baseline and a 0-entity platform census (`force.create_space_platform` + starter pack) before the 1,359-entity reading. Bank all readings in NOTEBOOK.md.
- [ ] **Step 3: Bank the conclusion.** NOTEBOOK entry with: per-census wall-clock at 0 and 1,359 entities, derived per-entity cost, and the projected added cost per async batch (~100 entities) and for the atomic belt tick. State the acceptance budget for Phase 2 (proposed: added atomic-tick cost ≤ the existing belt-scan cost; added per-batch cost ≤ 10% of a batch's current budget — adjust to measured reality, and record what was chosen and why).
- [ ] **Step 4: Zero-leftover proof and release the cluster.** Delete the 0-entity fixture platform, assert zero lab surfaces/holds/jobs, game unpaused. Commit runner + NOTEBOOK together only when the conclusion is worth banking: `test(census-lab): bank census stall budget`.

### Task 2 (Phase 1): Per-entity census meter — refactor SurfaceCounter, new-file tests

**Files:**
- Modify: `docker/seed-data/external_plugins/surface_export/module/validators/surface-counter.lua`
- Test: `docker/seed-data/external_plugins/surface_export/test/census-meter.test.cjs` (new)

**Interfaces:**
- Consumes: existing `SurfaceCounter.count_items(surface)` / `count_fluids(surface, segment_temps, exclude_engine_owned)` internals.
- Produces: `SurfaceCounter.count_entity_items(entity)` → `{ [quality_key]: count }` and `SurfaceCounter.count_entity_fluids(entity, exclude_engine_owned)` → `{ [fluid_name]: amount }`; `count_items`/`count_fluids` rebuilt as folds over the per-entity functions plus the ground-item pass. Quality keys via the existing canonical helper (same function the gate uses).

- [ ] **Step 1: Write the failing static test.** `census-meter.test.cjs` (follow the source-contract style of `composite-transfer-verdict.test.cjs`): assert `surface-counter.lua` defines `count_entity_items` and `count_entity_fluids`; assert `count_items` references `count_entity_items` (the fold — one meter, not two); assert no `EntityHandlers` reference appears anywhere in `surface-counter.lua` (independence is structural and must stay that way).
- [ ] **Step 2: Run it, verify it fails** (functions don't exist yet): `node --test test/census-meter.test.cjs` → FAIL.
- [ ] **Step 3: Implement the refactor.** Extract the existing per-entity body of `count_items` (inventory-index loop, belt transport-line handling, held-stack handling, the pcall-with-logged-error pattern already there) into `count_entity_items(entity)`; same for fluids. `count_items(surface)` becomes: enumerate `find_entities_filtered({})`, fold `count_entity_items`, then the ground-item pass — behavior byte-identical to today (the gate consumes it; it must not change readings).
- [ ] **Step 4: Verify no behavior change.** Static test passes; run the full host test suite in the container (`docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npm test'`) — all green. Register the new test file in `package.json`'s `test` script.
- [ ] **Step 5: Commit.** `refactor(census): expose per-entity census meter` (surface-counter.lua + test + package.json).

### Task 3 (Phase 1): Census accumulator — new module, pure logic, unit-tested

**Files:**
- Create: `docker/seed-data/external_plugins/surface_export/module/export_scanners/census-accumulator.lua`
- Test: extend `docker/seed-data/external_plugins/surface_export/test/census-meter.test.cjs`

**Interfaces:**
- Consumes: `SurfaceCounter.count_entity_items/count_entity_fluids` (Task 2); per-entity serialized data tables (the same shape `Verification.count_all_items` reads).
- Produces:
  - `CensusAccumulator.new()` → accumulator table (plain storage-safe table — it lives in `storage.async_jobs[job_id].census` across ticks; no functions/userdata stored).
  - `CensusAccumulator.record(acc, entity, entity_data)` — takes the paired reads for one entity **in the caller's current execution**: physical via `SurfaceCounter.count_entity_items/fluids`, serialized via a per-entity count of `entity_data` (same counting rules as `Verification`), adds both to running totals, and appends an entity-attributed row to `acc.mismatches` when the two disagree (row: `unit_number`, `entity_id`, name, type, position, per-key expected/actual/delta — the belt-attribution row shape).
  - `CensusAccumulator.verdict(acc)` → `{ ok = boolean, mismatches = rows, totals = {...} }`; ok iff zero mismatch rows and aggregate item keys exact and fluid names within `1e-6`.

- [ ] **Step 1: Write failing static tests** asserting the module defines `new`/`record`/`verdict`; that `record` calls `SurfaceCounter.count_entity_items` (paired-read wiring is real, not a stub); that mismatch rows carry `unit_number` and per-key `expected`/`actual`/`delta`; that `verdict` compares fluids with the `1e-6` epsilon constant and items exactly.
- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** exactly the produced interface above. The serialized-side per-entity count must reuse `Verification`'s counting rules (require and call it — do not re-implement quality-key or belt-line-item counting).
- [ ] **Step 4: Run tests + full lint chain from the repo root context — all green.**
- [ ] **Step 5: Commit.** `feat(census): add paired-reads accumulator` (module + tests).

### Task 4 (Phase 2 — queued behind state-dimensions merge): wire paired reads into the export walk

**Files (re-resolve all anchors at execution HEAD):**
- Modify: `docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua` — in `process_export_batch`, immediately after each entity's serialization in the same loop iteration (same execution), call `CensusAccumulator.record`; in `complete_export_job`, inside the existing atomic belt-scan execution *after* belt items are patched into serialized data, run the paired belt reads; then compute `CensusAccumulator.verdict` before verification is finalized.
- Modify: `docker/seed-data/external_plugins/surface_export/module/core/export-pipeline.lua` — on a failed verdict for a transfer export: mark the job failed, write the mismatch bundle (black-box pattern: JSON to script-output, always-on), unlock the source, emit the failure through the existing transfer-failure event path so controller/UI report it; never contact the destination. Non-transfer exports: attach the verdict to the export result and log a loud warning on mismatch.
- Test: extend `census-meter.test.cjs` with source-contract assertions: `process_export_batch` calls `CensusAccumulator.record` in the same loop as handler serialization; the abort path references `verdict` before any destination send; the bundle write is not debug-gated.

- [ ] **Step 1: Write the failing source-contract tests** (as above), run, verify FAIL.
- [ ] **Step 2: Implement the wiring.** Belt entities are skipped by `record` during the async walk (their items aren't serialized yet — the `skip_belt_items` flag already marks this state) and paired in the atomic pass instead; assert in the test that `record` is guarded by the same flag.
- [ ] **Step 3: Add the one-shot hook** `test_force_census_omission` in `configure.lua`'s allowlist (registered key, else silently dropped — known allowlist behavior) + the omission injection at the post-serialization point; add the `FAIL_SAFE_HOOKS` entry with justification comment (leak ⇒ next export aborts + source preserved ⇒ self-protecting).
- [ ] **Step 4: Full lint + host tests green; commit** `feat(census): abort transfer exports on paired-read mismatch`.

### Task 5 (Phase 3 — owns the cluster): live evidence, both directions

**Files:**
- Create: `tests/integration/census-self-check/run-tests.ps1` (section-selectable: `-Sections success,omission`)
- Append: `tests/census-lab/NOTEBOOK.md`

- [ ] **Step 1: Success section.** Clone the 1,359-entity platform, run a full transfer; assert: census verdict ok, zero mismatch rows, transfer completes, exact gate passes, and the measured added stall is within the Task-1 budget (re-time the export's atomic tick via the Task-1 instrument). Physical grounding per `lint:test-grounding` (it will demand `get_item_count` — the census IS one; keep the runner's own independent count too, Rule 1).
- [ ] **Step 2: Omission section.** Arm `test_force_census_omission` on the source (disarm in `finally`), start a transfer; assert from the runner: export ABORTED (job failed before any destination message — check the destination received no import), mismatch bundle exists with the injected entity's `unit_number` in a row, source platform still exists and is unlocked, hook consumed. Assert the hook's own log line directly, never infer from the abort.
- [ ] **Step 3: Two consecutive full integration suites** (`node tools/run-integration-tests.mjs` twice) green, zero-leftover proof on both instances, reported once.
- [ ] **Step 4: Commit** `test(census): prove paired-reads self-check both directions` (runner + NOTEBOOK).

### Task 6 (Phase 4): /di-change, docs truth-sync, PR, stop for audit

- [ ] **Step 1: Run `/di-change`** with the impact map: physical source state → paired reads → accumulator verdict → transfer abort/proceed → (unchanged) gate → source delete. Attack list for the auditor: paired-read execution-boundary violations (a read pair split across executions), belt/pod family leaks into the async pairing, double-counting between per-entity census and ground-item pass, hook leak behavior, abort-path unlock correctness.
- [ ] **Step 2: Truth-sync [parity-verification-model.md](../../parity-verification-model.md):** the "Where each comparison runs today" table gains the production source-census row; the "no source-side physical census" sentence is updated — the doc must describe the new current state, facts-only.
- [ ] **Step 3: Open ONE PR** (`feat(census): paired-reads source census with fail-closed transfer abort`), body led by the tier-1 boundary statement from the parity doc, the Task-1 measured budget, and both live evidence directions. Stop for adversarial audit; after merge, watch main's post-merge run.

## Acceptance

- A serializer omission injected on the source aborts the transfer before the destination is
  contacted, names the exact entity in the mismatch bundle, and leaves the source intact and
  unlocked — proven live (Task 5 omission section).
- A clean 1,359-entity transfer passes the census with zero mismatch rows and stays within the
  Task-1 measured stall budget — proven live (Task 5 success section).
- The exact gate, its constants, and the source-delete path are byte-unchanged.
- `SurfaceCounter` remains handler-taxonomy-free (static assertion) and remains the single meter
  for both gate and census.
- Two consecutive full suites green with zero-leftover evidence; all lint guards green;
  `package-lock.json` byte-identical.

## Explicit Non-Goals

- Tier-2 state coverage (circuit configs, progress, schedules — the state-dimensions lane owns
  those via enumeration, not census).
- Any change to gate tolerances, Black-Box Discard, two-phase-commit wiring, or destination-hold
  visibility.
- A second census implementation, per-name engine totals beyond the existing meter, or any
  performance optimization not demanded by the Task-1 budget.
