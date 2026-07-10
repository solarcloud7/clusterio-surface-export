# LAB-B+ agent brief — the flagged-items rung package + the doc fixes each rung licenses

> You are the **implementer** on `codex/composite-transfer-verdict` (pull latest; HEAD ≥ `cbb9425`). The
> orchestrator audits; **stop for audit at the end**. This package closes every rung behind the welded-inference
> sweep's outstanding findings (`docs/superpowers/plans/2026-07-10-welded-inference-sweep.md` — read it first,
> findings 3/5/6/8/9/10) plus LAB-B (P0 in the backlog), THEN applies exactly the doc corrections each landed
> rung licenses. **Rungs before docs — never correct a claim whose rung hasn't landed. Measurement only: no
> gate, validator, or production-ordering changes (the #30 single-gate rewrite is a separate task).**

## Discipline (same as R11 — it passed audit cleanly, imitate it)
Controls first · every reading tick-stamped with both meters + paused flags · prediction stated up front per
rung · physical counts, never validator self-reports · two consecutive clean full passes reported ONCE ·
seven-field zero-leftover on BOTH instances (+ delete any disposable forces you create — merge them away via
`game.merge_forces`; assert force count restored) · append-only NOTEBOOKs · honest UNEXPLAINED · `--reset` ·
one `test(...)` commit per lab home, then ONE `docs(...)` commit (audit boundary: the docs commit carries ZERO
code). No session URLs/trailers. `./tools/rcon.ps1 11|21` (no rc11/rc21 aliases). NEVER touch `atlas-*`.
Any DI-lint firing = escalate, never self-approve an allow. Pitfall #19, platform.destroy is a no-op — the
lint:lua guard blocks it in module code; the B7 probe below runs via RCON `/sc` on a DISPOSABLE platform only.

## The rungs (section-selectable runners; home lab per lineage)

**B1–B3 — inserter held-item restore on a bonus-0 force** (home: `tests/inserter-lab`, backlog INS-2/3/4).
Create a DISPOSABLE force with `bulk_inserter_capacity_bonus = 0` (replicates the CI save). Legendary bulk
inserter holding a full 8-stack → run the transfer path → physically count the held stack on the destination.
Measures: does the Phase-0 force sync raise the bonus for a non-platform force; does
`restore_held_items_only`'s partial-hand top-up seat FULLY; is any residual gate-timing or real. Controls: the
same fixture on the normal (researched) force first.

**B4 — INS-6: lower the bonus over seated hands** (home: `tests/inserter-lab`; resolves sweep finding 5,
Pitfall #29's self-contradiction). Seat over-capacity hands (bonus 11, hand of 8), then LOWER the bonus to 0,
then `reset_technology_effects()`, reading the physical hand after each step ±60 ticks. Prediction is
DELIBERATELY OPEN — the pitfall asserts both "lowering ejects held items" and "seated hands survive a bonus
drop"; whichever half the measurement kills, the OTHER half's text is what you correct in the docs pass.

**B5 — API-2: can crafting advance without an elapsed tick?** (home: `tests/no-tick-sync-lab`; re-scopes
sweep finding 3, Pitfall #15). Furnace mid-craft (record `crafting_progress` + input/output counts) →
deactivate → in ONE `/sc` execution: reactivate, immediately re-read progress + counts → then +1 tick, +60
ticks reads. Prediction: no change within the execution; progress resumes only after elapsed ticks. This
converts #15's rule from "never count after activation" to "never count across an elapsed tick."

**B6 — FLUID-3 + GATE-6: unequal-volume temp merge + key-precision boundary** (home: `tests/fluid-lab`, R12).
(a) Tank A `500 water@165°C`, tank B `1500 water@500°C`, isolated; connect with a pipe; read the merged
segment. Prediction if volume-weighted: `2000 @ 416.25°C` — first direct test of the weighted-merge
[hypothesis]. (b) Key precision sweep: set fluid temperatures at 9,999 / 10,001 / 1e5 / 1e6 / 1e7, read back
`name@%.1fC` keys twice ±60 ticks — find where keys actually become unstable/collide. This unwelds the
`game-utils.lua:102-105` comment (a >1,000,000°C story justifying a 10,000 threshold).

**B7 — API-7: `platform.destroy()` on the REAL pin** (home: new `tests/engine-repin-lab`, LAB-I). On a bare
DISPOSABLE platform (`force.create_space_platform` + `apply_starter_pack`): `destroy()`, `destroy(0)`,
`destroy(60)` — read `platform.valid` + platform count at +1/+61/+120 ticks. Pitfall #19 measured a silent
no-op at 2.0.76; current docs describe scheduled deletion. Either outcome is fine — `GameUtils.delete_platform`
stays the only sanctioned route regardless — but the tag must say what 2.0.77 actually does.

**B8 — API-1: beacon `crafting_speed` instant-update re-pin** (home: `tests/engine-repin-lab`). Beacon + speed
modules beside an assembler: populate `beacon_modules` via script, read the machine's `crafting_speed` in the
SAME execution, then next tick; repeat with the beacon unpowered. Prediction (per Import Phase Ordering):
immediate update, no power required. This re-pins the beacon-before-crafter ordering's load-bearing premise.

**B9 — API-8: unknown-item graceful skip** (home: `tests/engine-repin-lab`, cheap). Import an entity payload
referencing a nonexistent item name (`test_import_entity`) — assert: no crash, warning logged, everything else
restored. First actual test of Pitfall #7's stated behavior.

## The docs pass (ONE `docs(...)` commit, only after its licensing rung is green)
- **#22 scope** (licensed NOW by R7): machines never expose fluid segment IDs on 2.0.77 — not just "isolated"
  ones. Rewrite the scope sentence.
- **#17 body** (licensed NOW by R11): demote the ghost-buffer "Root Cause" narration to a historical-hypothesis
  note; lead with: the old ~15% was real, its class never isolated, and R11 measured the shipped restoration
  conserving exactly in a frozen world on 2.0.77 (cite `[empirical, 2.0.77, fluid-lab R11]`).
- **"Belt item drift (±4–8) is cosmetic redistribution"** (licensed by belt-lab + dfdd59d + LAB-A): it was
  real restore-time loss, since fixed to zero — rewrite the Known-Limitations bullet.
- **#29 rationale** (licensed by YOUR B4): correct whichever half B4 killed; keep raise-only as the design
  (it is conservative-safe either way) with the measured reason.
- **#15 evidence line** (licensed by YOUR B5): state the ordering's reason as the measured tick-boundary rule.
- **#23 / `game-utils.lua:102-105`** (licensed by YOUR B6): comment-only fix stating the measured precision
  boundary. (Comment text only — the threshold VALUE is #30's territory; do not change it.)
- **#19 pin strings** (licensed by YOUR B7): update tags to what 2.0.77 measures; if behavior changed, ADD the
  drift note, don't delete the history.
- Promote every durable result to `docs/factorio-2.0-api-notes.md` tagged `[empirical, 2.0.77, <lab>]`; update
  the backlog rows (INS-2/3/4/6, API-1/2/7/8, FLUID-3, GATE-6); mirror CLAUDE.md edits into the gitignored
  AGENTS.md locally. Citation style everywhere: number + short name (a doc-refs lint is landing on main — write
  as if it's already watching you).

## Stop conditions (report, don't improvise)
B1–B3 shows a REAL held-item shortfall the force sync doesn't cover · B5 shows crafting CAN advance without an
elapsed tick (this would strike at the frozen-census foundation — stop immediately) · B6a refutes
volume-weighting in a way that implies fluid volume non-conservation · any result seems to require a
gate/validator/production change · cluster failures · any DI-lint fires.

## Report format
Per-rung: prediction → measured result → verdict (confirmed / refuted / unexplained), with key tick-stamped
evidence lines. Then: which doc fixes were licensed and applied, which were NOT (and why). Two-pass proof +
both-instance zero-leftover + force-count restoration. Diff summary proving scope held (no validator/gate/
production-ordering changes; package-lock untouched).
