# ONE-SHOT agent brief — BELT-R1: isolate the nondeterministic -4 belt loss (capture → replay → attribute)

> ONE-SHOT: decisions pre-adjudicated. Valid stops: (a) audit-ready, (b) listed hard stops. Standing
> discipline unchanged. You own the cluster. Context: a frozen-gate census caught -4
> piercing-rounds-magazine, localized ENTIRELY to transport belts (all inventories/hands/turrets/fluids
> exact; 7136 serialized → 7132 frozen). Ten follow-up transfers passed — the loss is configuration-
> dependent (source belts run between attempts, so every attempt exports different belt state). This is
> the residual of the historical "±4-8 belt drift" that dfdd59d fixed to zero on the configurations it
> tested. The exact gate correctly fails and preserves the source, so users lose attempts, never items.

## Adjudicated design: make the failure self-capturing, then replay it deterministically.

## Phase 1 — fix the meter FIRST (trust the instrument before the experiment)
`unplaced_diag` over-reports on merged belt lines (reported 347 against a real loss of 4). Rework the
belt-restoration diagnostics to per-(surface, entity unit_number, line index) attribution: serialized
items per line vs physically placed per line, counted at RESTORE time. Prove the meter on a healthy
transfer: total attribution delta must equal the gate's belt delta exactly (0 on a green run). Do not
proceed past this phase until the meter reconciles.

## Phase 2 — always-on capture (production black-box enhancement; small, DI-adjacent)
Extend `bank_failure_black_box` with a per-line belt section: for every transport-belt-family entity,
serialized per-line (name,quality,count) vs frozen-dest per-line physical contents, plus the line's
topology facts (belt type, direction, neighbours, oversized-stack involvement, compression state).
ALSO bank the full serialized platform payload (or its export id) so the exact failing input is
replayable. This is always-on forensics under the Black-Box Discard ruling — never debug-gated.
/di-change applies (it touches the failure path); the exact gate itself untouched.

## Phase 3 — fish, then replay
1. Loop cheap-fixture transfers of a belt-heavy fixture (dense loops, merged lines, splitters,
   underground pairs, an oversized-stack line, piercing-rounds-magazine among the cargo — reuse the
   1,359 platform ONLY if the cheap fixture fails to reproduce within budget) until a gate failure
   banks a capture, budget ~40 transfers. Between attempts, let the source belts RUN a randomized
   50-500 ticks (that is the configuration dice — do not pause-freeze between attempts).
2. On capture: REPLAY the banked payload via upload-import N=5 to the destination. Expected: the loss
   becomes DETERMINISTIC under fixed input. If replay conserves 5/5, the loss is import-timing
   nondeterminism instead — record that honestly and capture a second failure to compare.
3. Attribute: the per-line diff names the exact line(s) and topology class. Minimize: hand-build the
   smallest fixture with that topology; confirm it loses deterministically.
4. If 40 transfers never reproduce: commit the meter fix + black-box enhancement anyway (they are the
   permanent trap), document the anomaly as OPEN-INSTRUMENTED in the NOTEBOOK + backlog (the next
   natural occurrence self-captures), and proceed to close-out. Do NOT call it fixed or explained.

## Phase 4 — fix only what the data names
If the minimized topology isolates a restore-side defect (e.g. an insert_at edge case, an
oversized-stack collision, a merged-line ordering bug): fix it in belt restoration, prove with the
minimized fixture N=5 green + the fixture ships as a permanent integration test (red on pre-fix code
once). If the defect is EXPORT-side (atomic scan edge): hard stop with the evidence — that touches
Pitfall #16 territory and needs re-adjudication. Never add tolerance anywhere.

## Also fold in (small, unrelated to belts)
The T2 harness reporting flaw: `entities` is sampled when the destination platform first becomes
visible (pre-completion), producing misleading counts (1 / 57 / 1359). Sample at import completion or
label the field `entities_at_first_visibility` — completion evidence must come from the completion
event only.

## Close-out
Meter reconciliation proof + capture/replay/attribution table (or OPEN-INSTRUMENTED status) in the
NOTEBOOK; commits split (fix(diagnostics) / feat(black-box) / test / docs); LAB-TAIL certification
remains HELD unless the loss is fixed-and-proven or formally OPEN-INSTRUMENTED with owner sign-off
noted in the PR body; full verification chain; ONE PR; stop for audit.

## Hard stops
The replayed payload loses a DIFFERENT amount each replay (input-fixed nondeterminism inside import —
deeper engine issue) · attribution implicates the export scan (Pitfall #16 territory) · any second
loss class appears · cluster unrecoverable.
