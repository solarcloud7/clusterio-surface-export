# Handoff brief — resume at PR #102 re-review (2026-07-13)

> Follow the [Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md). Standing rules unchanged:
> honest commit labels (docs: = docs only) · package-lock stays consistent (bump tooling now syncs it) ·
> no session URLs/trailers · stop for audit before merge · /di-change on any gate/validation/restore/
> source-delete change · two consecutive full suites + zero-leftover proof before merging spine changes ·
> evidence bars: prototype/static inference is a hypothesis until a live measurement confirms it.

## Where everything lives
- Task queue (5 tracked tasks): the session task list; mirrored below.
- Orchestration ledger: `.superpowers/sdd/progress.md` (append-only; full history of the last 2 days).
- Fix-loop report: `.superpowers/sdd/state-dims-report.md` (fix section at end, per-finding dispositions + teeth evidence).
- Original 11 findings (JSON, file:line + failure scenarios): `C:\Users\Solar\AppData\Local\Temp\claude\C--Users-Solar-source-FactorioSurfaceExport\1032b09e-d5a8-411f-a97f-9f450731bb5e\tasks\w3aftfy6e.output`
- Fix-delta review package (5 commits, full diff): `.superpowers/sdd/review-ae6f8b1..fe403c0.diff`
- Reference docs: `docs/parity-verification-model.md` (two-meter model, freeze policy, tier boundary), `docs/ENGINEERING_FAQ.md`.
- Census epic plan (5 decisions OWNER-ADJUDICATED — do not re-open): `docs/superpowers/plans/2026-07-12-paired-reads-source-census.md`.

## Current state
- Branch `feat/state-dimensions` at `fe403c0` (pushed; PR #102 open, NOT merged). Cluster UP and idle; fixer proved zero leftovers on both hosts.
- The 11-finding fix loop is COMPLETE (dispositions: 9 FIXED, 1 REFUTED-live with banked evidence (ghosts), 1 retraction (latch)). New `item-grid-roundtrip` test 13/13 with verified teeth (fixes reverted → 6 RED while the exact gate still PASSED — proving the gate-blind class; restored → 13/13).
- RE-REVIEW OF THE FIX DELTA IS PARTIALLY DONE. Verified so far against the diff: F1 (slotted path now calls full `restore_item_properties`, diff L176-177) and F11/F3-recipe (quality passed atomically at BOTH `set_recipe` sites, diff L80/L120). NOT yet verified — finish these before merge:
  1. F3 grid equipment: confirm `grid.put({...})` now includes the `quality` field (diff ~L201 region).
  2. F4: `bonus_progress` moved to the shared dispatcher — confirm no double-capture for assembling-machine (which previously captured it in its own handler).
  3. F6 retraction: the false "latch VALUE survived" claim corrected EVERYWHERE (test doc assertion, NOTEBOOK, PR #102 body, FAQ row states the measured truth: latch resets, src=1→dst=0, documented loss).
  4. F7: ghost-read refutation evidence banked with tick/pin, not just asserted.
  5. F8: energy captured unconditionally again + shield gated by measured `max_shield>0` discriminator — check the discriminator carries banked evidence and the 0-write path cannot re-introduce the tick-138282 crash class.
  6. Whole diff: no assertion weakened, no tolerance introduced, commit labels honest, no session trailers.

## Immediate sequence
1. Finish the six re-review checks above (read the diff package; read-only).
2. If clean: run TWO consecutive full `node tools/run-integration-tests.mjs` (owed per fix contract; known belt-anomaly retry rule applies — belt-only single-name small-count signature may retry once), zero-leftover proof both hosts.
3. Check PR #102 CI is green on the final head; then owner merges (squash); WATCH main's post-merge run to green.
4. Do not start dependent work until that run is green.

## Queue after #102 (tracked tasks)
- #2 Census epic Phase 2–4 — GATED on #102 merge + green main. Wire `CensusAccumulator.record` into the export walk per the plan's Task 4 (paired reads in the SAME Lua execution; belts only in the atomic tick; belt-timing constraint documented in census-accumulator.lua header). Then live forced-omission evidence (Task 5), /di-change + parity-doc truth-sync + one PR (Task 6). Truth-sync must restate tier-1 as TOP-LEVEL items+fluids (grid/nested contents are blind in BOTH meters — discovered this session).
- #3 Quality-dimension sweep (owner-approved concept): invariant = every serialized item-domain reference (filters, combinator signals, item-request proxies, ghost requests, logistic/module requests, held items) captures+restores quality; fluids exempt. Ownership-matrix static test + live spot-checks of inserter/splitter filters and constant-combinator signals.
- #4 Failure-signature triage table (owner-approved): ENGINEERING_FAQ section mapping known failure signatures → class → action (belt-only single-name small-count = stack-1/compression floor, retry once; fluids/fusion = exclusion issue; many-names GAINED = craft-window class); optionally make the black-box summary cite the matching row.
- #5 Small follow-ups: parity-doc quality-taxonomy line; asteroid-collector row in the freeze-policy table (collectors ARE frozen by the lock — measured); feed the suite-2 belt black box (`failure_black_box_groundfid-140327`) to the belt-loss rung as evidence recovery missed; make the PR #98 reachability probes a re-runnable lab for pin-bump recertification.

## Hard-won facts — do not re-derive, do not lose
- `get_recipe_quality()` and a writable `recipe_quality` attribute DO NOT EXIST at 2.0.77; recipe quality is `get_recipe()`'s SECOND return and must be passed atomically to `set_recipe(name, quality)`. (Banked this session; the old two-step restore was dead code.)
- Quality is a dimension of every item-domain object EXCEPT fluids (owner-stated; matches the gate: items compare quality-keyed, fluids by bare name).
- The exact gate proves serialized==restored, NOT source==destination; grid equipment and nested-inventory contents are counted by NEITHER meter (gate-blind class — the item-grid-roundtrip teeth run proved it empirically: 6 red physical assertions while the gate passed).
- Circuit latch VALUE does NOT survive transfer (measured: src=1→dst=0); the earlier claim was a false measurement from an unremoved seed (0.6 radius vs 0.707 tile-snap; sibling tests use 0.8).
- Belt restore floor for stack-size-1 items on compressed belts is LATENT, fail-closed (gate refuses; no silent loss); ties to BELT-R1's UNEXPLAINED mechanism; census Phase 3 is the designed attribution instrument.
- Census stall budget (measured 2.0.77): full-surface census 12.26ms @1359 entities (~74% frame); per-100-entity batch 1.54ms (~9%) — the incremental paired-reads design is the affordable one.
- Cost/model discipline: verify SERVED model from transcripts, never assume from the request (silent downgrade happens during entitlement windows); prefer per-tier dispatch (haiku=mechanical, sonnet=extraction, opus=implementation+review; owner rule: never Sonnet for merge-gating work).

## Throughput levers (owner asked; not yet adjudicated)
Second dedicated evidence cluster (deepest fix — atlas proves coexistence); tiered evidence bar for docs/test-only changes; batched owner decision points.
