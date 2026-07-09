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
| GATE-6 | `HIGH_TEMP_THRESHOLD=10000` splits per-key vs by-name fluid reconcile (A13) | G | temperature where the engine actually starts merging/losing key precision — comment cites >1,000,000°C, value is 10000 (2 orders off) | fluid reconcile path selection |
| GATE-7 | `LOSS_TOLERANCE_PCT=0.05` / `LOSS_TOLERANCE_ABS=25` high-temp reconcile (A11/A12) | G | volume drift from temperature-bucket merging at extreme temps, as a fraction | high-temp fluid report (non-gating today) |
| GATE-8 | loose-path `STORAGE_TOLERANCE=5`, `TOTAL_LOSS_TOLERANCE=0.95`, `MIN_ABSOLUTE_LOSS=100`, unexpected `>20` (A4/A5/A6/A9) | G | spurious gain / real loss on **non-transfer** (upload) imports — acknowledged over-tolerant instrument | uploaded-JSON import verdict |

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

## 3. Inserter / held-item fidelity (P0)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| INS-1 | `set_stack` silently fails on a **settled-deactivated** inserter (#28 root cause) | X | `set_stack` on settled+deactivated vs briefly-toggled-active inserter: does the item seat? isolate "settled" vs "deactivated" | the `restore_held_items_only` "fix the clock" design |
| INS-2 | busy-CI ~115-item loss = held items under-restored; partial hands never topped up (B14) | X | src-held vs dest-held per item on CI after a candidate fix (D1/D2 diagnostic) | busy-platform strict gate; GATE-1/2 |
| INS-3 | Fix A failed — briefly-active+`set_stack` does NOT seat on CI inserters; candidates unprobed (override, bulk-needs-a-TICK, filter/pickup) (B15) | X | probe each candidate on a real CI inserter: hand fills after a full tick vs a synchronous toggle? does override cap it? | the entire pre-gate held-restore premise (no-tick-sync) |
| INS-4 | held loss is environment/path-driven, not payload; only CI host-2 world reproduces it (B16) | U | load the CI save, toggle inserter active + step one tick → do held items recover? (gate-timing artifact vs real loss) | pre-gate fix vs post-activation-restore choice |
| INS-5 | no-tick-sync validated only an **empty/settled** hand, not a partial-filled bulk inserter (B24) | X | run the no-tick sync assertion against a partially-filled bulk inserter in CI-fresh state | ties INS-2/3; the "restore-held-before-gate, no tick" premise |
| INS-6 | force-sync must be RAISE-ONLY — LOWERING a dest bonus "ejects other platforms' held items" (#29) | X | lower `bulk_inserter_capacity_bonus` on a force with seated over-capacity inserters → are held items ejected? | raise-only Phase-0 sync safety argument |

## 4. Fluid fidelity & mechanisms (P1/P2/P3)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| FLUID-1 | ghost-buffer / fluid-detach mechanism (frozen ⇒ detached; write ⇒ ghost buffer; merge wipes it) (#17 / api-7 / B9) | H + uninspectable | needs a modded/injected specimen that is BOTH segment-member AND deactivatable: write-inactive → read → reactivate → read (survives=refute / wiped=confirm). 4 sub-claims 3a–3d | inject-after-activation *rationale* (behavior stands independently) |
| FLUID-2 | R7 unanswered — no activatable entity on 2.0.77 exposes a non-nil own-fluidbox segment id (B11 / api-4) | X | find an activatable entity whose fluidbox reports non-nil segment id, then test detach/merge | FLUID-1; the "merge favors larger segment" sub-claim |
| FLUID-3 | temperature merge = **volume-weighted average**, general/unequal-volume (#23 / api-6) | H | inject unequal volumes at differing temps (`500@165+1500@500` → expect 416.25) via real transfer; confirm V×T-weighted, not simple mean; and V×T conserved | aggregate-by-name gate; thermal-energy validation |
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

## 5. Destination-hold & cargo pods (P2, Phase-2 gated)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| HOLD-1 | `descending`/`parking` pods route through recover-and-spill — NOT constructed as a live specimen (api-21 / B18-adjacent) | X | build live `descending` + `parking` pods, run `DestinationHold.stage()`, confirm pod_count=0 + cargo retained | "pod-free after stage" guarantee for non-`awaiting_launch` |
| HOLD-2 | held platform "not-live" = drift ≤ live control (spoilage/asteroids advance) — accept-by-redefinition (B17) | X | held drift ≤ live drift, platform_damage=0, nothing-leaves — later runs assert; confirm the redefinition holds broadly | no-duplicates "not-live" contract |
| HOLD-3 | held platform's asteroid is NOT contained (`held_asteroid_contained=false`) but terminal matches live (B19) | X | does asteroid ever leave the platform or damage it (both currently 0)? | user expectation of "not-live" |

## 6. Transfer TTL & timing estimates (P2)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| TTL-1 | `WORST_CASE_RCON=3000` / `SCAN_IMPORT=6000` / `MARGIN=3000` / `DEFAULT_TTL=36000` (A17/A19/A20/A21/A23) | G/semi | real end-to-end transfer wall-clock distribution for the largest platform → TTL must exceed p99 | source auto-unlock timing; committed-tombstone retention |
| TTL-2 | `VALIDATION_TIMEOUT_TICKS=7200` == JS `VALIDATION_TIMEOUT_MS` (A18, grounded) | (drift check) | confirm the Lua constant still equals the JS constant | timeout consistency |

## 7. Engine / API claims — re-verify on the 2.0.77 pin (P3/P4)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| API-1 | `crafting_speed` updates **instantly** on beacon_modules populate — no tick, no power (api-15 / pitfall) | P/X | populate beacon_modules on a deactivated unpowered machine, read crafting_speed same tick; confirm set_stack slot-cap numbers (cs 17.375→12, 2.5→7) | beacon-before-crafter two-pass ordering |
| API-2 | craft-in-the-gap: machines craft in the activation→count window → false GAINs (#15) | H | activate a deactivated furnace mid-inventory, count per-tick deltas — does crafting advance in the window and produce the GAIN magnitude? | "validate pre-activation" ordering |
| API-3 | entity props read-only in 2.0 (quality, productivity_bonus aggregation) (api-14 / #6) | P/X | attempt post-create writes on the pin; confirm read-only; confirm bonus aggregation composition | set-at-create + pcall rule |
| API-4 | LuaProfiler non-serializable; `{"", profiler}` bakes value on save/reload; display-only (api-12) | P | store `{"", profiler}`, save/reload, confirm baked+correct; confirm raw-profiler storage crashes | persisted timing/telemetry |
| API-5 | LocalisedString capped at 20 params → crash `N > 20` (api-13 / #25) | P | print a 21-param LocalisedString, confirm crash on the pin | split-print rule in import completion |
| API-6 | `set_inventory_size_override` arg-order changed post-2.0.76 (api-10) | X (inference) | call on the current engine, determine which positional order takes effect | future use on upgraded engine |
| API-7 | `platform.destroy(ticks)` schedules deferred deletion in "latest" (no-op at 2.0.76) (api-11 / #19) | W | if upgraded past 2.0.76, confirm destroy(ticks) actually deletes | future switch off `game.delete_surface` |
| API-8 | unknown items gracefully skipped w/ warning (v1.0.84+) (#7) | X | import an export with a dest-absent item; confirm skip+warn, no crash/corruption | cross-mod import robustness |
| API-9 | throughput scales with segment fullness (api-23) | (API, marginal) | N/A in-plugin | contextual only |

## 8. Players / passengers — future feature (P5, gated on the feature)
| ID | Claim | Status | What a test MEASURES | Depends on |
|---|---|---|---|---|
| PLAYER-1 | aboard player carries only equipped gear, hub-locked, no inventory access (api-16) | W | move a character to a platform, read inventory/view-lock on the pin | "passenger carries nothing to sync" assumption |
| PLAYER-2 | native hub-loss returns player to last planet (api-17) | W | trigger hub loss, confirm landing planet | "evacuate-to-planet is native-aligned" argument |
| PLAYER-3 | aboard-detection via `physical_surface_index`; watcher lacks it; no platform players accessor (api-18) | P | place pilot / disconnected-aboard / body / watcher; confirm each detector's indices | passenger-detection logic |
| PLAYER-4 | `teleport` cleanly exits hub-lock for a **connected** player — hand-verified only (api-19) | to-verify | connected hub-locked remote-view player → teleport to planet → confirm clean exit | live-player evacuate path |
| PLAYER-5 | `connect_to_server`: prompts peer, host no-op, no admin gate, `public_address` defaults localhost (api-20) | docs-spike | invoke as host vs connected peer; confirm no-op/prompt + no admin gate | Layer-2 "follow your platform" |

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
