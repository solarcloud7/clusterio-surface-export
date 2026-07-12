# Agent execution discipline

This checklist is the canonical orientation and close-out surface for execution briefs.
It points to the governing rules in [CLAUDE.md](../CLAUDE.md) instead of copying their incident history or detailed requirements.
A task-specific brief may add stricter requirements, but it must not weaken these rules.

## Before work

- Confirm the branch and fetched comparison base before editing; record any stale-base discrepancy in the [process notebook](superpowers/process/NOTEBOOK.md).
- Use [`tools/rcon.ps1`](../CLAUDE.md#cluster--transfer--rcon-tools-tools) from non-interactive shells; profile aliases such as `rc11` are unavailable to agents.
- Confirm ownership before touching the shared cluster and scope every predicate to `surface-export-*`; never inspect or alter `atlas-*`.
- Leave `package-lock.json` byte-identical unless the task is an explicitly approved dependency update.
- Treat every new data-integrity lint allow as an escalation requiring owner approval and the checked-in manifest entry described in [Code Style and Conventions](../CLAUDE.md#code-style-and-conventions).

## During work

- Build expensive integration probes in sections and iterate only the failing section, following the [integration-probe iteration discipline](../CLAUDE.md#integration-probe-iteration-discipline-shared-live-cluster--read-before-debugging-testsintegration).
- Commit the real change before deliberately reverting or mutating it for a regression-tooth check, so the implementation cannot be lost during teeth testing.
- Use the cheapest fixture that proves the invariant, derive totals from measurements, and preserve independent physical grounding.
- Clean every state layer in `finally` and prove zero leftovers on both instances before releasing the cluster.
- Record material execution anomalies and workarounds in the [append-only process notebook](superpowers/process/NOTEBOOK.md); routine command output does not belong there.

## Before review

- Keep commit labels honest audit boundaries; a `docs:` commit contains documentation only, as required by the [audit-boundary rules](../CLAUDE.md#empirical-lab-discipline-how-engine-lore-becomes-law--exemplar-testsfluid-lab).
- Re-run the task's focused verification and the required full verification on the final committed tree.
- A passing integration claim requires two consecutive full green runs plus zero-leftover evidence, reported once, under [integration-probe rule 8](../CLAUDE.md#integration-probe-iteration-discipline-shared-live-cluster--read-before-debugging-testsintegration).
- Stop at the brief's audit boundary; do not self-merge or silently broaden scope.

## After merge

- Watch `main`'s own post-merge run through completion.
- A merge is not finished until that run is green; investigate and report any red result before starting dependent work.
