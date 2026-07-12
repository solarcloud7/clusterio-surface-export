# Agent workflow evidence audit

> Status: audit packet only. This document records evidence and proposed rule deltas; it does not authorize
> workflow, harness, lint, or agent-instruction changes. Stop for second-source adjudication before W1-W3.

## Evidence vocabulary

- **[empirical, process, 2026-07-11]**: supported by committed repository evidence or a reproducible command.
- **[hypothesis, process]**: observed in the execution transcript but not yet independently reproduced.
- **Rule delta**: `NEW`, `STRENGTHENS <existing rule>`, or `ALREADY LAW`.

The evidence status describes what is known. The rule delta describes how an accepted lesson relates to existing
law. The proposed mechanism is a future change candidate, not an observed fact.

## Evidence matrix

| Finding | Observed fact and evidence | Rule delta | Proposed mechanism (not yet authorized) |
|---|---|---|---|
| Homogeneous fishing missed a workload-dependent anomaly | **[empirical, process, 2026-07-11]** Commits `5ad8e95` and `3eb291c` banked an `OPEN-INSTRUMENTED` result after forty production-shaped transfers with randomized belt intervals passed `40/40` (`tests/belt-lab/NOTEBOOK.md:358-393`). The second heterogeneous full-suite pass then captured `processing-unit expected=30 actual=29` (`5808128`; `NOTEBOOK.md:394-400`). Fixed-input minimization found 549 belts green and 550 belts red (`NOTEBOOK.md:401-412`). | `STRENGTHENS` integration-probe rule 8 (`CLAUDE.md:194-195`) and the empirical lab ladder (`CLAUDE.md:197-217`). The two-pass requirement already exists and must not be duplicated. | For nondeterministic fishing, list the unruled dimensions before execution and vary fixture/workload shape as well as the suspected timing dimension. Final heterogeneous suites remain part of adjudication, not ceremonial closeout. |
| Attribution teeth proved caller assignment but not producer return | **[empirical, process, 2026-07-11]** Commit `e6abfc4` changed only `import-completion.lua` and its source-contract test; `BeltRestoration.restore()` still returned no `attribution`. Commit `9f67e89` added the return plus teeth requiring the producer result (`composite-transfer-verdict.test.cjs:462`) and its survival to the frozen verdict (`:471`). | `STRENGTHENS lint:test-grounding`; it does not create a parallel data-integrity rule. | Require seam evidence at producer, transport, and serialized consumer. Prefer a runtime artifact witness where practical; source-text tests must cover both ends of the seam. |
| Recovery required a full-sink adversary | **[empirical, process, 2026-07-11]** The full-hub fixture measured belt=18, hub accepted=0, ground=1, total=19 (`NOTEBOOK.md:418-428`). Production recovery tries hub insertion, then spills only the remainder, and leaves any unrecovered remainder gate-red (`belt_restoration.lua:114-154`). The permanent five-run fixture is `tests/integration/belt-loss-replay/run-tests.ps1`. | `STRENGTHENS` the existing adversarial-fixture discipline; no sibling recovery rule is needed. | Recovery acceptance should exercise missing, full, partial, and failing sinks. A green primary-sink case alone is insufficient. |
| Topology-first minimization missed the decisive workload boundary | **[empirical, process, 2026-07-11]** The implicated connected component conserved `19 -> 19`; the order-preserving workload search found 549 belts at `24 -> 24` and 550 belts at `24 -> 23`; clearing unrelated cargo retained `19 -> 18` (`NOTEBOOK.md:401-412`). | `STRENGTHENS` the one-variable lab ladder in `CLAUDE.md:197-217`. | Use the minimization order: fixed input, entity classes, workload/batch boundary, topology, cargo distribution, then elapsed-tick timing. Stop or reorder only when measured evidence names a different axis. |
| Behavior was fixed while mechanism remained unexplained | **[empirical, process, 2026-07-11]** The durable fixture passed while the workload-dependent restore mechanism remained explicitly `UNEXPLAINED` (`NOTEBOOK.md:407-428`; `docs/superpowers/plans/2026-07-08-empirical-test-backlog.md:120-126`). | `ALREADY LAW`: `CLAUDE.md:217` says an eliminated failure whose root cause was not isolated is `UNEXPLAINED`, not fixed. | Add separate `Behavior status` and `Mechanism status` fields to future incident/lab templates. Do not add another prose rule. |
| Two final passes caught the recurrence and later proved the correction | **[empirical, process, 2026-07-11]** The natural capture occurred in the second full-suite pass (`NOTEBOOK.md:394-400`). After correction, two complete suites passed `21/21`; each contained five deterministic belt replays (`NOTEBOOK.md:430-436`). | `ALREADY LAW`: integration-probe rule 8 at `CLAUDE.md:194-195`. | Preserve the existing rule. Clarify in briefs that final passes are part of anomaly adjudication and can invalidate a focused-fishing conclusion. |
| Local `main` was stale relative to `origin/main` | **[empirical, process, 2026-07-11]** Audit-time commands produced local `main=b07d11dc4f4d7aa0e2fafd3a02fa2202b354ebd8` and `origin/main=f803292a0901d637c6e4bf9ebbfd0e675bf51848`; `git merge-base origin/main HEAD` returned `f803292`. Commands: `git show -s --format="%H %s" main`, the same for `origin/main`, `git merge-base origin/main HEAD`, and `git diff --stat origin/main...HEAD`. | `NEW`: no tracked pre-PR scope command currently enforces a fresh remote base. | Add a read-only pre-PR scope script that fetches `origin`, reports both refs and the diff, and fails when `origin/main` is not an ancestor of `HEAD`. |
| One-shot briefs repeat standing discipline | **[empirical, process, 2026-07-11]** Repeated blocks appear in `2026-07-10-cheap-fixtures-agent-brief.md:7`, `2026-07-10-lab-tail-agent-brief.md:57-59`, `2026-07-10-pr-3-executor-brief.md:152-154`, `2026-07-11-hardening-campaign-plan.md:6-8`, and `2026-07-11-post-gate-campaign-roadmap.md:4-7`. The tracked canonical rules already live in `CLAUDE.md:138-194`, `:197-223`, and `:630-634`. This checkout does not track an `AGENTS.md` file; external agent instructions mirror parts of `CLAUDE.md` but are not a repository citation. | `STRENGTHENS` single-source discipline; it must not duplicate the underlying rules. | Add one canonical execution-discipline document that links to existing law. Require newly added or modified one-shot briefs to link to it; preserve completed historical briefs as evidence. |
| Ground-item runner can census a discarded destination without verdict adjudication | **[hypothesis, process]** Static half confirmed: the runner treats debug-result file existence as completion at `tests/integration/ground-item-fidelity/run-tests.ps1:98-100`, then calls the destination census at `:105` without reading or branching on `validation_success`. The shipped Black-Box Discard contract deletes a failed destination (`docs/ENGINEERING_FAQ.md:117-123`). A controlled runtime reproduction has not yet been banked. | Proposed `STRENGTHENS lint:test-grounding`, contingent on runtime reproduction. | Arm the existing item-loss hook in a controlled run. Promote only if the result file exists, reports `validation_success=false`, the destination is discarded, and the current runner reaches its census path. Then require verdict adjudication before destination physical reads. |
| Lockfile churn during non-dependency work | **[hypothesis, process]** The execution transcript records repeated restoration of `package-lock.json`, but no committed process ledger or isolated reproduction currently proves which command changed it. The policy itself is repeated in multiple briefs, including `2026-07-10-cheap-fixtures-agent-brief.md:7` and `2026-07-10-pr-3-executor-brief.md:153`. | No rule delta until reproduction/adjudication. | Reproduce with pre/post blob hashes around each suspected command. If confirmed, consider a PR-gated lockfile-scope guard that permits only an explicitly labeled dependency commit touching both package files. |
| PowerShell fallback editing introduced literal line-break escapes | **[hypothesis, process]** The execution transcript records restricted-token `apply_patch` failure followed by a PowerShell replacement that wrote literal `` `r`n `` text. No durable process artifact or isolated reproduction exists. | No rule delta until reproduction/adjudication. | Reproduce against a disposable file with byte hashes and line-ending inspection. If confirmed, bank the safe editing pattern or add a checked helper; do not infer a repository-wide rule from the transcript alone. |

## Existing-law map

The accepted lessons must modify these existing locations rather than creating parallel law:

- Integration iteration and two-pass evidence: `CLAUDE.md:164-195`.
- Empirical lab discipline and honest `UNEXPLAINED`: `CLAUDE.md:197-217`.
- Commit labels and post-merge watch: `CLAUDE.md:220-223`.
- Data-integrity grounding guard: `docker/seed-data/external_plugins/surface_export/scripts/lint-test-grounding.mjs`.
- Evidence-claim citation guard: `docker/seed-data/external_plugins/surface_export/scripts/lint-evidence-claims.mjs`.

## Proposed post-audit sequence

These are candidates only; the second-source audit decides which proceed.

1. **W1 - canonical discipline and process ledger:** one linked standing-discipline source, append-only process
   evidence, and link enforcement for new/modified briefs.
2. **W2 - scope and lockfile mechanics:** pre-PR remote-base report; lockfile guard only if the transcript claim
   is independently reproduced or the owner adopts it as policy enforcement regardless of incident proof.
3. **W3 - verdict-aware fidelity harness:** controlled runtime reproduction first, then shared success assertion,
   affected-runner migration, and `lint:test-grounding` ordering teeth.

No W1-W3 implementation is authorized by this packet. Stop here for audit.
