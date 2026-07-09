# Lab-Coverage Audit & Hypothesis-Test Plan (2026-07-08)

> ⚠️ **SUPERSEDED (2026-07-08, same day):** this was the FIRST coverage pass. Its matrix is subsumed by
> `2026-07-08-empirical-test-backlog.md` (the ~68-item master list) + `2026-07-08-empirical-test-suite-design.md`
> (the LAB-A..K rung suite), and its "#76 di-change checklist result" section predates the 3a47a58 remediation +
> the subsequent /code-review — do NOT act from this file. Kept as the historical record of the audit method.

> Built by running the **`di-change`** checklist item #7 ("does the change rest on an untested engine belief?")
> against the transfer/fluid-gate spine, then extending it to a full inventory of every load-bearing
> engine-behavior belief tagged in `docs/factorio-2.0-api-notes.md` + `CLAUDE.md` pitfalls, cross-referenced
> against the actual lab rungs (`tests/*-lab/NOTEBOOK.md`). This is the systematic coverage check that should have
> run before the #76 fluid gate was calibrated.

## The filter (why "test all hypotheses" is not "run a rung per `[hypothesis]` tag)
The discipline (di-change #7 / CLAUDE.md "Empirical lab discipline") says: **lab a rung when a DESIGN DECISION
rests on engine behavior not tagged `[empirical, <pin>]`.** It does NOT say isolate every mechanism explanation.
Most `[hypothesis]` tags in this repo are *mechanism explanations* whose *behavioral rule* is already
`[empirical]` and load-bearing — testing the mechanism would change no decision. So the honest plan tests the
beliefs a **live decision** rests on, and explicitly defers the mechanism-only ones (with rationale) rather than
gold-plating. That is "every path has a proven goal" applied to the test plan itself.

## Coverage matrix — every load-bearing engine belief the transfer/fluid path depends on

| Belief | Evidence tag | Lab rung(s) | Live decision rests on it? | Status |
|---|---|---|---|---|
| Fluids preserve **volume** on transfer (static/settled) | `[empirical, 2.0.77]` | fluid-lab R0–R9, R10 | yes (fidelity claim) | ✅ COVERED |
| Fluid **temperature** round-trips exactly on transfer | `[empirical, 2.0.77]` | fluid-lab R10a/R10b | yes (#76 gate drift-immunity) | ✅ COVERED |
| Segment = one temp; mixing = **volume-weighted average** | behavior `[empirical]` (equal-vol); *weighting* `[hypothesis]` | R10b (equal-vol only) | **no** — #76 gate aggregates by name, ignores temp | 🟡 partial, not gating |
| **Fluids DRIFT during the multi-tick EXPORT scan** (⇒ a loss tolerance is needed) | **`[hypothesis]` — NEVER TESTED** (assumed by analogy to belt #16) | **NONE** | **YES — the #76 gate's `max(25,min(500,5%))` tolerance** | 🔴 **GAP → R11 REQUIRED** |
| Rejected writes (fusion output) subtracted before the gate | `[empirical]` (Pitfall #21) | fusion roundtrip test | yes | ✅ COVERED |
| Inject-fluid **after** activation (before loses ~15%) | *rule* `[empirical]`; ghost-buffer *mechanism* `[hypothesis]`/dead | fluid-lab R1–R9 (predictions) | decision rests on the RULE (empirical) | ✅ COVERED (mechanism dead, not needed) |
| Machines **craft in the activation→count gap** (⇒ validate items pre-activation) | *rule* `[empirical]`; *mechanism* `[hypothesis]` | none for mechanism | decision rests on the RULE (empirical) | ⚪ LOW — mechanism-only |
| Belt items **rolling-snapshot** during export (⇒ atomic single-tick belt scan) | *fix* `[empirical]`; *mechanism* `[hypothesis]` | none for mechanism | decision rests on the FIX (empirical) | ⚪ LOW — mechanism-only |
| High-temp (fusion) temperature drift (⇒ thermal-energy validation) | *drift* `[empirical]`; *weighted-merge explanation* `[hypothesis]` | none for explanation | validation rests on drift (empirical) | ⚪ LOW — mechanism-only |
| Held-item capacity = **dest force research** (replicate on import) | `[empirical, 2.0.76]` (Pitfall #29) | `force-bonus-sync` integration | yes | ✅ COVERED |
| Destination hold stays fully **non-live** over a long hold | `[empirical]` (PR-0A) **+ CI `delta=20` `[UNEXPLAINED]`** | hold-completeness-lab | yes (hold primitive fidelity) — **mitigated** | 🟠 MEDIUM — WATCH (self-diagnosing probe) |
| Synchronous held-item restore pass does **not tick** | `[empirical, 2.0.77]` (PR-0B) | no-tick-sync-lab | yes (strict gate timing, #28) | ✅ COVERED |

## Gaps, ranked by the filter

### 🔴 HIGH — a live decision rests on an untested belief → LAB REQUIRED
**R11 — fluid-export-scan drift (the fluid analog of Pitfall #16, never run).** The #76 fluid gate's loss
tolerance (`max(25, min(500, 5%·expected))`) exists to absorb an assumed export-scan drift — but fluids never
got the atomic single-tick scan belts got (Pitfall #16 fix); the export captures fluids *inline* per-tick with
segment dedup, and no rung ever measured whether a **flowing** fluid network drifts during that multi-tick scan.
R10 measured a **static** tank (exact). Until R11 runs, the gate calibration rests on `[hypothesis]`.
- **Fixture:** a flowing fluid network (offshore/boiler + pipes + pumps moving fluid across ≥2 segments) on a
  locked platform. Controls-first: a static tank must read identical single-tick vs export-serialized (R10 says
  yes) before trusting the flowing case.
- **Measure:** the export-serialized fluid total vs an independent **single-tick physical** segment/fluidbox sum,
  on the source, for the flowing network — repeated across several export ticks. Drift = the max per-name delta.
- **Decision it sets (contract-aligned — FAQ §D: ~100% preserved = zero TOTAL loss; the item gate is already
  *tight*, `max(20,1.5%)`, absorbing only the ±4–8 belt *residual*, never total loss):** the fluid gate should
  end up in the *same shape* — a **small, grounded tolerance + a complete-loss floor** — not the loose 500/5%.
  - **No drift (R11 shows exact)** ⇒ gate = float-epsilon + complete-loss floor; delete the 500/5% band.
  - **Small drift D** ⇒ gate = `max(≈3×D, small%)` + complete-loss floor — grounded exactly like the item gate's
    belt-residual floor (Pitfall #28), and D-measured, not a guessed 500.
  - **Large drift** ⇒ the belt precedent applies: **fix the measurement, not the number** — give fluids the
    **atomic single-tick scan belts already have** (Pitfall #16: defer fluid extraction during the async pass,
    one atomic pass over all segments in `complete_export_job`; fluids currently lack it — captured inline). That
    shrinks D to a residual, then a small grounded tolerance + complete-loss floor as above.
  The 500/5% band and the missing complete-loss floor are the defect; every branch ends at a *tight* gate.
- Same discipline as R10: real transfer/export path, both-instance cleanup, tick-stamped, `--reset` +
  zero-leftover, honest UNEXPLAINED.

### 🔴 HIGH — same defect class in the ITEM gate (not fluid-only)
The strict **item** gate (transfer-validation.lua:216-237) is `tol = max(20, 1.5%·expected)`, flagging loss only
when `diff > tol`. So it **tolerates real per-type loss** up to 20 (or 1.5%) and — like the fluid gate — **has no
complete-loss floor**: an item type with `expected ≤ 20` can vanish entirely and pass. The tolerance's
justification (Pitfall #28's "irreducible belt-restoration floor") **asserts** the band is measurement residual,
not loss, but that was **never isolated** — the same `[hypothesis]`. So the R11 question ("does the export TOTAL
drift, and is the band measured or guessed?") and the fix (**complete-loss floor + grounded band**) apply to the
item gate too. R11 should measure the **item** per-type export residual alongside fluids (cheap — same fixture,
add `get_item_count` deltas), so both gates end up grounded, not just fluids.

### 🟠 MEDIUM — WATCH (live decision, but mitigated)
**Destination-hold CI `delta=20` — `[UNEXPLAINED, 2.0.77]`.** Root cause never isolated; eliminated by fixture
determinism + direct-machine-meter hardening; the instrumented probe now self-diagnoses on recurrence (reports
tick, pause flags, direct vs segment meters). Candidates: fresh-force recipe-less write path, meter staleness.
**Action:** no new rung now — the probe isolates it *if it recurs*. If it recurs, that IS the rung.

### ⚪ LOW — mechanism-only `[hypothesis]`, no decision rests on the mechanism → NOT required
Craft-in-the-gap (#15), belt rolling-snapshot (#16), weighted-average merge (#23), ghost-buffer (#17). In each,
the **behavioral rule** is `[empirical]` and load-bearing; only the *why* is unproven, and no design decision
rests on the *why*. Isolating them is understanding-for-its-own-sake. **Defer** unless a future decision needs
the mechanism — log here so it's a conscious skip, not an oversight.

## #76 fluid gate — di-change checklist result (what passes, what's a gap)
1. **Independent measurement** — 🔴 GAP. `fluid-gate-detects-loss` uses the *synthetic* `test_force_fluid_loss`
   (inflates expected); `transfer-fidelity` physically counts **items** but **not fluids**. Need a fidelity test
   that physically sums fluid (fluidbox/segment) on source AND dest, independent of the validator's
   `actualFluidCounts`.
2. **Adversarial fixture with teeth** — 🔴 GAP for the found holes. Ship the complete-loss fix WITH a fixture: a
   real ≤25-unit fluid that vanishes (RED on current code, GREEN after the floor) and a ~490-on-10000 shortfall.
3. **Mutating hook fail-safe** — ✅ `test_force_fluid_loss` is non-destructive, pre-gate, in `FAIL_SAFE_HOOKS`.
4. **Commensurate + non-redundant** — ✅ expected (adjusted) vs actual, both post-activation; the gate is the
   loss detector, not redundant. (The masking blind spot is a known aggregate tradeoff, documented.)
5. **Two-phase-commit invariant** — 🟠 mostly ✅ (post-activation timing correct, source preserved on failure),
   but the **quarantine-escalation-invisible** edge (`delete_platform` false + quarantine throws → invisible live
   duplicate) needs the escalation surfaced to the verdict/metric.
6. **/code-review at authoring** — ✅ ran (workflow, high): found the loss-threshold blocker, the invisible
   quarantine, the redundant `reconcile_fluids`. (Belatedly, not at authoring — the process lesson.)
7. **Untested engine belief (lab gate)** — 🔴 the gate calibration rests on the fluid-export-drift `[hypothesis]`
   → **R11 required** (above).
8. **Owner hygiene** — no `Claude-Session:` trailer; index-not-name; `docs:`/`test:` labels kept clean.

## The plan (ordered)
1. **Run R11** (fluid-export-scan drift) — it is the one required new test; it sets the gate calibration.
2. **Remediate the #76 gate** on R11's result: add the **complete-loss floor** (ship regardless of R11), set the
   band per R11 (near-exact if no drift; measured-floor if drift), surface the quarantine escalation, drop the
   redundant reconcile — WITH the item-1 independent-physical-fluid fixture and the item-2 adversarial teeth.
3. **Watch** `delta=20`; **defer** the four mechanism-only hypotheses (logged above).
4. Re-run `di-change` on the remediated gate before merge.
