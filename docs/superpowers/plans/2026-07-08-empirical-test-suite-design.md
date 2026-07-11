# Empirical Test Suite — rung design for the unproven-claim backlog

> Companion to `2026-07-08-empirical-test-backlog.md` (the ~68 unproven items). This designs the **scientific
> rungs** that close them: the minimum set of experiments, each isolating one variable, grounded in a verified
> API method, with a control, a measurement, and a pass criterion. Every rung reuses the existing lab scaffolding
> (below) and follows the fluid-lab discipline: controls-first, real transfer path where a gate is under test,
> tick-stamped readings, `--reset` + two-instance zero-leftover, append-only NOTEBOOK, honest UNEXPLAINED,
> promote to api-notes with `[empirical, 2.0.77]` on conclusion.

> **TRIAGE 2026-07-11:** entries annotated GROUNDED / SUPERSEDED / QUEUED against landed lab evidence; untagged
> entries remain open. Per-rung status added below. Six labs certified at pin 2.0.77
> (`tests/labs-certified.json`): gate-drift/LAB-A, fluid-lab (R1/R7/R8/R9/R10/R11/R12), inserter-lab/LAB-B (B1-B4),
> no-tick-sync (B5/PR0B), engine-repin (B7-B9), hold-completeness (PR0A). LAB-C/D/F/H/J/K and LAB-I I1/I2 did not run.

## Method (how these were designed, so it doesn't sprawl)
- **11 rungs cover ~68 items** by grouping items that share a fixture/variable. A rung is justified only if a
  **live decision** rests on the belief (di-change #7); mechanism-only `[hypothesis]` items ride along a rung that
  already builds their fixture rather than getting a dedicated one.
- **Two rung styles** (from the scaffolding map): **Style A** = single-instance `/sc` behavior probe (copy
  `tests/no-tick-sync-lab/run-pr0b.mjs` or `tests/fluid-lab/run-r9.mjs`); **Style B** = two-instance real-transfer
  gate grounding (copy `tests/fluid-lab/run-r10.mjs`). Both share `rcon`/`lua`/`lastLine`/`stepTick`, the `mk`
  bare-platform builder, the `read_entity` fluidbox walker, `transferFixture`→`waitForDebugResult`, and the
  canonical 6-field `cleanupAll` (`zero_surfaces, zero_storage, game_paused, destination_holds, locked_platforms,
  committed_source_transfer_tombstones`).
- **API grounding per rung:** each rung lists the API methods it calls, tagged `[plugin-proven]` (production calls
  it at a cited site — de-facto verified), `[doc-verified]` (checked against 2.0.76 Lua docs this session), or
  `[UNKNOWN — this is the measurement]` (the method's behavior IS the unproven claim).
## API verification results (WebFetch against public `lua-api.factorio.com/2.0.76`)
The `factorio-ai-tools` MCP was down; WebFetch against the public docs verified the `[UNKNOWN]` method rows.
Outcomes that change rung tags:

- **DOC-VERIFIED (was `[UNKNOWN]`):** `set_inventory_size_override(index, size_override, overflow?)` — 2.0.76 order
  matches the plugin (H3's only open Q is whether it changed on a *newer* engine). `crafting_speed` **read-only**
  (H1 reads it, correct). `LuaEntity.frozen` **read-only** (LAB-F frozen half genuinely lab-blocked).
  `LuaSpacePlatform.name` **mutable** ([API]-confirms Pitfall #31). `teleport(pos, surface?, …)` accepts a surface
  (PLAYER-4 mechanism supported). `bulk_inserter_capacity_bonus` R/W uint32 0..254, **silent on held-item effect**
  (INS-6 stays a real measurement). `get_fluid_segment_contents`/`get_fluid_segment_id` nil-cases (fluid wagon /
  turret buffer / non-segment) **[API]-confirmed** (FLUID-7).
- **FLUID-4 downgraded to [API]:** the fluidbox is documented as a proxy ("read creates a table; write copies
  fields in — read, modify, write back"). **Plugin-correctness check RAN and PASSED** — grep for an in-place
  `entity.fluidbox[i].field = …` mutation (a silent no-op) found **zero** sites; the one `seg.amount +=` hit is a
  local accumulator, not a proxy. No bug.
- **CONFIRMED doc-vs-empirical CONFLICT (rung vindicated):** `LuaSpacePlatform.destroy(ticks?)` docs say it
  "schedules deletion"; Pitfall #19 measured a **no-op** at 2.0.76. LAB-I I3 stays a required re-verify;
  `GameUtils.delete_platform`'s `game.delete_surface` route is correct.
- **New tools for LAB-C:** `LuaTransportLine.get_detailed_contents()` + `get_line_item_position(pos)` give real
  item positions (sharper than manual reads); `LuaFluidBox.flush(index, fluid?)` for clean fluid-rung resets.
- **New DISCREPANCY for LAB-C:** docs show `insert_at(position, items, belt_stack_size?)` **with** a
  `belt_stack_size` param, contradicting the `belt-transport-line-api-2076` memory ("no such param at 2.0.76").
  BELT-6 depends on it → test `insert_at` WITH the param on the pin.
- **Still genuinely [UNKNOWN] (the measurements):** `crafting_speed` update *timing* (H1); bulk-bonus effect on
  held items (INS-6); `connect_to_server` + `physical_surface_index` (on LuaPlayer, not LuaControl — verify on the
  LuaPlayer page; P5, feature-gated).

---

## Priority order (matches the backlog's P0→P6)
**P0:** LAB-A (export drift → gate calibration), LAB-B (inserter held-loss). **P1:** LAB-C (belt), LAB-E (fluid
temp merge). **P2:** LAB-D (fluid segment mechanics), LAB-G (hold anomalies), LAB-J (TTL). **P3:** LAB-F
(ghost-buffer), LAB-H (machine/beacon). **P4:** LAB-I (engine re-verify). **P5:** LAB-K (passengers).

---

## LAB-A — Export-scan drift (the keystone) · Style B · P0
> **TRIAGE 2026-07-11 — DONE (certified 2.0.77, gate-drift, `d666b23`):** GATE-5 closed, export-scan residual 0/0; BELT-1/2 advanced.
**Question:** do item and fluid **totals** drift during the multi-tick export scan on a **flowing** platform — i.e.
is any loss tolerance even needed, and if so, what is the true residual?
**Closes:** GATE-5, and grounds GATE-1/2/3/4; answers BELT-1, BELT-2, BELT-3(partial); informs the "fix the
measurement, not the number" decision.
**Fixture (controls-first):**
- *Control 1 — static:* a `storage-tank` + settled belt, no flow → export → serialized total vs single-tick
  physical count must be **identical** (proves the instrument; R10 already showed this for a static tank).
- *Experiment — flowing:* offshore/boiler + pipes + pumps moving fluid across ≥2 segments, AND a running belt
  loop with items, on a locked platform → export.
**Measurement:** at export time, capture the plugin's serialized total (`debug_source_platform_*.json`
`verification.fluid_counts` / `item_counts`) vs an **independent single-tick physical census** taken the same tick
(`get_item_count` over all entities incl. belts; fluid segment-dedup sum). Repeat across several export ticks;
residual = max per-name |serialized − physical|.
**API:** `get_item_count` `[plugin-proven` — `destination-hold/run-tests.ps1:361]`; `get_fluid_segment_contents`/
`get_fluid_segment_id` `[plugin-proven` — `inventory-scanner.lua` extract_fluids, `run-r10.mjs:195]`;
`get_transport_line` `[plugin-proven` — `belt_restoration.lua`, belt-lab probes]`.
**Pass/decision:** residual ≈ 0 ⇒ gates go near-exact (epsilon + complete-loss floor; delete the 20/500/5% band).
residual = D>0 ⇒ (a) if the atomic single-tick belt/fluid scan removes it, fix the scan (belt precedent); (b) else
set each gate floor to ~3×D, **measured**. Either way add a complete-loss floor.

## LAB-B — Inserter held-item capacity & restore · Style A + CI-save · P0
> **TRIAGE 2026-07-11 — DONE (certified 2.0.77, inserter-lab B1-B4 `8c61365` + no-tick-sync B5/PR0B):** INS-1/2/3/4/6 grounded (dest-force research governs hand capacity); INS-5 (partial-hand no-tick in CI-fresh) still open.
**Question:** why do held items under-restore on busy/CI platforms, and what actually governs an inserter hand's
capacity and whether `set_stack` seats?
**Closes:** INS-1, INS-2, INS-3, INS-4, INS-5, INS-6 (raise-only); feeds GATE-1/2.
**Fixtures/rungs:**
- B1: `set_stack(n)` on a **settled+deactivated** inserter vs a **briefly-toggled-active** one vs an
  **empty-hand** one → does the item seat? Isolate "settled" vs "deactivated" (INS-1).
- B2: vary the dest force `bulk_inserter_capacity_bonus` (0 vs research'd) and re-seat → does the hand clamp to
  the bonus? (grounds Pitfall #29 / the `held-item-loss-is-dest-force-research` memory on the current pin).
- B3: **the environment-driven case** — load the CI host-2 failing save (INS-4), toggle a partial-hand inserter
  active + `/step-tick 1` → do held items recover? (distinguishes gate-timing artifact from real loss).
- B4: does the bulk hand need a **full tick** to fill (not a synchronous toggle)? (INS-3 candidate).
**API:** `held_stack`/`set_stack`/`.count`/`.valid_for_read` `[plugin-proven` — `active_state_restoration.lua]`;
`bulk_inserter_capacity_bonus`/`inserter_stack_size_bonus` `[plugin-proven` — `import-pipeline.lua` Phase-0 sync,
FORCE_SYNC_PROPS]`; `inserter_stack_size_override` `[UNKNOWN — this is the measurement]` (does it cap the hand?).
**Pass/decision:** identifies the real restore condition → either the pre-gate toggle is sufficient (confirm no-tick)
or a post-activation restore + gate-timing change is required (adjudicated separately).

## LAB-C — Belt reconstruction fidelity · Style A + B · P1
> **TRIAGE 2026-07-11 — open:** not certified (not in `tests/labs-certified.json`). BELT-3 partly answered by LAB-A (export residual 0 → not an export-side phantom); the restore-side reconciliation is still un-run.
**Question:** is the −8 settled / −135–143 busy belt residual real loss or an export double-count phantom, and can
`insert_at` reconstruct a maximally-compressed line?
**Closes:** BELT-3 (real-vs-phantom), BELT-4 (connect-vs-create), BELT-6 (oversized-stack), BELT-7 (spacing
constants A24–A26); confirms BELT-2.
**Fixtures/rungs:**
- C1: source-physical vs serialized-export vs dest-physical **DEDUPED** per-item reconciliation on a busy belt
  loop (the decisive A/B — never per-line deltas, which gave 267 false positives) → is "−135" partly phantom?
- C2: after a transfer, verify every belt feeder entity **CONNECTS** (in/out links) on dest, not just is created
  (BELT-4 MISSING-NEIGHBOR).
- C3: `insert_at` min separation + edge clamp: sweep positions, find the real min-separation and max-edge
  `insert_at` accepts (grounds A24/A25).
- C4: oversized-stack consolidation on a busy real transfer → gate GAINs=0 AND post-activation loss conserved
  (BELT-6).
**API:** `get_transport_line`/`get_max_transport_line_index` `[plugin-proven]`; `LuaTransportLine.insert_at`/
`can_insert_at`/`line_length`/`get_contents` `[plugin-proven` — `belt_restoration.lua]`; `get_item_count` incl.
belts `[plugin-proven` — asserted `get-item-count-includes-belts` memory, re-confirm in C1].

## LAB-D — Fluid segment mechanics · Style A · P2
> **TRIAGE 2026-07-11 — open:** not certified. FLUID-4/7 are `[API]`/doc-verified only (not lab-measured on the pin); FLUID-9 (fusion-output rejection) landed via fluid-lab R11.
**Question:** confirm the segment read/dedup model the fluid accounting rests on, on the pin.
**Closes:** FLUID-4 (proxy window), FLUID-5 (stale read), FLUID-6 (dedup), FLUID-7 (segment-id nil cases),
FLUID-8 (get_capacity split), FLUID-9 (fusion output rejection).
**Fixtures/rungs:**
- D1: write `fluidbox[i]` on entity X of a K-entity segment → read `get_fluid_segment_contents` from entity Y →
  confirm segment-wide (proxy window) and that summing per-entity = K× true (dedup by segment-id recovers 1×).
- D2: activate a fluid entity, sample `fluidbox[i]` every tick vs segment contents → count stale (0/nil) ticks.
- D3: `get_fluid_segment_id` on fluid-wagon / turret buffer / isolated machine → which are nil.
- D4: `get_capacity` on pipe/tank vs machine/thruster → segment vs local; correlate with prototype `base_area`.
- D5: write plasma to fusion-reactor **output** (expect read-back 0) and **input** (accepted) → confirm on pin.
**API:** all `[plugin-proven]` (`inventory-scanner.lua`, `fluid_restoration.lua`, `run-r10.mjs:195` read_entity);
fusion write-rejection `[plugin-proven` behavior, `fusion-reactor-plasma-output` test] — this rung re-verifies on pin.

## LAB-E — Fluid temperature merge & thermal energy · Style A + B · P1
> **TRIAGE 2026-07-11 — PARTIAL:** E1 volume-weighted merge measured [empirical, 2.0.77, fluid-lab R12] (`500@165 + 1500@500 → 416.25`); E2 thermal V×T = QUEUED LAB-TAIL T1; E3 threshold sweep not run (GATE-6 value still unlicensed).
**Question:** is the merge a **volume-weighted** average for **unequal** volumes, is thermal energy conserved on
transfer, and where does `HIGH_TEMP_THRESHOLD` actually belong?
**Closes:** FLUID-3 (weighted-merge general), FLUID-13 (R10c/d), GATE-6 (HIGH_TEMP_THRESHOLD=10000), GATE-7.
**Fixtures/rungs:**
- E1: inject **unequal** volumes at differing temps (`500@165 + 1500@500`) into one segment → merged temp =
  V×T-weighted mean (expect 416.25), not simple mean (R10b only did equal-volume).
- E2: transfer a hot-fluid fixture → compute `sum(amount*temp)` source vs dest → thermal energy conserved ≤5%?
  (R10c — the unrun rung; decides whether the volume-only gate needs a thermal dimension).
- E3: sweep fluid temperature upward → find where per-key reconciliation actually starts to fail (grounds the
  real `HIGH_TEMP_THRESHOLD`, vs the current 10000 that contradicts its >1e6 comment).
**API:** `insert_fluid{temperature}` `[doc-verified` — Fluid concept, `insert_fluid]`; `remove_fluid` by exact
temp `[doc-verified]`; `read_entity` `[plugin-proven]`. Real transfer path for E2 `[plugin-proven` — `run-r10.mjs]`.

## LAB-F — Ghost-buffer / frozen fluid (blocked specimen) · Style A · P3
> **TRIAGE 2026-07-11 — BLOCKED, confirmed on 2.0.77:** [fluid-lab R7] no segment-member deactivatable specimen; `.frozen` read-only [R1/R8]. Mechanism UNCONSTRUCTIBLE; the behavioral rule (inject-after-activation) stands independently on R11.
**Question:** does a frozen/inactive segment-member entity route a fluid write to a wiped ghost buffer?
**Closes:** FLUID-1 (ghost-buffer, 4 sub-claims), FLUID-2 (R7 unanswered), FLUID-14 (frozen half).
**Status:** **BLOCKED** — fluid-lab R7 established no activatable entity on 2.0.77 exposes a non-nil own-fluidbox
segment id, so the specimen is currently unconstructible; `.frozen` is read-only (can't induce via lab). **Do not
spend cluster time chasing it.** The rung is: (a) one more constructibility attempt (modded/injected
segment-member deactivatable entity), and if still unconstructible, (b) record UNCONSTRUCTIBLE on 2.0.77 and mark
the mechanism deferred-to-future-engine. **The behavioral rule (inject-after-activation) stands on separate
[empirical] evidence and does NOT depend on this** — so LAB-F is understanding-only, lowest priority.
**API:** `frozen` `[UNKNOWN/read-only` — confirmed read-only by R1]`; `fluidbox[i]` write on inactive `[plugin-proven]`.

## LAB-G — Destination-hold anomalies · Style A/B · P2 (Phase-2 gated)
> **TRIAGE 2026-07-11 — PARTIAL:** PR0A certified [empirical, 2.0.77] (HOLD-2/3; HOLD-1 `awaiting_launch` only, `descending`/`parking` not constructed); the delta=20 (G1 / FLUID-12) remains UNEXPLAINED (open).
**Question:** isolate the delta=20, and prove the non-`awaiting_launch` pod states + asteroid containment.
**Closes:** FLUID-12 (delta=20), HOLD-1 (descending/parking pods), HOLD-2/3 (hold not-live / asteroid).
**Fixtures/rungs:**
- G1: reproduce delta=20 with the instrumented probe, isolating each candidate — fresh-force recipe-less write
  path (with settle delay) vs meter-staleness (re-read timing) → attribute the 20.
- G2: build live `descending` + `parking` cargo pods → `DestinationHold.stage()` → pod_count=0 + cargo retained
  (the guarantee only proven for `awaiting_launch`).
- G3: long hold → held drift ≤ live-control drift, platform_damage=0, nothing leaves (re-confirm the redefinition).
**API:** `DestinationHold.stage/go_live/discard` via `remote.call("surface_export","destination_hold_json",...)`
`[plugin-proven` — `run-pr0a.mjs]`; `set_surface_hidden`/`platform.paused` `[plugin-proven]`; cargo-pod
`get_inventory(defines.inventory.cargo_unit)` `[plugin-proven` — `run-pr0a.mjs:266]`.

## LAB-H — Machine / beacon behavior · Style A · P3
> **TRIAGE 2026-07-11 — open:** did not run as LAB-H; API-1 (crafting_speed instant) landed via engine-repin B8 and API-2 (craft-in-the-gap) via no-tick-sync B5. H3 (arg-order) / H4 (read-only props) un-run.
**Question:** re-verify the load-bearing crafting/inventory mechanisms on the pin.
**Closes:** API-1 (crafting_speed instant on beacon), API-2 (craft-in-the-gap #15), API-6
(set_inventory_size_override arg order), API-3 (read-only props).
**Fixtures/rungs:**
- H1: populate a beacon's `beacon_modules` on a deactivated, unpowered nearby crafter → read `crafting_speed`
  same tick → confirm instant update + the set_stack slot-cap numbers (cs 17.375→12, 2.5→7).
- H2: activate a deactivated furnace mid-inventory → per-tick item deltas → does crafting advance in the
  activation→count window and produce the GAIN (grounds craft-in-the-gap #15, the reason items validate pre-activation).
- H3: `set_inventory_size_override` — call on the pin, determine which positional order `(index,size,overflow)`
  vs `(index,overflow,size)` actually takes effect (A10 / API-6).
- H4: attempt post-create writes to `quality`/`productivity_bonus` → confirm read-only.
**API:** `crafting_speed`/`crafting_progress` `[UNKNOWN — this is the measurement]`; `set_inventory_size_override`
`[UNKNOWN — arg-order is the measurement]`; `beacon_modules`/`get_inventory` `[plugin-proven]`.

## LAB-I — Engine API re-verify (cheap) · Style A · P4
> **TRIAGE 2026-07-11 — PARTIAL:** API-7/API-1/API-8 landed via engine-repin-lab B7-B9 (`00e44c7`); I1 (LuaProfiler bake) and I2 (LocalisedString 20-cap) did not run.
**Question:** confirm the pinned-untested `[empirical]`-no-pin engine facts still hold on 2.0.77.
**Closes:** API-4 (LuaProfiler bake), API-5 (LocalisedString 20-cap), API-7 (platform.destroy(ticks)), API-8
(unknown-item skip); DOC-2 (re-pin sweep — issue #69 Tier B).
**Fixtures/rungs (all one-shot `/sc`):** store `{"", profiler}` → save/reload → baked+correct, raw crashes (I1);
`game.print` a 21-param LocalisedString → crash (I2); `platform.destroy(60)` → no-op at 2.0.76/77 vs schedules
(I3, guards Pitfall #19 / the lint rule); import an export with a dest-absent item → skip+warn no-crash (I4).
**API:** `helpers.create_profiler` `[plugin-proven` — `phase-profiler.lua]`; `platform.destroy` `[plugin-proven`
no-op, Pitfall #19] — re-verify.

## LAB-J — Transfer TTL grounding · Style B (measurement) · P2
> **TRIAGE 2026-07-11 — QUEUED: LAB-TAIL T2** (validation-timeout wall-clock distribution + TTL-2 JS↔Lua constant drift check).
**Question:** replace the estimated TTL components with measured wall-clock.
**Closes:** TTL-1 (RCON/scan/margin/DEFAULT estimates A17/A19/A20/A21/A23), TTL-2 (JS-Lua constant drift check).
**Measurement:** transfer the largest real platform N times, record export-scan ticks, chunked-RCON ticks,
import+validate ticks, controller round-trip → build the distribution; DEFAULT_TTL must exceed p99. Confirm
`VALIDATION_TIMEOUT_TICKS` still equals `helpers.ts VALIDATION_TIMEOUT_MS`.
**API:** `game.tick` stamping `[plugin-proven]`; real transfer `[plugin-proven` — `run-r10.mjs` transferFixture].

## LAB-K — Players / passengers (semi-manual, feature-gated) · Style A + manual · P5
> **TRIAGE 2026-07-11 — open:** feature-gated (needs a connected player); did not run.
**Question:** confirm the wiki/docs passenger claims on the pin, for the future follow-your-platform feature.
**Closes:** PLAYER-1..5 (hub-lock/no-inventory, hub-loss-planet, physical_surface_index detection,
teleport-exits-hublock connected, connect_to_server host-no-op/no-admin-gate).
**Status:** gated on a **connected player** being available (the PR-0C hidden-semantics rung). Semi-manual:
scripted setup + manual observation, per the fluid-lab semi-manual pattern.
**API:** `physical_surface_index`/`surface_index`/`teleport`/`connect_to_server`/`count_entities_filtered`
`[UNKNOWN/wiki — these are the measurement]`.

---

## Non-lab items
- **DOC-1:** renumber the two "#20" pitfalls (+ absent "#8") — doc edit, no lab.
- **DOC-3:** keep AGENTS.md pitfalls in lockstep with CLAUDE.md as each grounding lands.

## Files each rung creates (pattern, not exhaustive)
`tests/<lab>/run-<rung>.mjs` (copy `run-r10.mjs` for Style B or `run-pr0b.mjs` for Style A; swap the fixture Lua +
the `parseSections` allowlist + the global table name; keep the 6-field `cleanupAll`) · append
`tests/<lab>/NOTEBOOK.md` · on conclusion, promote to `docs/factorio-2.0-api-notes.md` with `[empirical, 2.0.77]`
and delete/correct the stale claim there + in `CLAUDE.md`/`AGENTS.md`.

## Verification (per rung, before its conclusion is trusted)
```
node tests/<lab>/run-<rung>.mjs --sections <ids>        # two clean passes
node tests/<lab>/run-<lab>.mjs --reset                  # zero-leftover, BOTH instances
# controls-first: the control rung must read identical/expected before the experiment is believed
# promote to api-notes with the pin; correct CLAUDE.md/AGENTS.md; NEVER delete a claim until its rung lands
```

## Sequencing
1. **LAB-A + LAB-B (P0)** — they ground the source-delete gate thresholds the whole system rests on; start here.
2. LAB-C, LAB-E (P1). 3. LAB-D, LAB-G, LAB-J (P2). 4. LAB-F, LAB-H (P3). 5. LAB-I (P4). 6. LAB-K (P5, feature-gated).
Each lab is independently runnable; do NOT batch — one lab, two clean passes, promote, then next. When
`factorio-ai-tools` MCP reconnects, run a one-pass signature check over the `[UNKNOWN]` API rows to harden specs.
