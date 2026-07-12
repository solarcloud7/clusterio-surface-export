# Process notebook

Append-only ledger for material execution anomalies that can change the interpretation, reproducibility, or safety of engineering work.
Routine command output, status narration, and session URLs do not belong here.
Do not rewrite prior entries; append a correction that cites the superseded entry.

Use `[empirical, process, YYYY-MM-DD]` for a committed or independently reproducible observation.
Use `[hypothesis, process]` when reproduction is still pending.

Record an entry only when at least one of these occurs:

- an environment assumption causes a command or verification failure;
- a tracked file changes unexpectedly;
- a workaround changes bytes or changes the evidence path;
- a lint exception is considered or escalated;
- evidence contradicts a named claim, rule, or prior conclusion.

## Entry template

### YYYY-MM-DD - Short title `[empirical, process, YYYY-MM-DD]`

- **Command/action:** Exact command or action that exposed the anomaly.
- **Expected result:** The named expectation or claim.
- **Actual result:** The observed result, including the decisive output.
- **Affected paths:** Repository-relative paths, or `none`.
- **Impact:** What evidence, scope, or safety decision could be wrong without this record.
- **Workaround:** The bounded workaround used, or `none`.
- **Final disposition:** `OPEN`, `UNEXPLAINED`, `FIXED-PROVEN`, `REFUTED`, or `SUPERSEDED`, with a short explanation.
- **Durable references:** Commit, file and line, test artifact, or reproducible command. Never a session URL.
