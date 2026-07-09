# LAB-A agent brief — build & run the export-drift rung (Lane 1, the critical path)

> You are the **implementer**. The orchestrator audits your evidence and owns all gate/code decisions —
> **stop-for-audit at the end; change no production code.** This rung produces the first MEASURED number for the
> validation-gate tolerances; everything downstream (#76 hardening, PR-3) is gated on it.

## Source of truth — read these first, in order
1. `docs/superpowers/plans/2026-07-08-lab-a-execution-spec.md` — THE spec: the question, the code-grounded
   design (belts got an atomic scan, fluids didn't — the fluid arm is load-bearing), the preconditions to
   determine during the build, the measurement API, the runner design, and **the owner parity contract that
   bounds what the result may be used for. Follow it exactly.**
2. `docs/superpowers/plans/2026-07-08-empirical-test-suite-design.md` — the LAB-A entry + the scaffolding
   template (Style-B runner anatomy, what to copy from `tests/fluid-lab/run-r10.mjs`).
3. `CLAUDE.md` §"Empirical lab discipline" + §"Integration-probe iteration discipline" — the rules; each was
   paid for in a real incident.

## Sequencing

**0. Environment (may be down — it was at authoring).**
- Start Docker Desktop if the engine is not running, then `docker compose up -d` from the repo root.
- POLL for readiness (deadline loops, never fixed sleeps): controller container healthy, then both instances
  `running` via clusterioctl, then RCON answers (`./tools/rcon.ps1 11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"` → `true`).
- **NEVER touch `atlas-*` containers** (a different cluster on this machine, controller :8090).
- The deployed save's Lua already matches this branch (no module changes since the 0.10.77 patch-and-reset);
  do NOT `patch-and-reset` unless the plugin fails to answer. Enable dumps:
  `./tools/rcon.ps1 11 "/sc remote.call('surface_export','configure',{debug_mode=true})"`.
- The `rc11`/`rc21` profile aliases do NOT exist in your shell — always `./tools/rcon.ps1 11|21 "..."`.

**1. Boundary questions.** Raise them BEFORE coding **only** if you need to deviate from the spec's design or
its decision contract. The spec's "preconditions to determine during the build" (the freeze0 probe, forcing a
multi-tick export, seg-id stability) are **experiments to run, not questions to ask**.

**2. Build** `tests/gate-drift-lab/run-lab-a.mjs` (copy `tests/fluid-lab/run-r10.mjs` per the spec):
- CLI: `--sections freeze0,control,fluidflow,beltflow` · `--reset` · `--no-notebook` (iteration).
- **LAB-A is EXPORT-ONLY on host-1** (`/export-platform <idx>` — export, not transfer; destination stays nil so
  the platform unlocks after completion). No dest side, no transfer. Compare
  `debug_source_platform_*.json → verification.{fluid_counts,item_counts}` against your **same-tick independent
  physical census**, built with the SAME dedup the export uses (segment-id dedup for fluids;
  `get_item_count` over all entities incl. belts for items) so the comparison is apples-to-apples.
- **Force a genuinely multi-tick export** (`/export-sync-mode off` + enough entities) and RECORD the tick span
  in the evidence — a 1-tick export cannot drift and would produce a false "no drift".
- Fixture hazards already paid for: bare platforms need `apply_starter_pack()`; surface deletes are deferred a
  tick (step ticks after cleanup before asserting); never `platform.destroy()` (no-op — route through
  `game.delete_surface`/`GameUtils.delete_platform`); every `pcall` must surface its error; select debug dumps by
  the exact fixture platform name, never "latest file", and delete stale dumps before each rung.
- Keep the **6-field zero-leftover `cleanupAll` on BOTH instances** (`zero_surfaces, zero_storage, game_paused,
  destination_holds, locked_platforms, committed_source_transfer_tombstones`).

**3. Run — controls first.** The static control (tank + settled belt, no flow) must read **EXACT** before any
flowing number is believed; if it doesn't, STOP — the instrument is broken. Then `freeze0` (do fluids/belts even
move on a locked platform during export?), then the flowing fluid + belt sections. **Two clean full passes +
zero-leftover evidence, reported ONCE at the end** — no live narration, no single-pass "done".

**4. Conclude.**
- Append `tests/gate-drift-lab/NOTEBOOK.md` (append-only; record failures and UNEXPLAINED honestly — an
  eliminated failure with an un-isolated root cause is UNEXPLAINED, not fixed).
- Promote durable facts to `docs/factorio-2.0-api-notes.md` tagged `[empirical, 2.0.77]`.
- **Do NOT touch gate constants or anything under `module/validators/`** — this rung is measurement only; the
  #76 hardening is a separate task gated on your result. Do NOT delete existing doc claims; flag them.

**5. Commit & stop.** Runner + NOTEBOOK + api-notes promotion as one `test(gate-drift-lab): ...` commit on the
current branch (`codex/composite-transfer-verdict` — same precedent as the R10 commit `ae1efe6`). No session
URLs, no `Claude-Session:` trailers. Then **stop for audit**.

## Stop conditions (report, don't improvise)
Docker/cluster won't come up · the static control is not exact · any result appears to require a gate/code
change · any DI-lint fires on your change (**escalate — never self-approve an `*:allow`**).

## Report format (your final message)
1. **freeze0:** do fluid segments / belt lines still change tick-to-tick on a locked platform during export?
   (If fluids are fully frozen, drift is impossible — say so; that alone is a major result.)
2. **The residual:** max per-name |serialized − physical|, separately for **fluids** (the open path) and
   **items/belts** (validating the atomic-scan fix), with the export's measured tick span.
3. **Classification per the spec's contract:** residual ≈ 0 / measurement artifact / real loss — and which
   decision branch of the spec it selects. Do not recommend a gate change; the orchestrator owns that.
Include the key tick-stamped evidence lines, the two-pass proof, and the both-instance zero-leftover blocks.
