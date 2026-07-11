# Hardening/consolidation campaign plan (2026-07-11, owner-selected)

> The post-transfer-campaign initiative: no new product feature. Burn down residual risk, close guard
> blind spots, explain the unexplained, and polish operations. **Starts after the two-phase-commit lane
> merges** (it changes the delete/hold paths several items touch); the cluster-free workstreams (W2, W4,
> W5) may interleave earlier whenever an agent is idle. Standing rules apply throughout (stop-for-audit,
> `/di-change` on gate/delete paths, allows are escalations, package-lock untouched, no session URLs,
> commit labels are audit boundaries).

## What this campaign is NOT
- Not the gateway Phase-2 feature, not passenger Layer 2, not the clusterio-docker/2.1.8 migration —
  those are separate owner-gated initiatives. (W1's API-drift rungs deliberately FEED the migration by
  widening the re-certification suite, but do not start it.)
- Not a refactor hunt: the structural Tier-2 backlog is fully retired (table-driven restores shipped
  PR #10; message-class de-dup deliberately HELD with the round-trip harness as the guard, PR #12; web
  payload typing complete PRs #11/#13). The remote-interface surface asymmetry stays (documented public
  contract). Re-litigating any of these requires new evidence, not new taste.

## W1 — Lab completion wave (cluster-bound; the 23 open backlog entries, re-prioritized)
The exact gate changed what labs are FOR: fidelity is solved and thresholds are deleted, so remaining
rungs are valued by (a) explaining shipped-path anomalies, (b) widening version-bump re-certification
before the eventual 2.1.8 migration, (c) unblocking future features. Priority order:
1. **FLUID-12 root-cause isolation** — the destination-hold `delta=20`, honestly recorded UNEXPLAINED.
   An eliminated failure whose cause was never isolated is a landmine on a shipped path. One dedicated
   rung ladder; outcome is either a mechanism [empirical] or a reproducible tripwire test.
2. **LAB-K player rungs (PLAYER-1..5)** — remote-view/boarding/evacuation semantics. Also the direct
   empirical foundation for passenger Layer 2 and the gateway GUI, whichever the owner picks later.
   Includes adopting/finishing the hidden-semantics manual lab (draft PR #74 — needs the owner in the
   game client; schedule it as the one human-in-loop session of the campaign).
3. **API drift rungs (API-3..6, GATE-8, INS-5)** — widen `tests/labs-certified.json` coverage so
   guard #11's re-certification actually re-certifies the full belief surface at the next pin bump.
4. **LAB-C/D leftovers (BELT-4..7, FLUID-4..8/10/11)** — lowest value post-exact-gate; run only if the
   wave has budget left, or fold into the next pin-bump re-certification.
Every rung follows the lab discipline (NOTEBOOK, controls first, one variable per rung, zero-leftover,
promote facts to api-notes WITH tags, then annotate the backlog entry GROUNDED).

## W2 — Guard blind-spot closure (cluster-free)
1. **pcall guard blind spot**: extend `lint-pcall-logging.mjs` to flag the `return x, (ok and y) or
   default` swallow shape (recorded in the pcall/catch audit as the known evasion). Teeth-verify.
2. **test-hooks guard depth**: today's check is file-level (`finally` anywhere in the test satisfies
   it); upgrade to hook-level — the disarm must be inside a `finally`/`trap` that dominates the arming
   site. (Found by an earlier adversarial review; pre-existing weakness in a DI guard.)
3. **Doc-count drift**: CLAUDE.md + docs/CI_CD.md guard inventory says nine + commit-labels; reality
   after guards #10/#11 is eleven + commit-labels. Fix counts, add the two new bullets in house style
   (origin incident + allow marker), mirror AGENTS.md locally.
4. Triage survivors of the high-effort gate review (workflow pending at authoring) into fixes here if
   small, or their own PR if DI-severe (escalate to owner first).

## W3 — Operational polish (mostly cluster-free; UI needs a controller restart to verify)
1. **Degraded-storage UI banner**: the persistence fixes log loudly but the web Exports tab still shows
   silently empty on a degraded load. Thread `storageLoadError` into the existing subscription state and
   render a warning banner (Exports tab + Transaction Logs tab). Message mirrors the log guidance
   (back up → repair/move aside → restart; never delete).
2. **Operator runbook**: a docs section for the two corrupt-file scenarios (stored exports, transaction
   history): symptoms, exact log lines to search, recovery steps, what is/isn't lost. Link it FROM the
   log messages' wording (they already name the path and remedy).
3. **Metrics usability**: a short doc of ready-to-paste PromQL for the `surface_export_*` metrics
   (success rate, failure_stage breakdown, duration p95, entities throughput), so the labels added in
   the gate rewrite get used. No new collectors unless a real question can't be answered.

## W4 — Upstream promotion sweep (cluster-free, inventory-first)
One read-only agent sweeps the plugin/campaign for generic, upstreamable artifacts and produces a
ranked inventory with effort/benefit — candidates to evaluate, not conclusions: the Link-method
binding hazard (Pitfall #26) as an upstream lint rule or docs PR; chunked-RCON helper patterns;
send_json ergonomics; anything in the clusterio-ops skill that is really upstream documentation.
Then the owner picks what becomes actual `clusterio/clusterio` PRs (fork workflow per the dev-env
memory). Inventory only in this campaign; upstream PRs are their own follow-on lane.

## W5 — Truth-sync completion (cluster-free)
1. ENGINEERING_FAQ sweep: answer rows changed by the single exact gate, Black-Box Discard, and (once
   merged) the 2PC handshake; flag any newly-unanswered rows ⚠️ OPEN rather than fabricating.
2. Memory hygiene at campaign end: mark resolved items (the delete-seam memory is already RESOLVED at
   HEAD — verified 2026-07-11), refresh the backlog memory as entries move GROUNDED.
3. Retire stale plan docs by annotation (EXECUTED/SUPERSEDED headers), never deletion.

## Sequencing & ownership
- W2 + W5.1 first (cluster-free, small, high leverage), interleavable with the 2PC lane today.
- W1 owns the cluster after 2PC merges; LAB-TAIL (already queued) runs first as the bridge.
- W3 after W2 (the banner rides on the persistence fixes; no DI surface).
- W4 anytime (read-only).
- Exit criteria: zero UNEXPLAINED anomalies on shipped paths · guard blind-spot list empty · backlog
  open-count materially down with every remaining entry either QUEUED to a named rung or explicitly
  deprioritized · operator can diagnose both corrupt-file scenarios from docs alone · upstream inventory
  delivered.
