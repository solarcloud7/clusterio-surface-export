# Empirical Test Backlog — every unproven claim, as a test to run

> **Purpose:** enumerate every claim in the transfer/fidelity system that is NOT empirically proven on the current
> pin (2.0.77), so each becomes a *measurement*. Built from three exhaustive parallel sweeps (api-notes ·
> CLAUDE.md/AGENTS.md pitfalls · code magic-numbers + all five lab notebooks), deduplicated and adjudicated.
> **We are testing these, not deleting them.** End-state = 0 unproven claims because each got measured.
>
> Status legend: `H`=`[hypothesis]` mechanism · `U`=`[unexplained]` anomaly · `G`=guessed number · `C`=circular
> citation · `X`=untagged engine assertion · `P`=`[empirical]` with no pin (reproducibility unverified) ·
> `W`=wiki/docs-only (never cluster-tested).
>
> ~68 deduplicated test items across 9 domains. Source keys: A#=code constant, B#=lab open item, plus pitfall #.

> **TRIAGE 2026-07-11:** entries annotated GROUNDED / SUPERSEDED / QUEUED against landed lab evidence; untagged
> entries remain open. GROUNDED = measured by one of the six labs certified at pin 2.0.77 in
> `tests/labs-certified.json` (gate-drift/LAB-A, fluid-lab R1/R7/R8/R9/R10/R11/R12, inserter-lab B1-B4,
> no-tick-sync B5/PR0B, engine-repin B7-B9, hold-completeness PR0A). Doc-/`[API]`-verified-only or un-run rungs
> (LAB-C/D/F/H/J/K, and LAB-I I1/I2) stay open. SUPERSEDED = the source-delete gate thresholds deleted by the
> single frozen-world exact gate (PR #76, `c5d7437`). QUEUED = covered by the LAB-TAIL brief
> (`2026-07-10-lab-tail-agent-brief.md`: T1 thermal V×T, T2 timeout wall-clock, T3 max RCON payload, T4
> stored-export latency).

## Progress
- **2026-07-10 — R11 PASSED (commit `e8c7bbe`, audited):** frozen-world fluid injection conserves EXACTLY on
  2.0.77 — segment write-while-off (R11a), full inactive mini-line (R11b), newly-created pre-first-activation
  entities with no toggle fallback needed (R11c), and the shipped `FluidRestoration.restore()` invoked frozen on
  the 1,359-entity clone via a one-shot name-scoped seam (R11d: max per-name |delta| = 0 at both the frozen and
  same-tick post-activation censuses, all 8 names; fusion 100 raw / 20 engine-rejected / 80 restored exactly).
  Two acceptance passes, seven-field zero-leftover both instances. The historical ~15% pre-activation loss did
  NOT reproduce in any class. **Decision contract fires: the #30 rewrite is the SINGLE frozen-world exact gate**
  (items+fluids, one verdict before activation; post-activation fluid gate + discard/quarantine path retired).
  Closes FLUID-1/2; GATE-2/3/4 resolved by owner contract + this measurement. Companion audit:
  `2026-07-10-welded-inference-sweep.md` (10 welded inferences catalogued; stale texts queued into the #30 PR).
- **2026-07-10 — OWNER CONTRACT UPDATE + new rung R11 (fluid-lab) queued ahead of the #30 gate hardening:** the
  fluid gate gets NO band and NO complete-loss floor — regular fluids are exact, black-or-white, same contract as
  items (high-temp already solved via aggregate-by-name + write-rejection subtraction). The 2026-07-09
  gate-hardening brief is ON HOLD. Root discovery: Pitfall #17's "gate must count a live world" is a WELDED
  INFERENCE, not a measured fact — fluid-lab R2 already shows write-while-inactive works (machine buffer), and
  `import-completion.lua`'s completion is one synchronous execution anyway (zero-tick window even today). **R11**
  (`2026-07-10-fluid-r11-frozen-injection-rung-spec.md`) tests frozen-world injection at segment/line/real-path
  scale; if it passes, the verdict collapses to a SINGLE frozen-world exact gate and the post-activation fluid
  gate + discard/quarantine path is retired. Touches GATE-2/3/4 (fluid band items — now resolved by contract, not
  calibration) and the FLUID-* mechanism rows.
- **2026-07-09 — GATE-5 CLOSED (LAB-A, commit `d666b23`, audited):** export-scan residual measured **0** for both
  fluids and items across two full passes (spans 144–240 ticks). Stronger than absence: **freeze0 proved the
  mechanism** — the production export lock disables fluid movers (pump `disabled_by_script`; per-segment contents
  static; segment IDs stable) while belts keep moving and the atomic scan preserves exact totals. Export-side
  justification for the gate tolerance bands is dead. Also advanced: **BELT-2** (belts keep moving under a
  production lock — now `[empirical, 2.0.77]`) and **BELT-1** (the atomic-scan fix re-validated under moving
  belts; the historical mechanism story remains historical). Scope: source-export path only — restore-side
  exactness rests on the end-to-end fidelity suite. GATE-1/2/3/4 now have their calibration input → the #76/gate
  hardening task.

## Priority summary (where to start)
- **P0 — the source-delete gate is calibrated on guesses that the labs already contradict.** `STRICT_ABS=20` /
  `STRICT_PCT=1.5%` authorize irreversible source deletion, are asserted ("~3× the irreducible belt floor"), and
  the belt+inserter labs measured real per-item losses of **22–47 on busy platforms that exceed them**. Every
  fidelity gate (item + fluid) needs its tolerance grounded against a measured export/restore residual, plus a
  complete-loss floor. This is the data-integrity spine → **GATE-\*, BELT-3, INS-2/3/4.**
- **P1** — fluid gate band + the export-drift residual (does the *total* drift, or is the tolerance unneeded?).
- **P2** — open lab anomalies (delta-20, belt real-vs-phantom, inserter held-loss root) + TTL estimates.
- **P3** — engine *mechanism* `[hypothesis]` (ghost-buffer, weighted-merge, craft-in-gap, rolling-snapshot):
  behavioral rules are `[empirical]` and load-bearing; only the *why* is unproven → lower priority, but they are
  the ones cited circularly, so grounding them stops the citation loop.
- **P4** — `[empirical]`-no-pin re-verification on 2.0.77 + API-drift inferences.
- **P5** — future passenger/connect-to-server feature (gated on the feature).
- **P6** — cosmetic display epsilons + a doc bug.

---

## 1. Validation gates & tolerances — the source-delete spine (P0/P1)
| ID | Claim / number | Status | What a test MEASURES | Depends on / blast radius |
|---|---|---|---|---|
| GATE-1 | `STRICT_ABS=20` item-loss floor (A7) | G/C | per-item restoration residual distribution across platform densities; is there an irreducible floor and is it ≤~6–7 (so 20≈3×)? | authorizes **source deletion**; busy platforms already exceed it |
| GATE-2 | `STRICT_PCT=1.5%` item-loss fraction (A8) | G/C | per-item loss as a fraction of expected on high-count items; CI busy shows 22–47 losses exceeding `max(20,1.5%)` | same gate; the fraction does NOT bound real loss today |
| GATE-3 | "3× the irreducible belt-restoration floor" justification (#28 / ±4–8 invariant) | C | is the "±4–8 belt floor" real and constant? belt-lab shows −8 settled → ~−33/item busy — NOT constant | GATE-1/2's entire rationale |
| GATE-4 | Fluid loss band `max(25,min(500,5%))` + `FLUID_LOSS_TOLERANCE=500` + `FLUID_GAIN_TOLERANCE=500` (A1/A2/A3) | G | clean-transfer fluid-delta distribution → floor/fraction separating noise from real loss; **and a complete-loss floor** (≤25 fluid vanishes today) | fluid source-delete gate (#76); silent-loss holes |
| GATE-5 | **Export residual: does the item/fluid TOTAL drift during the multi-tick export scan?** (the R11 question) | X | flowing item+fluid network on a locked platform: serialized-export total vs single-tick physical count, repeated over ticks → the true residual that every tolerance should equal | grounds GATE-1..4; decides "tighten band vs atomic-scan fix vs delete band" |
| GATE-6 | `HIGH_TEMP_THRESHOLD=10000` splits per-key vs by-name fluid reconcile (A13) | R12 negative: threshold still unlicensed | steam requests 9,999→10,000,000°C all clamped to 5,000°C with stable keys; no precision boundary found | task #30 must justify policy from the actual fluid path |
| GATE-7 | `LOSS_TOLERANCE_PCT=0.05` / `LOSS_TOLERANCE_ABS=25` high-temp reconcile (A11/A12) | G | volume drift from temperature-bucket merging at extreme temps, as a fraction | high-temp fluid report (non-gating today) |
| GATE-8 | loose-path `STORAGE_TOLERANCE=5`, `TOTAL_LOSS_TOLERANCE=0.95`, `MIN_ABSOLUTE_LOSS=100`, unexpected `>20` (A4/A5/A6/A9) | G | spurious gain / real loss on **non-transfer** (upload) imports — acknowledged over-tolerant instrument | uploaded-JSON import verdict |

> **TRIAGE 2026-07-11:**
> - **GATE-1 / GATE-2 / GATE-3 / GATE-4 — SUPERSEDED:** thresholds deleted by the single frozen-world exact gate
>   (PR #76, `c5d7437`) — transfers are exact (items `0/0`, fluids by-name at `epsilon=1e-6`); the loose path remains
>   for non-transfer callers only. (GATE-3's "±4–8 belt floor" premise was itself refuted: that residual was *real*
>   restore-time loss, not a cosmetic floor — see CLAUDE.md belt invariant.)
> - **GATE-5 — GROUNDED:** [empirical, 2.0.77, gate-drift LAB-A] export-scan residual measured **0** for items and
>   fluids across two full passes; the production export lock freezes the fluid movers (freeze0) so drift is
>   impossible by mechanism (commit `d666b23`; `tests/gate-drift-lab/NOTEBOOK.md`).
> - **GATE-6 — GROUNDED (partial):** [empirical, 2.0.77, fluid-lab R12] steam clamped every write to 5,000°C with a
>   stable key across the 9,999→10,000,000°C sweep — no precision boundary found. The `10000` threshold *value*
>   itself remains unlicensed (open, task #30); the E3 sweep for its real placement did not run.
> - **GATE-7 — QUEUED: LAB-TAIL T1** (high-temp reconcile tolerance rides the thermal V×T conservation rung; it is
>   the non-gating display path — NOT deleted, unlike GATE-4).
> - **GATE-8 — open:** the explicitly-retained non-transfer (upload/clone) loose path; no landed lab.

## 2. Belt / item fidelity (P0/P1)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| BELT-1 | "rolling snapshot" — items move between belts during multi-tick export → double-count/miss (#16) | H | multi-tick vs single-tick belt scan on the same frozen platform: do serialized totals diverge, and does divergence track throughput? | the atomic-scan design; GATE-3/5 |
| BELT-2 | belt items can't be deactivated; redistribution is "cosmetic, not loss" (#16 / invariant) | X | freeze all entities on a locked platform → do belt lines still advance? is total conserved (redistribution) vs lost? | "±4–8 not loss" reassurance; GATE-3 |
| BELT-3 | **the −8 settled / −135–143 busy residual: real loss or export double-count phantom?** (B1/B5) | U | source-physical vs serialized-export vs dest-physical per-item reconciliation — the decisive A/B | whether busy transfers can ever pass; export-vs-restore fix side |
| BELT-4 | drop mechanisms "MISSING NEIGHBOR" (dest belt built 1-input vs source 2) + "BOUNDARY HANDOFF" (B2) | X | verify all belt feeder entities CONNECT (not just created) on dest; recover boundary item to downstream input | belt fidelity; entity-connection correctness |
| BELT-5 | overflow routing is duplication-prone under load (removed) (B3) | (settled −) | a whole-segment DEDUPED deficit meter (not per-line deltas → 267 false positives) for any future topup | any literal-zero attempt |
| BELT-6 | oversized-stack consolidation fix (B6) | X | busy real transfer with consolidation: gate GAINs=0 (no double-place) AND post-activation loss conserved; CONSOLIDATE-REJECT busy path | literal-zero without routing |
| BELT-7 | belt_restoration spacing `(gi-1)*0.25`, end-clamp `len-0.05`, classifier `<0.25` (A24/A25/A26) | G/P | min inter-item separation & max edge position `insert_at` accepts on the pin | consolidated placement correctness |

> **TRIAGE 2026-07-11:**
> - **BELT-1 — GROUNDED:** [empirical, 2.0.77, gate-drift LAB-A] the atomic single-tick scan was re-validated under
>   moving belts (residual 0); the "rolling snapshot" *mechanism* remains a historical hypothesis (Pitfall #16).
> - **BELT-2 — GROUNDED, with a correction:** [empirical, 2.0.77, gate-drift LAB-A] belt lines keep advancing under a
>   production lock — measured. But the "redistribution is cosmetic, not loss" reassurance was **REFUTED**: the ±4–8
>   was *real* restore-time loss (CLAUDE.md belt invariant), since fixed to exact physical totals.
> - **BELT-3 — GROUNDED (partial):** LAB-A measured export-scan residual **0**, so the residual is NOT an export
>   double-count phantom on the export side; the restore-side belt floor was separately fixed to zero (CLAUDE.md belt
>   invariant). The dedicated source-vs-serialized-vs-dest reconciliation (LAB-C C1) did not certify.
> - **BELT-4 / BELT-5 / BELT-6 / BELT-7 — open:** LAB-C did not certify (not in `tests/labs-certified.json`).

> - **BELT-R1 — FIXED-PROVEN (2026-07-11):** the permanent trap naturally captured a new belt-only
>   `processing-unit -1` deficit. The banked input reproduced `5/5`; an order-preserving prefix minimized the
>   boundary to 550 belts, and a fixture with cargo only on the implicated 40-entity component still reproduced
>   `19 -> 18`. Export scanning is exonerated; the workload-dependent restore mechanism remains UNEXPLAINED.
>   Restoration now recovers only the complete all-belt per-name deficit to the hub, then to platform ground if
>   the hub is full; unrecovered amounts remain gate-red. The full-hub fixture passed five real transfers under
>   the unchanged exact gate, preserving `19 -> 19` each time.
>
## 3. Inserter / held-item fidelity (P0)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| INS-1 | `set_stack` silently fails on a **settled-deactivated** inserter (#28 root cause) | X | `set_stack` on settled+deactivated vs briefly-toggled-active inserter: does the item seat? isolate "settled" vs "deactivated" | the `restore_held_items_only` "fix the clock" design |
| INS-2 | bonus-0 destination force previously under-restored held items | C — B1/B3 [empirical, 2.0.77] | player control and adversarial force both restored physical held 8 exactly | busy-platform strict gate; GATE-1/2 |
| INS-3 | synchronous held-item top-up seats fully after force sync | C — B3 [empirical, 2.0.77] | adversarial destination physically held 8 with no residual after Phase-0 raised the force | the pre-gate held-restore premise |
| INS-4 | held loss was destination-force state, not payload drift | C — B2 [empirical, 2.0.77] | destination entity force began bonus 0, rose to source 11, and restored the same payload exactly | pre-gate force sync |
| INS-5 | no-tick-sync validated only an **empty/settled** hand, not a partial-filled bulk inserter (B24) | X | run the no-tick sync assertion against a partially-filled bulk inserter in CI-fresh state | ties INS-2/3; the "restore-held-before-gate, no tick" premise |
| INS-6 | force-sync remains RAISE-ONLY; seated-hand ejection claim tested | C — B4 [empirical, 2.0.77] | hand stayed 8 across bonus 11→0, elapsed ticks, and `reset_technology_effects()`; no ejection | raise-only remains conservative state ownership |

> **TRIAGE 2026-07-11:**
> - **INS-1 — GROUNDED:** [empirical, 2.0.77, inserter-lab B1-B4] `set_stack` silently truncates/fails to seat on a
>   settled-deactivated hand (and the ok-bool lies); a briefly-active bulk hand seats full (`tests/inserter-lab/NOTEBOOK.md`).
> - **INS-2 / INS-3 / INS-4 / INS-6 — already carry current-pin `[empirical, 2.0.77]` tags** (inserter-lab B1-B4,
>   commit `8c61365`); synced, no change.
> - **INS-5 — open:** the no-tick-sync assertion against a *partial-filled* bulk hand in CI-fresh state was not
>   certified as a standalone conclusion (that thread resolved into the dest-force-research fix, Pitfall #29).

## 4. Fluid fidelity & mechanisms (P1/P2/P3)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| FLUID-1 | ghost-buffer / fluid-detach mechanism (frozen ⇒ detached; write ⇒ ghost buffer; merge wipes it) (#17 / api-7 / B9) | H + uninspectable | needs a modded/injected specimen that is BOTH segment-member AND deactivatable: write-inactive → read → reactivate → read (survives=refute / wiped=confirm). 4 sub-claims 3a–3d | inject-after-activation *rationale* (behavior stands independently) |
| FLUID-2 | R7 unanswered — no activatable entity on 2.0.77 exposes a non-nil own-fluidbox segment id (B11 / api-4) | X | find an activatable entity whose fluidbox reports non-nil segment id, then test detach/merge | FLUID-1; the "merge favors larger segment" sub-claim |
| FLUID-3 | temperature merge = **volume-weighted average**, unequal-volume (#23 / api-6) | C — R12/B6a [empirical, 2.0.77] | `500 steam@165 + 1500 steam@500` merged to exact `2000@416.25`; water control clamped to 100 | aggregate-by-name gate; thermal-energy validation |
| FLUID-4 | `entity.fluidbox[i]` is a proxy window onto the segment, not a container (api-1) | X | write to one entity's fluidbox → read segment contents from a *different* entity on the same segment | segment read/dedup strategy |
| FLUID-5 | fluidbox proxy reads stale (0/nil) for ≥1 tick after a state change (api-2) | P | sample `fluidbox[i]` every tick vs `get_fluid_segment_contents` after activate; count stale ticks | validate-via-segment rule; import timing |
| FLUID-6 | summing per-entity fluidbox multiplies by segment size → dedup by segment id (api-3) | X | build K-entity segment, sum per-entity contents, confirm =K× true; dedup recovers 1× | network-wide fluid meter over-count |
| FLUID-7 | `get_fluid_segment_id` nil for fluid wagon / turret buffer / isolated machine (api-4) | X (partial) | call it on each named case on the pin; record which are nil | nil-fallback; dedup |
| FLUID-8 | `get_capacity` = segment for pipes/tanks, local for machines "because base_area vs fixed fluid_box" (api-8) | X (causal) | measured half: capacity on pipe vs machine; causal half: prototype `base_area` presence correlated with observed capacity | "inject into highest-capacity entity" rule |
| FLUID-9 | fusion **output** rejects writes / input accepts; "engine generates plasma" (api-9 / #21) | P + X | write plasma to output (expect 0) and input (expect accepted) on the pin; is rejection systematic across engine-driven outputs? | `write_rejected` subtraction accounting |
| FLUID-10 | fluid_restoration epsilons: fallback temp `=15`, shortfall `-0.5`, retry `>0.5`/`<amt-0.5`, overflow `>cap+0.01` (A27–A30) | G | fluidbox write rounding-error magnitude → correct epsilon | retry/overflow accounting |
| FLUID-11 | verification self-consistency epsilon `>0.1` (A31) | G | serialization rounding error of fluid totals | internal-consistency flag |
| FLUID-12 | destination-hold CI `delta=20` root cause never isolated (api-22 / #17 / B8) | U | instrumented probe under each candidate isolated: fresh-force recipe-less write path (with settle delay) vs meter-staleness (re-read timing) → attribute the 20 | destination-hold fluid-fidelity claim; masked-residual risk |
| FLUID-13 | R10c/R10d never run; R9b (CI self-report) pending (B12/B13) | X | the unrun adversarial temperature-mix rungs; a CI run with the instrumented probe green | #76 gate "proven necessary" claim; "fluid fix done vs locally-green" |
| FLUID-14 | R1 `frozen=true` half inconclusive (`.frozen` read-only, uninducible in lab) (B10) | X | an alternate way to induce engine-frozen state, or confirm production never sets `.frozen` (R8 found none) | frozen-vs-active=false fluid behavior |

> **TRIAGE 2026-07-11:**
> - **FLUID-1 — GROUNDED (mechanism refuted / unconstructible):** [empirical, 2.0.77, fluid-lab R7/R11] no
>   segment-member *and* deactivatable specimen exists on 2.0.77 (R7); frozen-world injection conserved exactly
>   (R11d, max |delta| = 0), so the ghost-buffer loss prediction did not reproduce. Behavioral rule stands
>   independently (Pitfall #17); LAB-F remains BLOCKED (specimen unconstructible).
> - **FLUID-2 — GROUNDED:** [empirical, 2.0.77, fluid-lab R7] no activatable entity's own fluidbox exposes a non-nil
>   segment id (Pitfall #22) — the "R7 unanswered" title is stale; R7 answered it.
> - **FLUID-3 — already `[empirical, 2.0.77]`** (fluid-lab R12/B6a); synced.
> - **FLUID-9 — GROUNDED (partial):** [empirical, 2.0.77, fluid-lab R11] fusion **output** rejects writes / input
>   accepts, measured 100 raw / 20 rejected / 80 restored; "systematic across all engine-driven outputs" stays open.
> - **FLUID-13 — QUEUED: LAB-TAIL T1** (R10c thermal-energy half); R10d was adjudicated redundant by the exact fluid
>   gate (`c5d7437`); the R9b CI self-report remainder is open.
> - **FLUID-14 — GROUNDED:** [empirical, 2.0.77, fluid-lab R1/R8] `LuaEntity.frozen` is read-only and a module-tree
>   grep found no production `.frozen =` write sites (R8).
> - **FLUID-4 / 5 / 6 / 7 / 8 / 10 / 11 / 12 — open:** LAB-D did not certify; FLUID-4/7 are doc/`[API]`-verified only
>   (not lab-measured on the pin); FLUID-12's `delta=20` was eliminated-by-fixture but its root cause was never
>   isolated (UNEXPLAINED).

## 5. Destination-hold & cargo pods (P2, Phase-2 gated)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| HOLD-1 | `descending`/`parking` pods route through recover-and-spill — NOT constructed as a live specimen (api-21 / B18-adjacent) | X | build live `descending` + `parking` pods, run `DestinationHold.stage()`, confirm pod_count=0 + cargo retained | "pod-free after stage" guarantee for non-`awaiting_launch` |
| HOLD-2 | held platform "not-live" = drift ≤ live control (spoilage/asteroids advance) — accept-by-redefinition (B17) | X | held drift ≤ live drift, platform_damage=0, nothing-leaves — later runs assert; confirm the redefinition holds broadly | no-duplicates "not-live" contract |
| HOLD-3 | held platform's asteroid is NOT contained (`held_asteroid_contained=false`) but terminal matches live (B19) | X | does asteroid ever leave the platform or damage it (both currently 0)? | user expectation of "not-live" |

> **TRIAGE 2026-07-11:**
> - **HOLD-1 — GROUNDED (partial):** [empirical, 2.0.77, hold-lab PR0A] an `awaiting_launch` pod staged to
>   `pod_count=0` with cargo retained; the `descending`/`parking` states were not constructed as live specimens (open).
> - **HOLD-2 / HOLD-3 — GROUNDED:** [empirical, 2.0.77, hold-lab PR0A] held drift ≤ live-control drift, platform
>   damage 0, nothing leaves; the "not-live" redefinition held (commit `a007ecb`).

## 6. Transfer TTL & timing estimates (P2)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| TTL-1 | `WORST_CASE_RCON=3000` / `SCAN_IMPORT=6000` / `MARGIN=3000` / `DEFAULT_TTL=36000` (A17/A19/A20/A21/A23) | G/semi | real end-to-end transfer wall-clock distribution for the largest platform → TTL must exceed p99 | source auto-unlock timing; committed-tombstone retention |
| TTL-2 | `VALIDATION_TIMEOUT_TICKS=7200` == JS `VALIDATION_TIMEOUT_MS` (A18, grounded) | (drift check) | confirm the Lua constant still equals the JS constant | timeout consistency |

> **TRIAGE 2026-07-11:**
> - **TTL-1 — QUEUED: LAB-TAIL T2** (validation-timeout wall-clock distribution; its RCON/scan components also touch
>   T3 max-RCON-payload and T4 stored-export latency).
> - **TTL-2 — QUEUED: LAB-TAIL T2** (the JS↔Lua timeout-constant drift check is part of the T2 measurement scope).

## 7. Engine / API claims — re-verify on the 2.0.77 pin (P3/P4)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| API-1 | `crafting_speed` updates instantly on beacon module population, no power required | C — B8 [empirical, 2.0.77] | same-execution `1.25→3.125` powered and unpowered; stable after elapsed tick | beacon-before-crafter two-pass ordering |
| API-2 | crafting does not advance without an elapsed tick; resumes after ticks | C — B5 [empirical, 2.0.77] | same-execution progress/input/output exact; later reads advanced | "count before elapsed tick" ordering |
| API-3 | entity props read-only in 2.0 (quality, productivity_bonus aggregation) (api-14 / #6) | P/X | attempt post-create writes on the pin; confirm read-only; confirm bonus aggregation composition | set-at-create + pcall rule |
| API-4 | LuaProfiler non-serializable; `{"", profiler}` bakes value on save/reload; display-only (api-12) | P | store `{"", profiler}`, save/reload, confirm baked+correct; confirm raw-profiler storage crashes | persisted timing/telemetry |
| API-5 | LocalisedString capped at 20 params → crash `N > 20` (api-13 / #25) | P | print a 21-param LocalisedString, confirm crash on the pin | split-print rule in import completion |
| API-6 | `set_inventory_size_override` arg-order changed post-2.0.76 (api-10) | X (inference) | call on the current engine, determine which positional order takes effect | future use on upgraded engine |
| API-7 | `platform.destroy(ticks)` schedules deletion on 2.0.77; no-arg remains no-op | C — B7 [empirical, 2.0.77] | `destroy(0)` and `destroy(60)` deleted after ticks; `destroy()` remained valid | keep deterministic `game.delete_surface` route |
| API-8 | unknown items gracefully skipped with warning (#7) | C — B9 [empirical, 2.0.77] | invalid item skipped, valid iron plates restored physically, warning count increased | cross-mod import robustness |
| API-9 | throughput scales with segment fullness (api-23) | (API, marginal) | N/A in-plugin | contextual only |

> **TRIAGE 2026-07-11:**
> - **API-1 / API-2 / API-7 / API-8 — already carry current-pin `[empirical, 2.0.77]` tags** (engine-repin-lab
>   B7-B9 `00e44c7` / no-tick-sync B5); synced, no change.
> - **API-3 / API-4 / API-5 / API-6 — open:** LAB-H (H3/H4) and LAB-I (I1 profiler bake, I2 LocalisedString 20-cap)
>   did not run; API-3/API-6 are doc-verified only, not lab-measured on the pin. (Pitfalls #24/#25 document the
>   profiler/LocalisedString behavior, but neither has a certified rung.)

## 8. Players / passengers — future feature (P5, gated on the feature)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| PLAYER-1 | aboard player carries only equipped gear, hub-locked, no inventory access (api-16) | W | move a character to a platform, read inventory/view-lock on the pin | "passenger carries nothing to sync" assumption |
| PLAYER-2 | native hub-loss returns player to last planet (api-17) | W | trigger hub loss, confirm landing planet | "evacuate-to-planet is native-aligned" argument |
| PLAYER-3 | aboard-detection via `physical_surface_index`; watcher lacks it; no platform players accessor (api-18) | P | place pilot / disconnected-aboard / body / watcher; confirm each detector's indices | passenger-detection logic |
| PLAYER-4 | `teleport` cleanly exits hub-lock for a **connected** player — hand-verified only (api-19) | to-verify | connected hub-locked remote-view player → teleport to planet → confirm clean exit | live-player evacuate path |
| PLAYER-5 | `connect_to_server`: prompts peer, host no-op, no admin gate, `public_address` defaults localhost (api-20) | docs-spike | invoke as host vs connected peer; confirm no-op/prompt + no admin gate | Layer-2 "follow your platform" |

> **TRIAGE 2026-07-11:** PLAYER-1..5 remain **open** — LAB-K is feature-gated (needs a connected player) and did not certify.

## 9. Doc hygiene / meta (P6)
| ID | Item | Action |
|---|---|---|
| DOC-1 | CLAUDE.md/AGENTS.md: two "#20" pitfall headers, no "#8" | renumber |
| DOC-2 | api-notes: many bullets are bare `[empirical]` with **no version pin** — reproducibility on 2.0.77 unverified | re-run/re-pin sweep (Tier-B of issue #69) |
| DOC-3 | AGENTS.md mirrors CLAUDE.md pitfalls verbatim — keep both in lockstep when grounding lands | process note |

---

## How to run this down (method, so it doesn't sprawl)
1. **P0 first, one rung, both gates:** the R11-style rung (GATE-5) measures the item **and** fluid export/restore residual on a flowing platform → grounds GATE-1/2/4 and answers BELT-3. Pair with the CI-save inserter rung (INS-4) since INS losses feed the same thresholds.
2. **Each rung follows the fluid-lab discipline** (controls-first, real transfer path, both-instance cleanup, `--reset` + zero-leftover, tick-stamped, honest UNEXPLAINED) and promotes results to api-notes with `[empirical, 2.0.77]` tags — replacing the guess/hypothesis in place. Nothing is deleted until its test lands.
3. **Mechanism `[hypothesis]` items (P3)** are grounded to stop the circular citation, but note their behavioral rules already hold — they don't block shipping, they block *citing them as law*.
4. Track completion here: an item is DONE when its measurement is committed to a lab notebook + promoted to api-notes with a pin. 0 unproven claims = every row closed.
