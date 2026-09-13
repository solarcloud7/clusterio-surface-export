# Repository instructions for agents

## Workspace and scope

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
  editing and before preparing a PR.

## Build and deployment

The maintained procedures are [development workflow](docs/developers/workflow.md)
and [setup](docs/developers/setup.md). Human readers do not need this file.

- Use `tools/clusterio/build-plugin.ps1` for build/lint/test containers. For checks,
  specify an output directory under `ci-artifacts` so compilation does not replace
  the running plugin. Do not install/prune packages in the live plugin mount.
- Use `tools/clusterio/deploy.ps1` for development deployment. Lua/plugin scopes
  reset saves without `-KeepSaves`; cluster scope destroys volumes without
  `-KeepData`. These defaults do not authorize deletion.
- Matching Node, web and Lua changes need corresponding reloads. Check loaded
  versions and relevant behavior before describing source edits as deployed.
- Respect `ci-artifacts/workflow.lock`. After a crash, verify the owner process
  has stopped before removing that specific lock.
- Use `tools/clusterio/rcon.ps1`; personal shell aliases are not prerequisites.

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
