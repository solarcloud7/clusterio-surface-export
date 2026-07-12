# LAB-TAIL agent brief — thermal-energy conservation + the operational-constant measurements

> You are the **implementer** on `codex/composite-transfer-verdict` (pull latest). Follow the
> [Agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md). Run `./tools/check-pr-scope.ps1` during orientation and immediately before opening the PR. Orchestrator audits; **stop for audit at
> the end.** Measurement only — no gate/validator/production-ordering or constant changes.


## Rungs (four; section-selectable; controls first; predictions up front)

**T1 — LAB-E E2: thermal-energy (V×T) conservation across a real transfer** (home: `tests/fluid-lab`, R13).
The high-temp display validates on Volume × Temperature (Pitfall #23, thermal energy validation) — the math
has never been checked against a measured transfer. Fixture: fusion setup with hot plasma (and a
heat-exchanger steam line as the mid-temp control). Real transfer; record per-name V, T, and V×T on source
(frozen census) and destination (both censuses), including the engine-rejected plasma writes. Prediction:
volume conserves exactly (R11); V×T of the RESTORED portion conserves within double precision; the display
math in `web/utils.js`/`loss-analysis.lua` (`highTempAggregates`) agrees with the physical numbers. Any
disagreement = the display lies → report, don't fix.

**T2 — validation-timeout wall-clock distribution** (home: `tests/engine-repin-lab` or a new
`tests/ops-lab`; TS-sweep finding A2). `VALIDATION_TIMEOUT_MS=120_000` guards against a measured 60–90s
operation with unquantified margin — and an overrun is a duplication path until PR-3 lands. Measure: ≥5
transfers of the 1359-entity platform end-to-end, recording per-phase wall-clock (export-ready → import
complete → validation event received, from the cluster logs' timestamps); then ONE larger synthetic platform
(clone + programmatic densification if feasible, else the biggest fixture you can build cheaply) to measure
scaling. Deliverable: the distribution + a recommended timeout = measured p99 × cited margin. Do NOT change
the constant.

**T3 — actual max single RCON command size at the pin** (home: `tests/ops-lab`). Three contradictory claims
coexist: `RCON_CHUNK_SIZE=100_000` (works in CI, 235KB exports move), a 7,000-byte gateway-config guard
citing "~8KB RCON limit", and CLAUDE.md's "4KB chunks / max ~8KB / ~100 bytes-per-tick throughput". Measure:
binary-search the size at which a single `/sc` payload fails or times out (harmless payload — a string-length
echo), and measure round-trip time vs size (1KB → 4KB → 8KB → 32KB → 100KB → failure point). Deliverable: the
measured limit + throughput curve. Licensed doc fix: CLAUDE.md's "RCON Throughput Limits" section rewritten to
the measured numbers (docs commit). The helpers.ts/lua-interface.ts comment corrections are code-file changes
→ leave for the follow-up PR; report the lines.

**T4 — stored-export latency vs payload size** (home: `tests/ops-lab`; TS-sweep A6). The same physical wait
has a 10s timeout on the transfer path and 60s on the download path. Measure stored-export readiness latency
(export command → export retrievable) for a small platform, the 1359-entity platform, and T2's larger
synthetic. Deliverable: latency vs size + a recommended unified constant. No code change.

## Docs pass (ONE pure-docs commit, only rung-licensed corrections)
- CLAUDE.md "RCON Throughput Limits" per T3 (mirror AGENTS.md locally).
- api-notes: T1's thermal-energy result + T3's measured RCON limit, tagged `[empirical, 2.0.77, <lab>]`
  (T2/T4 are OPERATIONAL measurements of our own stack, not engine facts — they go in the backlog/NOTEBOOK
  and the TS-sweep triage doc, not api-notes).
- Backlog rows: LAB-E E2, plus new rows OPS-1 (validation timeout) / OPS-2 (RCON size) / OPS-3 (stored-export
  latency) marked MEASURED with the numbers.

## Discipline
The canonical discipline linked above applies. LAB-specific additions: controls first; tick-stamped readings;
physical counts; append-only lab NOTEBOOKs; honest `UNEXPLAINED`; one `test(...)` commit per lab home; one
pure-docs commit; and the stop conditions below.

## Stop conditions
T1 shows V×T of the restored portion NOT conserving (beyond double precision) · T3's measured limit is BELOW
a size the plugin currently sends in one command (that would be a live operational risk — stop immediately
with the evidence) · cluster failures · any DI-lint fires · anything seeming to need a production change.

## Report format
Per-rung: prediction → measured numbers → verdict, with the key evidence lines · T2/T4's distributions and
recommended constants (explicitly labeled RECOMMENDATION, not applied) · which doc fixes were licensed and
applied · two-pass + zero-leftover proof · diff summary proving scope held.
