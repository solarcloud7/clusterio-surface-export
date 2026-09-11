# Serial verification

Run from the canonical checkout with root dependencies, PowerShell 7 and Docker available.
Lint uses the existing build-plugin runner and its Linux dependency cache; it does not
replace dependencies in the checkout with a Windows npm installation.
The default command runs the offline tooling tests and the repository's lint suite:

```powershell
npm run verify
```

To check an existing packaged runtime before creating worlds:

```powershell
node tools/verify-workflow.mjs --runtime ci-artifacts/production-runtime-6/runtime.json
```

Use the actual candidate's runtime manifest path. The example refers to a previously
accepted local build; the tool does not select a candidate automatically. In PowerShell
use the direct Node command for options: the npm wrapper can consume option separators.

The command holds the existing workflow lock across all stages and refuses another
owner. Child commands inherit ownership. Tests run first, followed by an optional build,
native CLI preflight, then explicitly requested live acceptance. A failure stops later stages.

To build first, pass `--build-config build.json` instead of `--runtime`. The JSON file
contains the existing build-runtime inputs: `artifact`, `commit`, `version`, `gateway`,
`gatewaySha256`, and a new `output` directory. Paths in that file resolve from the
repository root. The builder verifies package acceptance and hashes; nothing is published.

Add `--acceptance --client-volume EXISTING_LICENSED_CLIENT_VOLUME` for the existing
disposable production-profile test: fresh worlds, physical cargo, recovery, recreation
and labelled cleanup. It does not touch the development cluster. The preflight itself
has networking disabled and creates only temporary state in disposable containers as
the runtime user. It checks all five hardening fields in a final batch read, raw string output,
the pinned Clusterio version and exact Surface Export plugin discovery. Remote config
lists use a separate JSON parser; missing, duplicate or malformed fields fail.

Add `--startup` to exercise the packaged entrypoints before full acceptance. It uses a
disposable controller and two hosts without Factorio worlds or a licensed client. It
checks first boot, restart with changed hardening settings, missing host configuration,
malformed stored tokens and mismatched stored tokens. Setup mutations are read back before
restart. Independent cases are paired across the hosts in two restart cycles. Each cycle
waits for the controller to observe both hosts disconnected before
restarting them, then checks connectivity and hardening. These observations do not identify
which internal token-reset branch executed. The test cleans up its labelled resources.

```powershell
node tools/verify-workflow.mjs --runtime ci-artifacts/production-runtime-6/runtime.json --startup
```

Results are under `ci-artifacts/verify-*/result.json`. Command evidence is JSONL with
separate stdout/stderr tails, elapsed time, exit status and explicit truncation flags.
Arguments, stdin and environment options are omitted. Docker inspection retains only
IDs, running/exit state and mount counts. Each evidence file is capped at 4 MiB; a
retention record counts discarded older commands. Known secret fields and JWTs are
redacted before retaining tails. This filtering cannot recognize every possible secret:
keep evidence private and inspect it before sharing. Failed or buffer-limited commands
cannot be reported as successful measurements.

The shared disposable Docker lab uses the same command collector, including successful
stderr. Its existing bounded container-log collection remains available. Offline analyzers
still consume recorded reports; changing an analyzer alone does not require another game
run. This command runs requested stages afresh and never treats an old report as proof
for changed code.

Read a compact status without rerunning verification:

```powershell
npm run verify:status
node tools/verification-status.mjs --pr 312 --pr 313
node tools/verification-status.mjs --offline --report ci-artifacts/verify-RUN/result.json
```

The default queries the current branch's PR and reads the newest local verification
report, including an incomplete or failed run. `--report` selects an exact report;
`--runtime` selects a candidate manifest; `--json` emits structured output. GitHub or
report-read failures are unavailable, with exit code 2. Status is informational and is
not a merge gate. Skipped-only or absent CI checks do not count as passing. GitHub Actions
runs are also queried for the exact PR head, using the latest run per workflow; old checks
cannot hide a missing workflow run after a stacked-branch update.

New verification reports capture the checkout commit and a digest of tracked and
nonignored untracked file contents before and after execution. Candidate records identify
the packaged plugin commit separately from the checkout and include image IDs and the
manifest digest. Staged build inputs must match the build identities, and the image recipe
must match the checkout. Changes invalidate the corresponding input comparison. Ignored
dependencies, Docker state and machine configuration are outside the source digest.
Historical reports without these identities remain historical evidence.

Acceptance reports record local monotonic start, end and elapsed milliseconds for startup,
world creation/assets, normal transfer, fault setup, recovery, controller recreation,
retained history, browser checks and cleanup. These are inclusive elapsed intervals.
An interrupted stage can retain a start without an end; unstarted stages have no duration.
The parent report links the child report while it runs and when the acceptance command
fails. Cleanup still runs if writing timing evidence fails, and the verification fails.

For code-review findings, keep a private JSON checklist beside the run artifacts and pass
it with `--findings`. Evidence paths resolve relative to that checklist:

```json
{
  "schemaVersion": 1,
  "findings": [
    { "id": "PR-1", "summary": "Reported failure", "status": "open", "evidence": [] }
  ]
}
```

Statuses are `open`, `reproduced`, `fixed`, `verified`, or `not reproduced`. The last two
require evidence links. The summary labels these as declared dispositions and reports
missing files; it does not perform an independent code review or verify claims by a file's
existence. Keep reproduction, fix and verification links with the same finding rather than
creating separate run-report documents.
