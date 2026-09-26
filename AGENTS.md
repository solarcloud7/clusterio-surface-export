# Repository instructions for agents

## Workspace and scope

- Shared project skills live in `.agents/skills/`. Maintain them there; `.claude/`
  is ignored local configuration and state, not a second source of skill instructions.
- Work on branches in the canonical checkout. Do not create worktrees, secondary
  clones or repositories, or replace mounted directories with junctions/symlinks.
- This checkout is a live development bind-mount source. Check `git status` and
  coordinate ownership before branch changes, runtime builds, deployment or restarts.
  Subagents must not switch the shared branch.
- Scope operations to this deployment's resolved containers/volumes. Never modify
  another cluster or assume an external volume belongs to this one.
- Preserve existing saves, player state and original failure artifacts. Use
  disposable Docker fixtures for destructive acceptance.
- Keep unrelated changes and credentials out of commits. Leave lockfiles unchanged
  outside authorized dependency updates. Use `tools/check-pr-scope.ps1` before
  editing and before preparing a PR. It compares with the open PR's base; pass
  `-Base <branch>` for stacked work that has no PR yet.

## Build and deployment

The maintained procedures are [development workflow](docs/developers/workflow.md)
and [setup](docs/developers/setup.md). Human readers do not need this file.

- Use `tools/clusterio/build-plugin.ps1` for build/lint/test containers. For checks,
  specify an output directory under `ci-artifacts` so compilation does not replace
  the running plugin. Do not install/prune packages in the live plugin mount.
- Use `tools/clusterio/deploy.ps1` for development deployment. Lua/plugin scopes
  preserve saves by default; cluster scope preserves volumes. Only `-ResetSaves`
  and `-ResetData` select destructive resets. These switches require explicit
  authorization for disposable state.
- Matching Node, web and Lua changes need corresponding reloads. Check loaded
  versions and relevant behavior before describing source edits as deployed.
- Respect `ci-artifacts/workflow.lock`. After a crash, verify the owner process
  has stopped before removing that specific lock.
- Use `tools/clusterio/rcon.ps1`; personal shell aliases are not prerequisites.
- The development containers are `surface-export-*`; `atlas-*` is an unrelated
  cluster (controller port 8090, game port 34300). Resolve container names and
  volume ownership before acting. Hostnames are not Docker container names.
- The development `external_plugins` mount must be writable: the base entrypoint
  installs dependencies there. Pin an immutable image revision (`.rN` in current
  images), not `latest` or a bare version that can move on rebuild.
- Prefer PowerShell for Docker commands. Git Bash/MSYS can rewrite Linux paths;
  use a quoted `sh -c` command when that shell is unavoidable.
- Web publication preserves old hashed assets for cached controller manifests.
  Package acceptance uses `tools/release/stage-package.mjs` to include only the
  current manifest's assets. Do not prune the live asset directory during builds.

## Browser credentials and guarded tools

For automated login, run `node tools/clusterio/serve-admin-token.mjs`. It prints
a single-use, expiring loopback URL, not the token. Use the supported browser
automation workflow to consume it directly into the login state; never return
the response body, credentials or localStorage contents to a tool transcript.
Verify authenticated state or token length only. Do not bypass browser tool
restrictions. `get-admin-token.ps1` prints the token and is for a human pasting
into the login form, not an agent's captured shell output.

| Tool | Requires | Produces | Does not |
|---|---|---|---|
| `node tools/surface-export/probe-transfer.mjs --fixture 21 [--lua "<preparation>"] [--keep]` | Running test cluster and named fixture | Clone transfer, validation and cleanup observations | Authorize modifying the original fixture or prove every platform |
| `node tools/clusterio/ctl.mjs [--cluster dev\|<name>] [--write] <clusterioctl args>` | Development controller container; for a remote cluster, its entry in the ignored `tools/clusterio/remote-clusters.local.json` | clusterioctl output from that controller; read-only commands unless `--write` | Print tokens, authorize a change on a shared or production cluster, or bypass controller permissions |
| `node tools/surface-export/player-state.mjs --player <name> [--cluster dev\|<name>] [--out <file>]` and `--diff <before> <after>` | Reachable cluster with running instances | One player's body, gear, grids, platform and passenger/arrival records per instance; item totals and conservation verdict | Read an offline player's body, change state, or prove where unreadable items went |
| `node tools/tests/testkit/cli.mjs mutation --file <path> --find "<text>" --replace "<text>" [--baseline]` | Committed clean canonical source; eligible non-Lua file | Test verdict and restored source | Authorize mutating a live guard; use isolated execution or test doubles for those |
| `pwsh -File tools/tests/measure-rig.ps1 -Action run -PluginPath <isolated-package>` | Built package outside the live plugin mount, Docker | Disposable `sx-measure-*` observations and teardown | Measure the deployed development cluster |
| `node tools/clusterio/tick-liveness.mjs` | Reachable configured cluster | External tick samples and liveness classification | Measure client FPS or isolate a stall's cause |
| `pwsh -File tools/tests/cleanup-test-surfaces.ps1 -DryRun` | Resolved test-cluster scope | Planned test-surface cleanup | Authorize bypassing transfer protections; inspect before a mutating run |
| `pwsh -File tools/shared/rebase-stacked.ps1 -OldBaseTip <sha> [-Push]` | Clean canonical branch and known former base tip | Rebased stack and optional push | Resolve conflicts or authorize a merge |
| `node tools/tests/testkit/cli.mjs inspect`, `log`, `check --live` | Arguments shown by the selected subcommand; cluster for live queries | Payload/query-path evidence | Prove restoration from a field's presence; an invalid query is not an absent field. Live checks can export fixtures |

Use `git config core.hooksPath .githooks` when setting up this checkout's hooks.
The commit-msg hook refuses agent session links and attribution. The post-commit
hook incrementally updates an existing graph; inspect
`graphify-out/update.log` if it fails. The graph is a navigation aid, not evidence
of current runtime behavior. Never use `|| fallback` for branch operations.

## Evidence and data integrity

Apply [.agents/skills/di-change/SKILL.md](.agents/skills/di-change/SKILL.md) to cargo,
identity, ownership, validation, deletion, recovery or mutating fault-hook changes.
Ordinary prose and unrelated UI/tooling changes do not require its full live ladder.

- Reproduce the symptom before implementing a speculative diagnosis. Inspect the
  full response/state family, including missing, late, duplicate and ambiguous replies.
- Look up Factorio API members at the pin. The testkit API lookup checks availability;
  valid API shape does not prove a reconstruction algorithm. Check Factorio runtime
  capabilities before introducing third-party Lua dependencies.
- Compare physical source/destination cargo and fixture state independently. The
  validator is not its own oracle. Do not subtract loss from expectations or weaken
  an assertion to match the result.
- Preserve canonical operations and persistent platform identity. Names and local
  indexes alone do not authorize deletion, unlock or replay.
- Missing/pruned status or a lost acknowledgement is uncertainty, not permission to
  import again. Keep active/unresolved ownership through queue waits and restarts.
- Belts can move between callbacks. Verify boundaries before splitting capture,
  restoration or validation. Selected entity disabling is not a frozen world.
- Measure milliseconds on local clocks. Exact ticks describe scheduling; do not
  convert them into stall time or align unrelated process clocks.
- Keep controls, original failures, raw measurements and fixture/version scope.
  Distinguish unit simulation, engine observation, deployment and published artifacts.
  An unexplained improvement is not a proven root-cause fix.
- Mutating probes own cleanup of temporary surfaces and persistent state. Missing
  fixtures, failed injection, invalid API calls and cleanup failures are not passes.
  Do not clear protections to force cleanup.
- Never mutate production guards in a live mounted runtime. Commit the actual fix
  before mutation checks and use isolated execution or in-memory test doubles.
- Read hub schedules and interrupts from `hub_entity.platform` through
  `module/utils/platform-schedule.lua`. The hub entity is not the schedule owner.
- Preserve beacon pre-placement and beacon inventory restoration before crafters.
  Import completion orders hub, belts, state, inventories and held items before
  fluids. Fluids, the final cargo gate and activation share one callback.
- An unexpected import exception is not permission to replay or release the source
  guard. Match recovery actions to their operation and saved platform identity.
- `remote.call("surface_export", "unlock_platform", index, nil, expected_job_id)` requires the owning job
  for a transfer lock. The legacy jobless lock helper is not a matching test setup.
  Use `tests/lab-gallery/fixture-cleanup.mjs` for guarded fixture cleanup; refused
  unlocks must remain visible as cleanup failures.

## Documentation and style

- Human documentation belongs in `docs/users`, `docs/admins`, `docs/developers`
  and `docs/technical`. Maintain it when requested. Add no unsolicited planning
  pages, audit ledgers or incident narration. Experiments stay beside their tests;
  agent instructions stay outside `docs`.
- Do not recreate the retired API-notes/certification system or evidence-tier tags.
  Upstream sources and measured artifacts support claims; another internal document
  or a tag alone does not. Add no documentation-parsing tests.
- Code comments are restricted to machine-read markers and directives. Put requested
  educational explanations in human documentation.
- Match surrounding style: tabs, double-quoted JS strings, camelCase JS members,
  PascalCase classes and lowercase_underscore Lua names. Use explicit duration units.
- Preserve error evidence and run applicable guards. Each `*:allow` exception needs
  its manifest entry, reason and approver. Do not self-approve exceptions.
- Keep Clusterio Link methods bound and avoid a second installed `@clusterio/lib`
  within the same runtime process.
- No causal claim without a measurement that isolates the variable, an authoritative
  citation, or the words "cause not isolated". Run a control arm before claiming an
  improvement. Unverifiable closed-source explanations are expert analysis, never
  "Confirmed by" evidence.
- Give tools `requires:`, `produces:` and `does not:` metadata. Explain findings to
  the owner in chat, not commit-message essays. New or expanded documentation is
  by request only; otherwise suggest it and wait for the owner's decision.

## Review and delivery

- Report checks actually run, skips and unavailable evidence. Later changes
  invalidate affected results; old reports do not certify new source bytes.
- Use independent review where required by the data-integrity skill. Self-review
  or green CI is not independent review.
- Keep findings, fixes and verification together in private run evidence. No
  permanent planning/report document is required.
- Use `gh --body-file` for multiline PR bodies. Omit session links and attribution.
- Do not merge, publish releases or post review comments without applicable user
  authorization. Verify checks at the current head after stacked-branch updates.
- After an authorized merge, inspect `main`'s own post-merge checks.

## Repository map

The plugin lives in `docker/seed-data/external_plugins/surface_export/`; its
`module/` directory is save-patched Lua. Gateway prototypes/artwork live in
`docker/seed-data/mods-src/surfexp_gateways/`. Maintained helpers live in
`tools/clusterio`, `tools/surface-export`, `tools/tests` and `tools/shared`.
See [diagnostics](docs/developers/diagnostics.md) and [test selection](docs/developers/testing.md).
