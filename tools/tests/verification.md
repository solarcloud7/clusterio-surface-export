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
