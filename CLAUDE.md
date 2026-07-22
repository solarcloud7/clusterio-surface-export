# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with the clusterio-surface-export project.

## clusterio-surface-export Project Overview

This project provides tools for exporting and importing Factorio Space Age platforms between Clusterio instances. It consists of:

1. **Lua Module** (`docker/seed-data/external_plugins/surface_export/module/`): Save-patched Lua code that serializes/deserializes platform entities, inventories, fluids, and tiles
2. **Clusterio Plugin** (`docker/seed-data/external_plugins/surface_export/`): TypeScript plugin for cross-instance platform transfer
3. **PowerShell Tools** (`tools/`): Helper scripts for deployment, import, export, and validation

**Key Features**:
- Complete platform state export/import (entities, inventories, fluids, tiles)
- Async processing to prevent game freezing
- Graceful handling of mod content mismatches
- Factorio 2.0 compatibility (handles read-only properties)
- Chunked RCON protocol for large payloads (100 KB chunks — `RCON_CHUNK_SIZE` in `helpers.ts`)
- In-game transaction dashboard with persistent profiler snapshots
- Platform schedule + interrupts preserved (stations, wait conditions, train group inheritance)
- Ghost entities, tile ghosts, and item request proxies preserved

**Performance**: Small platforms (<8KB): ~1-2s | Large platforms (235KB): ~40s (RCON bottleneck)

**Current Cluster Configuration:**
- Uses pre-built images from `ghcr.io/solarcloud7/clusterio-docker-controller` and `ghcr.io/solarcloud7/clusterio-docker-host`
- Controller: `clusterio-controller` (Web UI: http://localhost:8080)
- Host 1: `clusterio-host-1` → Instance: `clusterio-host-1-instance-1` (ports 34100-34109)
- Host 2: `clusterio-host-2` → Instance: `clusterio-host-2-instance-1` (ports 34200-34209)
- Runtime data in Docker volumes (not bind-mounted directories)
- `factorio-client` external volume on host-1 (shared with clusterio-docker project, persists across `down -v`)
- Host-2 uses `SKIP_CLIENT=true` (no game client needed)
- Seed data convention from [solarcloud7/clusterio-docker](https://github.com/solarcloud7/clusterio-docker)
- **Seeding is idempotent**: Fixed in base image — `seed-instances.sh` checks if instance exists before creating, controller writes `.seed-complete` marker, hosts detect token desync. `docker compose restart` is safe; `docker compose down -v` for full wipe.

**Base Image Capabilities** (from `solarcloud7/clusterio-docker`):
- **Factorio download hardening**: SHA256 verification (optional), `--retry 8` on curl, `SHELL ["/bin/bash", "-eo", "pipefail", "-c"]`
- **Game client support**: Two paths available:
  - **Runtime download** (recommended): Set `FACTORIO_USERNAME` + `FACTORIO_TOKEN` env vars — host downloads the client on first startup into the `factorio-client` external volume. Persists across restarts and `docker compose down -v`.
  - **Build-time bake**: `INSTALL_FACTORIO_CLIENT=true` build arg downloads during `docker build`. Credentials appear in `docker history` — only for private images.
  - The game client enables Clusterio's export-data flow for graphical asset export (icon spritesheets). Only host-1 needs it; host-2 uses `SKIP_CLIENT=true`.
- **External factorio-client volume**: Declared as `external: true` in docker-compose.yml. Must be created once with `docker volume create factorio-client`. Shared across projects (clusterio-docker and FactorioSurfaceExport use the same volume).
- **Port range auto-derivation**: Host N → port range `34N00-34N99` (no manual port config needed)
- **Mod seeding before instances**: Mods are uploaded to controller before instances are created/started
- **External plugins must be read-write**: Mount without `:ro` — entrypoint runs `npm install` inside each plugin

## RCON Commands (PowerShell Profile Aliases)

**CRITICAL (interactive humans)**: These aliases are defined in the user's PowerShell profile. Always use them instead of raw docker commands.

**CRITICAL (AI agents / non-interactive shells)**: `rc11`/`rc21`/`rclist` are **interactive-profile-only** and are **NOT available** in the non-interactive shell an agent runs in — calling them errors with `rc11: The term 'rc11' is not recognized`. Use the raw form instead (PowerShell does not MSYS-mangle the path, so prefer it over Git Bash):
```powershell
# rc11 "<cmd>"  ≡
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance send-rcon "clusterio-host-1-instance-1" "<cmd>"'
# rc21 "<cmd>" → swap to "clusterio-host-2-instance-1"
```
A reusable wrapper lives in `tools/rcon.ps1` (see "Development Tools"). When you see `rc11 "X"` below, mentally expand it to the raw form above.

### Core RCON Aliases
```powershell
rc <host> <instance> "<command>"   # Send RCON command to any instance
rc11 "<command>"                   # Shortcut: Host 1, Instance 1
rc21 "<command>"                   # Shortcut: Host 2, Instance 1
rclist                             # List all instances + validate mod loaded
```

### Raw Docker RCON (avoid when aliases available)
```powershell
docker exec surface-export-controller npx clusterioctl --log-level error instance send-rcon "clusterio-host-1-instance-1" "/list-platforms"
```

## Development Tools

### Primary Deployment Script
```powershell
./tools/deploy-cluster.ps1                 # Full deployment: increment version, pull images, start cluster
./tools/deploy-cluster.ps1 -SkipIncrement  # Deploy without version bump
./tools/deploy-cluster.ps1 -SkipIncrement -KeepData  # Restart without wiping volumes
```

### Hot Reload Development (Recommended)

The plugin uses **TypeScript** with bind-mounted source and **save patching** for Lua:
- Plugin location: `docker/seed-data/external_plugins/surface_export/`
- Mounted into containers via `external_plugins/` volume (auto-installed by base image)
- Contains TypeScript plugin code (`*.ts`), React web UI (`web/`), and Lua `module/` directory
- Build output: `dist/node/` (Node.js runtime), `dist/web/` (browser bundle)

**Plugin Changes** (TypeScript):
- Edit `*.ts` files in plugin root or `lib/` → `./tools/build-plugin.ps1 node -RestartHosts` (rebuild + reload the hosts)
- Build generates `dist/node/*.js` from TypeScript sources
- Deploy script automatically rebuilds before Docker startup
- Host Node (24.x, matching CI) is available in shells — but **do not** `npm install`/`npm run build` in the live plugin dir while the cluster runs (see the next bullet: it re-adds the `@clusterio` peers and breaks `clusterioctl`; the cluster also strips them, so an in-place build can't resolve `@clusterio` anyway). Use **`./tools/build-plugin.ps1 [all|node|web] [-RestartController] [-RestartHosts]`** — it builds in an isolated `node:24` container (CI parity) with a named volume shadowing `node_modules`, writing `dist/` back to the host; pass `-RestartController` for web changes (the controller caches each plugin's `manifest.json` at startup), or `-RestartHosts` for node changes (the hosts load `dist/node` at startup). Quick node-only compile alternative: `docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npx tsc -p tsconfig.node.json'` then `docker restart surface-export-host-1 surface-export-host-2`.
- **DO NOT** run `npm install`/`npm install --include=dev`/`npm prune` in the plugin dir on a running cluster: the plugin lists `@clusterio/*` as **peer+dev** deps and npm 7+ auto-installs peers, so a second copy of `@clusterio/lib` lands in the shared (bind-mounted) `node_modules` and breaks `clusterioctl` with `Error: Attempt to import duplicate copy of @clusterio/lib`. The base-image entrypoint avoids this by deleting them after install (log line "Removing local @clusterio packages"). **Recover with** `docker exec surface-export-host-1 sh -c 'rm -rf /clusterio/external_plugins/surface_export/node_modules/@clusterio'` (NOT `npm prune` — that re-adds the peers). To lint/build locally, install only the tool you need (`npm install --no-save eslint typescript-eslint`) then remove `@clusterio` again. CI is unaffected — it runs `npm ci` in a clean runner.

**Web UI Changes** (React):
- Edit `*.tsx`/`*.css` files in `web/` → `./tools/build-plugin.ps1 web -RestartController` → reload browser (chunks are content-hashed, so a normal reload suffices — no hard-refresh)
- Build generates `dist/web/` bundle via Webpack Module Federation
- Deploy script automatically rebuilds before Docker startup

**Module Changes** (Lua - Save Patched):
- Edit `*.lua` files in `module/` directory → `./tools/patch-and-reset.ps1` (rebuilds the plugin, resets saves so Clusterio re-patches the Lua, restarts the cluster)
- Clusterio automatically injects Lua code into saves at startup
- No compile step for Lua itself — but the save MUST be reset (a plain restart reuses the old patched `script.dat`); `patch-and-reset.ps1` does that for you

**Development Workflow**:
1. Start cluster: `docker compose up -d`
2. Edit TypeScript files → `./tools/build-plugin.ps1 node -RestartHosts`
3. Edit web (`*.tsx`) files → `./tools/build-plugin.ps1 web -RestartController` → reload browser
4. Edit Lua files → `./tools/patch-and-reset.ps1` (rebuild + reset saves to re-patch Lua + restart)
5. **Or use deploy script** for full rebuild: `.\tools\deploy-cluster.ps1 -SkipIncrement`

### Cluster / transfer / RCON tools (`tools/`)

> Run `ls tools/` for the full set — this list is the agent-relevant subset. The `rc11`/`rc21`
> profile aliases do NOT work in a non-interactive (agent/CI) shell; use `tools/rcon.ps1` instead.

```powershell
# RCON (agent-friendly; replaces the rc11/rc21 profile aliases):
./tools/rcon.ps1 11 "/list-platforms"            # host-1/instance-1   (21 = host-2)

# Find what happened (plugin errors, transfer traces) — reads the JSON logs docker logs hides:
./tools/check-cluster-logs.ps1                   # or -Grep "sendRequest|validation|fail"

# Transfer a platform between instances (then prints post-transfer state):
./tools/transfer-platform.ps1 -PlatformIndex <idx> -Direction 2to1   # or 1to2

# Run the WHOLE integration suite (auto-discovers tests/integration/*/run-tests.{ps1,mjs}; cluster must be
# UP). One source of truth — also the single CI step. Node spawns pwsh per .ps1 test (macOS: brew install
# powershell). Filter with --only <regex>; dry-run with --list.
node tools/run-integration-tests.mjs                 # or:  --only 'gateway' / --skip 'fidelity' / --list

# Status / listing:
./tools/show-cluster-status.ps1
./tools/list-platforms.ps1
. ./tools/cluster-utils.ps1                       # dot-source for Send-RCON / Get-InstanceList

# Import an export file: use the web UI "Import JSON" (Manual Transfer / Exports tab) or the in-game
# /plugin-import-file <file> <name> command — both chunk automatically. There is no CLI import script.
```

**Skills** (invoke with `/<name>`): `/cluster-logs` (find logs / trace a failure) and
`/repro-transfer` (reproduce a transfer end-to-end locally). Prefer local repro over CI logs.

### Testing discipline

The canonical test taxonomy, baked-fixture lifecycle, measurement boundary, and promotion policy are in
[docs/testing.md](docs/testing.md) (the Physical Truth Lab Standard + the fidelity-measurement model + the
hands-on E2E checklist, one doc); repository test layout and entry points are in
[tests/README.md](tests/README.md). Current facts:

- **`tests/integration/`** holds live regressions for established production contracts; run with
  `node tools/run-integration-tests.mjs` (cluster must be up). The one-test-save consolidation is tracked in
  [tests/integration/MIGRATION.md](tests/integration/MIGRATION.md): most roundtrip tests are absorbed as pad
  fixtures on the live gallery save (`tests/lab-gallery/`), where a missing pad reports a RED `MISSING`
  verdict — never a vacuous pass.
- **Baked-fixture batches** follow the lifecycle in the standard: consume each certified fixture once through
  the real production path, no cleanup between fixtures, reload the paired golden saves
  (`docker/seed-data/lab-saves/`) in an unconditional batch finalizer.
- **The standing lab suite was removed 2026-07-19** (owner ruling; runners archived at git tag
  `labs-archive-2026-07-19`). Engine re-certification is a calculated campaign at version-update time: restore
  runners from the archive tag (or author fresh probes), re-measure every law production depends on, record the
  evidence commits in `tests/labs-certified.json`, and bump the pin — all in the bump PR.
  `npm run lint:version-certification` keeps the pin and the certificate equal; between pin bumps, the pads +
  integration suite are the standing coverage.
- **Ad-hoc probes that mutate the shared cluster** still owe zero-leftover cleanup (surfaces AND persistent
  `storage.*` records, game unpaused) and must scope every predicate to `surface-export-*` containers — the
  unrelated `atlas-*` cluster shares this machine.
- **Working hygiene:** run `./tools/check-pr-scope.ps1` before editing and again before opening a PR; commit
  the real change before deliberately reverting/mutating it for a regression-teeth check (so the implementation
  cannot be lost during teeth testing); leave `package-lock.json` byte-identical outside approved dependency
  updates.

**Evidence discipline** (mechanized by `lint:evidence-claims` and `lint:version-certification`):
engine-behavior knowledge carries evidence tags in [docs/factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md)
— **[API]** / **[empirical, <pin>]** / **[hypothesis]**. A mechanism EXPLANATION is [hypothesis] until its
*predictions* are tested — a behavioral rule can be [empirical] while its explanation is lore, and an
unverifiable source ("expert analysis" of closed-source internals) must NEVER be cited as "Confirmed by."
Rung IDs cited in code and docs (fluid-lab R11, inserter-lab B6, …) point at evidence commits reachable via the
archive tag. Record negative and unexplained results honestly — an eliminated failure whose root cause was never
isolated is UNEXPLAINED, not fixed.

**Two audit-boundary rules:**
- **Commit labels are audit boundaries.** A `docs:` commit must never carry code (CI-enforced by
  `scripts/lint-commit-labels.mjs`).
- **A merge isn't done until main's own post-merge run is green.** PR runs get watched; push runs don't —
  watch the post-merge run, every time.

## Clusterio Core Development

This repo runs **published** `@clusterio/* 2.0.0-alpha.25` from the baked images. To change Clusterio core
itself (lib/host/controller/ctl): the canonical fork checkout is the SIBLING `../clusterio` (fork-based pnpm
workflow, never an in-repo checkout). The two test loops (native pnpm dev env vs full-cluster Docker override
via `./tools/rebuild-clusterio.ps1`) and the promotion paths are in
[docs/clusterio-core-dev.md](docs/clusterio-core-dev.md).

## Project File Structure

Plugin root: `docker/seed-data/external_plugins/surface_export/` (`module/` = save-patched Lua,
`lib/` = TS modules, `web/` = React UI, `scripts/` = lint guards, `dist/` = gitignored build output).
Helper scripts: run `ls tools/`. Cluster definition: `docker-compose.yml` (+ `docker-compose.clusterio-src.yml`
opt-in fork override); all environment config in gitignored `.env`.

### Build Architecture

- **Language**: TypeScript 5.5.4 (strict mode) for plugin code, Lua 5.2 for Factorio module
- **Runtime entrypoints**: `index.ts` declares `instanceEntrypoint: "dist/node/instance"`, etc.
- **Build pipeline**: `npm run build` compiles TypeScript → `dist/node/*.js` and bundles React → `dist/web/*`
- **Clean source tree**: Only `.ts` and `.jsx` files in source directories; all generated artifacts in `dist/`
- **Deploy integration**: `deploy-cluster.ps1` runs `npm run build` before Docker compose up
- **Git hygiene**: `dist/` is gitignored; fresh builds ensure consistency
- **Tests**: `npm test` (gated in CI) builds `dist/node` then runs the message round-trip harness
  (`test/messages.roundtrip.test.cjs`, built-in `node --test`, zero deps). It self-discovers every
  message class in `messages.ts` and, per class, asserts the static wire contract
  (`plugin/type/src/dst/jsonSchema/fromJSON`), a stable `toJSON`→`fromJSON` round-trip, and that
  `toJSON` fields agree with `jsonSchema` (catches the field-drift / "Unregistered Event class" /
  serialization-break classes of bug that otherwise only surface at runtime). A new message is
  covered automatically — no edits to the harness needed. Run it in the `@clusterio`-stripped host
  container (it only needs `dist/node`): `docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npm test'`.

## Key Technical Constraints

### RCON Throughput Limits
- **Factorio throttles RCON**: ~100 bytes/tick = ~6 KB/s
- **Chunking**: payloads split at `RCON_CHUNK_SIZE = 100000` bytes per command (`helpers.ts:11`), processed async; the old "~8KB max / 4KB chunks" figures were stale — the binding constraints are throughput and the >50-char command-reorder caveat (upstream writing-plugins.md)

### Async Processing Model
- Import/Export use batched async processing (~100 entities/tick)
- Jobs queued via `AsyncProcessor.queue_import()` / `queue_export()`
- Progress tracked in `storage.async_jobs`
- Results stored in `storage.async_job_results`

### Remote Interface (`surface_export`)
```lua
-- Key remote interface functions (call via /sc remote.call(...))
-- Export:
remote.call("surface_export", "export_platform", platform_index, force_name, destination_instance_id)
remote.call("surface_export", "export_platform_to_file", platform_index, force_name, filename)
remote.call("surface_export", "get_export", export_id)
remote.call("surface_export", "get_export_json", export_id)  -- JSON string for RCON
remote.call("surface_export", "list_exports")
remote.call("surface_export", "list_exports_json")  -- JSON string for RCON
remote.call("surface_export", "clear_old_exports", max_to_keep)

-- Import (chunked RCON — Factorio 2.0 removed runtime file reading):
remote.call("surface_export", "import_platform_chunk", platform_name, chunk_data, chunk_num, total_chunks, force_name)

-- Platform locking (transfer workflow):
remote.call("surface_export", "lock_platform_for_transfer", platform_index, force_name)
remote.call("surface_export", "unlock_platform", platform_index_or_name)  -- unique index preferred; name still accepted (resolved internally, fail-loud on ambiguity)

-- Validation:
remote.call("surface_export", "get_validation_result", platform_name)
-- Transfer verdicts are carried in the import-complete event and controller transaction log;
-- do not refetch them by mutable platform name.

-- Configuration:
remote.call("surface_export", "configure", config_table)

-- Debug/testing:
-- NOTE: clone_platform takes the source platform's UNIQUE per-force index + a dest name (2 args).
-- Source is keyed on the index, not a name: platform names can collide (see /list-platforms for the index).
remote.call("surface_export", "clone_platform", source_index, dest_name)
remote.call("surface_export", "test_import_entity", entity_json, surface_index, position)
remote.call("surface_export", "run_tests")
```

### In-Game Commands

Full list: [docs/commands-reference.md](docs/commands-reference.md).

### Passenger handling on transfer (evacuate, don't block)
A transfer is **NOT** blocked when players are aboard. A player on a platform is hub-locked in remote view
(no inventory — only equipped gear, no ammo). When the platform transfers, everyone aboard **and** abandoned
character bodies are **EVACUATED to Nauvis** at the SOLE source-delete chokepoint
(`delete_platform_for_transfer` → `Gateway.evacuate_passengers`, in `module/core/gateway.lua`) BEFORE the
surface is torn down — never orphaned, never duplicated (native-aligned with how the engine returns a player
to a planet on hub-loss). This replaced an earlier passenger hard-block. Carrying the player **with** the
platform to the destination (`connect_to_server` + `enter_space_platform`) is a future Layer-2 feature gated on
a reachability spike. Covered by `tests/integration/passenger-evacuate`; design in
[docs/GATEWAY_TRANSFER_PRD.md](docs/GATEWAY_TRANSFER_PRD.md).

## Export/Import Workflow Notes (Current)

### Export for download
- UI path: Manual Transfer per-platform **Export JSON** and Exports tab download action.
- Controller path: `ExportPlatformForDownloadRequest` sends `ExportPlatformRequest` with `targetInstanceId: null`.
- Instance/Lua path: destination must be Lua `nil` for export-only; otherwise export is treated as transfer.
- Export-only jobs unlock the source platform after completion; transfer jobs keep source locked until cleanup.

### Upload-import JSON
- UI path: Manual Transfer per-instance **Import JSON** and Exports tab upload/import action.
- Controller path: `ImportUploadedExportRequest` forwards payload via `ImportPlatformRequest` to target instance.
- Controller injects `_operationId` into payload; Lua emits completion with `operation_id`.
- Instance forwards `ImportOperationCompleteEvent` to controller so non-transfer imports can complete their transaction logs.

### Space Hub schedule export source (CRITICAL)
- Always read schedule data from `hub_entity.platform`, not from hub entity fields.
- Use `platform.get_schedule()` and serialize both `schedule.stations` and `schedule.interrupts`.
- Include interrupt trigger details, wait conditions, and inherited train-group references.
- This prevents partial exports where stations appear but interrupts are lost.

### Transaction logs
- Logs now include operation type: `transfer`, `export`, `import`.
- `TransactionLogsTab` shows mixed operation history in one list with operation type tags.
- Export/import operations are persisted using the same transaction log store as transfers.

### In-game transaction dashboard
- **Command**: `/transaction-dashboard [limit]` opens GUI (default 25 entries, max 500)
- **Features**: Scrollable history table, color-coded by operation type, detail popups with phase timing
- **Persistence**: Uses LocalisédString profiler snapshots stored in `storage.transaction_history`
- **Phase timing**: Displays per-phase LuaProfiler values that survive save/load
- **Implementation**: Three-part system:
  1. `utils/transaction-history.lua` — Snapshot storage (converts profilers to LocalisedStrings)
  2. `interfaces/gui/transaction-dashboard.lua` — GUI rendering (assigns snapshots to labels)
  3. `core/import-completion.lua` + `core/export-pipeline.lua` — History recording hooks
- **Admin features**: Clear history button, adjustable row limits (10/25/50/100)
- **See**: Pitfall #24 for LocalisedString profiler serialization requirements

## Common Pitfalls (index)

Full corpus — mechanism, fix, evidence, key files per entry — in [docs/pitfalls.md](docs/pitfalls.md);
registry (slug, status, guard) in [docs/pitfalls.json](docs/pitfalls.json); consistency enforced by
`npm run lint:doc-refs`. Cite as "Pitfall #N, short name". Numbers are frozen aliases (#8 retired —
never renumber). Statuses: unmarked = active law; *(historical)* = fixed, lesson recorded;
*(revision-queued)* = partially refuted, revision adjudicated.

| # | Slug | Rule | Guard |
|---|------|------|-------|
| 1 | `empty-rcon-response` | Empty rc11 reply (or 'not recognized' in agent shells) = instance down or mod unloaded; check cluster status + logs, use tools/rcon.ps1 | — |
| 2 | `import-chunking-required` | Large imports must go through a chunking path (web UI Import JSON or /plugin-import-file) — a single RCON command silently truncates | — |
| 3 | `version-mismatch-after-deploy` | Old code after deploy = deploy-cluster.ps1 didn't finish or containers didn't restart | — |
| 4 | `storage-not-global` | Factorio 2.0 renamed global to storage; never write global.* | `lint:lua` |
| 5 | `platform-index-per-force` | Platform indices are per-force and 1-based; find them with /list-platforms | — |
| 6 | `readonly-entity-properties` | Factorio 2.0 made many entity properties read-only; set them at create_entity time, pcall optional ones | — |
| 7 | `unknown-items-graceful-skip` | Mod-mismatch imports skip unknown items with logged warnings, never crash | — |
| 9 | `idempotent-seeding` | Fixed in base image: seeding is idempotent, docker compose restart is safe; down -v only for a full wipe *(historical)* | — |
| 10 | `default-mod-pack` | Set DEFAULT_MOD_PACK=Space Age 2.0 in .env; mod pack binds on first seed only (needs down -v to change) | — |
| 11 | `port-range-auto-derived` | Fixed in base image: host N auto-derives ports 34N00-34N99; compose mappings must match *(historical)* | — |
| 12 | `clusterio-api-require-path` | require("modules/clusterio/api") — never __clusterio_lib__ (not a mod; save-patched under modules/) | `lint:lua` |
| 13 | `debug-mode-lost-on-save-reset` | debug_mode lives in the save; on_init defaults it true for FRESH saves only — patch-and-reset or configure() to re-enable | — |
| 14 | `instance2-minimal-seed` | Host-2's seed save has a platform stub with no physical hub — it is the import target, not an export source | — |
| 15 | `validate-before-activation` | The gate counts BEFORE any elapsed tick after activation — active machines craft in the gap and fake GAINS; activation only after the verdict | `gate-item-loss` pad (pad-transfer-suite) |
| 16 | `atomic-belt-scan` | Belts keep moving (active-writes rejected): belt items must be extracted in ONE atomic tick, verification built from that consistent serialized data | — |
| 17 | `pre-activation-fluid-loss` | An old pipeline lost ~15% fluids pre-activation (class never isolated); fluid-lab R11 measured the CURRENT path exact in the frozen world — do not cite this as proof restoration needs a live world *(historical)* | — |
| 18 | `crafter-handlers-export-fluids` | A specific entity handler must export fluids too if the type has a fluidbox (the default handler does; a partial handler silently drops fluid) | — |
| 19 | `platform-destroy-noop` | Remove platforms via GameUtils.delete_platform (game.delete_surface) — argless platform.destroy() silently no-ops at 2.0.77 | `lint:lua` |
| 20 | `failed-entity-loss-attribution` | When create_entity fails, tally the entity's items/fluids into failed_entity_losses and subtract from expected — otherwise validation blames a phantom loss | — |
| 21 | `fusion-plasma-exclusion` | Plasma is excluded from transfer by prototype connection-category; the write-rejection law did NOT reproduce at 2.0.77 (fluid-lab R14) — revision is the queued shared-accessor /di-change *(revision-queued)* | — |
| 22 | `fluidbox-segment-id-nil` | Most activatables return nil from get_fluid_segment_id — read fluidbox[i] directly or fluids silently drop; EXCEPTION: fusion reactor's own boxes DO expose segment IDs | — |
| 23 | `fluid-temperature-merge` | Segment merges are volume-weighted and exact (R12); prototype max-temp clamps writes — the 10,000 threshold in reconcile_fluids is unlicensed by measurement | — |
| 24 | `profiler-localisedstring-snapshots` | LuaProfiler cannot serialize; persist timing by embedding profilers in LocalisedStrings at job completion, keep live profilers OUT of storage, display-only | — |
| 25 | `localisedstring-20-param-limit` | One LocalisedString over 20 parameters hard-crashes the instance — split multi-value prints into one line per call | — |
| 26 | `call-link-methods-bound` | Never extract/cast a Link method (handle, sendTo, ...) to a value — this loses, crashes at runtime; cast the arguments, never the method | `lint:js (unbound-method + no-restricted-syntax)` |
| 27 | `icons-need-export-data` | Blank ? icons = mod pack has no export-data; needs the graphical client on host-1 (never SKIP_CLIENT there), FACTORIO_CLIENT_TAG in lockstep with the instance version, regenerate via clusterioctl instance export-data | — |
| 28 | `gate-counts-complete-state` | The pre-activation gate must measure a COMPLETE frozen world — held items seated by the single pre-gate owner pass; fix the timing, never the number | `gate-item-loss` pad (pad-transfer-suite) |
| 29 | `dest-force-research-held-capacity` | Inserter hand capacity = the DESTINATION force's research bonuses; Phase-0 raise-only force sync replicates source bonuses before any entity is created | `force-bonus-held` pad (pad-transfer-suite) |
| 30 | `test-hooks-fail-safe-on-leak` | A state-mutating test_force_* hook must be pre-gate, disarmed in finally/trap, or non-destructive — a leaked post-gate hook is silent data loss on the NEXT transfer | `lint:test-hooks` |
| 31 | `identity-is-surface-index` | platform.name is mutable and collidable — every lock/delete/transfer identity decision keys on surface.index or the unique per-force index; name resolves only at the tooling boundary, loud on ambiguity | `lint:lua (no-name-as-transfer-identity)` |
| 32 | `export-only-destination-nil` | Number(null)===0 and 0 is Lua-truthy: only a positive integer targetInstanceId is a transfer destination; anything else passes Lua nil or the source stays locked | — |
## Architecture Overview

For Clusterio core architecture, see [Clusterio docs](https://github.com/clusterio/clusterio).

### Factorio Integration (Lua)

- Custom module system using event_handler library
- Save patching to inject Clusterio code at runtime
- RCON protocol for server communication
- JSON serialization for data exchange
- Lua modules located in `/packages/host/modules/` and `/packages/host/lua/`
- **Clusterio API path**: Always `require("modules/clusterio/api")` for save-patched modules (Pitfall #12, the Clusterio API require path)
- **Clusterio send_json event channel (Lua→Node)**: `clusterio_api.send_json("channel_name", data_table)` — plugin listens via `server.handle("channel_name", handler)`
- **RCON transport (Node→Lua)**: `this.sendRcon("/sc ...")` to execute Lua via RCON

## Code Style and Conventions

### General Style (partially enforced by ESLint — `npm run lint`, gated in CI)

> `npm run lint` runs eleven **correctness** guards, all gated in CI; a twelfth (**commit labels**,
> `scripts/lint-commit-labels.mjs`) runs as its own PR-gated CI step. Each script header carries the full
> rationale and incident history. Every `*:allow` escape hatch MUST be enumerated in
> `scripts/lint-allow-manifest.json` with a reason and approver — an allow is an **escalation**, never
> self-approved.
>
> | Guard | Command | Rule | Allow marker |
> |-------|---------|------|--------------|
> | TS | `lint:js` (eslint) | never extract/cast a Link method — `call-link-methods-bound` (#26); no empty catch or bare `.catch(() => {})` | eslint-disable |
> | Lua invariants | `lint:lua` | no `global.*` — `storage-not-global` (#4); no `__clusterio_lib__` — `clusterio-api-require-path` (#12); no `platform.destroy()` — `platform-destroy-noop` (#19); no name-keyed transfer identity — `identity-is-surface-index` (#31) | `-- lint-lua:allow` |
> | Web cache | `lint:web-cache` | webpack output filenames stay content-hashed (immutable 1y `/static` cache serves stale chunks otherwise) | `lint-webpack-cache:allow` |
> | Test grounding | `lint:test-grounding` | fidelity/gate tests measure PHYSICALLY, never the validator self-report alone; success-path = parse `debug_import_result` + `Assert-TransferSucceeded` before census | `lint-test-grounding:allow` |
> | pcall logging | `lint:pcall-logging` | every `pcall` surfaces its error or is an annotated `-- intentional probe` | `-- pcall:allow` |
> | Catch swallow | `lint:catch-swallow` | no TS catch substitutes a default without surfacing the error binding | `// catch:allow` |
> | Test hooks | `lint:test-hooks` | a `test_force_*` hook disarms in `finally`/`trap` or is enumerated in `FAIL_SAFE_HOOKS` — `test-hooks-fail-safe-on-leak` (#30) | `FAIL_SAFE_HOOKS` entry |
> | Doc refs | `lint:doc-refs` | pitfall registry/bodies/index consistent; citations resolvable + human-readable (number + short name) | see guard header |
> | Allow manifest | `lint:allow-manifest` | manifest matches reality exactly, both directions | — |
> | Evidence claims | `lint:evidence-claims` | an empirical claim in a code comment carries its citation within ±3 lines | `lint-evidence-claims:allow` |
> | Version certification | `lint:version-certification` | pinned Factorio version == `tests/labs-certified.json`; a pin bump goes red until the re-certification campaign lands | none — recertify |
> | Commit labels | (own CI step) | a `docs:`-labeled commit touches only doc paths — labels are audit boundaries | — |
>
> Discipline the guards cannot fully mechanize: ship the adversarial fixture WITH the fix, and run
> `/di-change` (or `/code-review`) before merging any gate/validation/rollback/source-delete/test-hook change.
>
> The cosmetic conventions below (indentation, quotes, naming) are **conventions, not yet all machine-enforced** — match the surrounding code.

- **Indentation**: Tabs (not spaces, except in Markdown)
- **Line length**: 120 characters (tabs count as 4)
- **Strings**: Double quotes `"` (single quotes `'` if string contains double quotes)
- **Naming (JavaScript)**:
  - Variables/members: camelCase
  - Classes: PascalCase
  - Config values: lowercase_underscore
  - Booleans: Start with verb unless ending in "ed" (e.g., `canRestart`, `isEnabled`, `connected`)
  - Times/durations: End with SI unit (e.g., `updatedAtMs`, `timeoutS`)
- **Naming (Lua)**: Everything uses lowercase_underscore
- **File naming**:
  - lowercase_underscore for files exporting multiple values
  - PascalCase for single-class exports

## Plugin Development

Plugins are the primary extension mechanism. See [Clusterio plugin docs](https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md) for comprehensive guide.

**Plugin Structure**:
- Separate entrypoints: controller, host, instance, ctl, web
- Each entrypoint implements lifecycle hooks (onStart, onStop, etc.)
- Plugins define custom Request/Event messages
- Config fields integrate into main config system
- Web modules use Module Federation for runtime loading

## Known Factorio API Limitations (Transfer Fidelity)

Transfers require **100% of restorable items and fluids** at the frozen-world exact gate. The durable Factorio 2.0 API facts behind
this — fluid segments, the fluidbox proxy/capacity behavior, segment-ID dedup, fusion-reactor output,
inventory resize/override, the epsilon rule — live in
[factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md). Read that before touching fluid or inventory
restoration.

Project invariants that still bite if changed:
- **Beacon-before-crafter inventory order.** `crafting_speed` (which sets the `set_stack()` cap) only
  reflects beacon bonuses once the beacon's `beacon_modules` inventory is populated, so Phase 3 restores
  beacons first, then everything else. See [Import Phase Ordering](#import-phase-ordering-critical).
- **Belt restoration truth lives in ONE place**: the "Belt transport-line laws (CANONICAL)" section of
  [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md) — recreated 2026-07-17 after a fact-regression
  incident; do not restate belt physics elsewhere, point there. Summary only: the fidelity unit is one
  continuous belt lane/side (`(name, quality, stack count)` multiset; position/order/window are NOT
  invariants). The root cause of the historical belt restore loss class is the `insert_at` write-frame
  offset (= one tick of `belt_speed`, tier-parametric — BELT-R10); side-scoped reverse first-fit with the
  `belt_speed` k-floor reconstructs exactly, including filtered-splitter purity (BELT-R11/R12, committed
  runners; production adoption pending the DUP-233855 kill-measurement). Engine transport-line identity is
  still NOT a cross-import key (BELT-R9); populated-source same-execution `line_equals` grouping IS the
  side partition. The current production path (captured positions + oversized-stack consolidation + hub
  recovery) remains the shipped implementation until Phase 5 lands. The atomic single-tick export scan
  remains required (Pitfall #16, atomic belt scan; belts keep moving — BELT-R13).
- **Fluid restoration runs in the frozen world (`disabled_by_script`) before the exact gate.** The payload
  carries a top-level **fluid-segment registry** (one record per source segment or segmentless storage, keyed
  by our incremental id — engine segment ids differ across instances); entities reference it via
  `specific_data.fluidboxes`. Restore writes each segment **once** via `set_fluid_segment_fluid` (segmentless
  storages via `set_fluid`). Plasma rides like any fluid — the `engine_owned` connection-category
  classification is **deleted** (owner ruling 2026-07-20/21). A member whose entity failed to place is simply
  absent: there is **no failed-member fluid accounting**, so a short segment fails the exact gate and the
  two-phase commit preserves the source (fail => revert). The ONLY lawful fluid subtraction from expected
  counts is `write_rejected` (a physical post-write measurement, not a category prediction); capacity overflow
  (`dropped_fluids`) remains a gate failure. One pre-activation verdict covers exact items and aggregate-by-name
  fluids (`epsilon=1e-6`). See docs/factorio-2.0-api-notes.md fluid section.
- **Entity inventory size** isn't changed by `LuaInventory.resize` (custom inventories only).
  `LuaEntity.set_inventory_size_override` overrides **container** sizes but is a **no-op for crafter inputs**
  at 2.0.76 (verified) — so it is *not* a lever for overloaded-crafter-input loss (already handled by the
  beacon-first ordering). See the API notes.

### Import Phase Ordering (Critical)
The order of post-processing steps in `complete_import_job()` is critical for correctness:

```
1. Hub inventories        — restore after cargo bays exist (inventory size scales with bays)
2. Belt items             — belts keep moving (active-writes rejected, BELT-R13); single-tick restore is
                            the current conservative implementation (see the canonical belt section)
3. Entity state           — control behavior, filters, circuit connections
4. Beacon activation      — activate beacons so crafting_speed bonus propagates instantly
5. Inventories (2 passes) — Pass 1: beacons (populates beacon_modules, crafting_speed updates immediately)
                            Pass 2: everything else (set_stack cap now reflects beacon-boosted cs)
6. Held-item completion   — inserter-only synchronous pass (single owner of held seating; activation-independent, inserter-lab B6); no tick advances
7. Fluid restoration      — write the payload's fluid-segment registry (one set_fluid_segment_fluid per
                            segment; segmentless storages via set_fluid) while the platform stays paused and
                            entities disabled_by_script; plasma rides like any fluid, no engine-owned subtraction
8. Exact validation       — one immutable verdict: exact items + by-name fluids
9. Activation             — only after the verdict passes; then gateway park if requested
10. Loss analysis         — post-activation reporting under `postActivationReport`; never changes verdict
```

**Why this order matters**:
- Step 4 (beacon activation): beacons are kept active during entity creation (never deactivated). Phase 2 explicitly activates them and fills their energy buffer. This is necessary but not sufficient — beacons need their **module inventory populated** before `crafting_speed` reflects the beacon bonus.
- Step 5 (inventories, 2 passes): The two-pass approach is critical. `crafting_speed` on a machine updates **immediately** when its nearby beacon's `beacon_modules` inventory is populated — no tick delay, no power required. Pass 1 populates all beacon modules. Pass 2 then restores crafter inputs with `set_stack()`, which uses the now-correct beacon-boosted cap (e.g. cs=17.375 → 12 slots instead of cs=2.5 → 7 slots). Machines remain deactivated throughout — they cannot consume items.
- Steps 6→8 are one synchronous frozen-world completion and verdict pass. Fluids are restored from the payload's fluid-segment registry (one `set_fluid_segment_fluid` write per segment) into the paused, `disabled_by_script` destination before the gate; there is no failed-member fluid accounting, so any missing member fails the exact gate and the source is preserved (fail => revert). A failure banks an always-on black box, then discards the destination unless the debug-gated preserve flag is explicitly armed. The historical ~15% pre-activation loss is retired (Pitfall #17, historical pre-activation fluid loss); the pad-transfer-suite workhorse census and strict gate exercise this ordering on 2.1.11.

## Factorio 2.0 Fluid API & Simulation Behavior

Moved to [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md) — the fluid-segment model, the
fluidbox proxy/capacity behavior, segment-ID dedup, the floating-point epsilon rule, and the
inject-after-activation requirement. Read it before touching fluid scanning or restoration.

## Additional Documentation

- [docs/README.md](docs/README.md) - Plugin overview and documentation index
- [docs/commands-reference.md](docs/commands-reference.md) - All available commands
- [docs/QUICK_START.md](docs/QUICK_START.md) - End-to-end transfer walkthrough
- [docs/CI_CD.md](docs/CI_CD.md) - CI pipeline, Factorio-baking for integration tests, and debugging failed runs
- [docs/TRANSFER_2PC.md](docs/TRANSFER_2PC.md) - Transfer durability, identity, and two-phase-commit design + current state
- [docs/EXPORT_IMPORT_FLOW.md](docs/EXPORT_IMPORT_FLOW.md) - Complete action trace: sequence diagrams, phases, message names, debugging
- [docs/async-processing.md](docs/async-processing.md) - Async batch processing architecture
- [docs/factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md) - Verified Factorio 2.0 API & fluid-simulation facts

## Debugging Tips

### Docker Logs (IMPORTANT — Windows Shell Escaping)

**CRITICAL**: On Windows with Git Bash, `docker exec` path arguments get mangled by MSYS path conversion (e.g., `/clusterio/` → `C:/Program Files/Git/clusterio/`). Always wrap commands in `sh -c '...'` with single quotes:

```bash
# WRONG (Git Bash mangles the path):
docker exec surface-export-controller npx clusterioctl --config=/clusterio/tokens/config-control.json ...

# CORRECT (single-quoted sh -c prevents path mangling):
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json ...'
```

**RCON command (always use sh -c with single quotes):**
```bash
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error instance send-rcon "clusterio-host-1-instance-1" "/list-platforms"'
```

### Observability — WHERE EACH LOG ACTUALLY LIVES (read this before debugging)

**The #1 gotcha that wastes hours**: a plugin's `this.logger.info(...)` output (controller AND instance/host plugins) does **NOT** reliably appear in `docker logs`. `docker logs surface-export-host-1 | grep surface_export` returns **nothing** — the host plugin's own logs are not on host stdout. Clusterio routes them to **log files on disk** instead. Look in the files, not (only) `docker logs`.

| What you want | Where it actually is | How to read it |
|---|---|---|
| **Everything, aggregated** (controller + every host + every instance plugin `this.logger`) | Controller: `/clusterio/logs/cluster/cluster-YYYY-MM-DD.log` (JSON lines, date-rotated) | `docker exec surface-export-controller sh -c 'cat /clusterio/logs/cluster/cluster-*.log' \| grep -aoE '"message":"[^"]*"'` |
| **One host's plugin logs** (instance `this.logger.info/error`) | Host: `/clusterio/logs/host/host-YYYY-MM-DD.log` (JSON lines) | `docker exec surface-export-host-1 sh -c 'cat /clusterio/logs/host/host-*.log' \| grep -aoE '"message":"[^"]*"' \| grep -i transfer` |
| **Controller-origin plugin logs only** | `docker logs surface-export-controller` stdout (controller `this.logger` DOES appear here; host/instance logs do NOT) | `docker logs --tail 300 surface-export-controller 2>&1 \| grep surface_export` |
| **Factorio engine + Lua `log(...)` / `[Script]`** | Host: `/clusterio/data/instances/<instance>/factorio-current.log` (also mirrored into the host/cluster JSON logs as `"level":"server"`) | `docker exec surface-export-host-1 sh -c 'tail -200 /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log'` |
| **Debug dumps** (`debug_source_*`, `debug_destination_*`, `debug_import_result_*`) | Host: `/clusterio/data/instances/<instance>/script-output/` (only when `debug_mode` on) | `docker exec surface-export-host-2 sh -c 'ls /clusterio/data/instances/clusterio-host-2-instance-1/script-output/debug_import_result_*.json'` |

The JSON log shape is `{"instance_id":…,"instance_name":…,"level":"info|error|server","message":"…","plugin":"surface_export","timestamp":"…"}`. Filter a single plugin with `grep '"plugin":"surface_export"'`. The `cluster-*.log` file is the single best place to trace a cross-instance transfer end-to-end (it has the host-1 export, the controller routing, AND the host-2 import in one stream).

**Prometheus metrics are LIVE**: the `statistics_exporter` plugin exposes `http://localhost:8080/metrics` on the controller (process + cluster metrics, ~45 KB). **Custom surface_export transfer metrics are now implemented** — `lib/metrics.ts` defines collectors that register to Clusterio's default registry (so they surface on the same `/metrics` with no extra wiring) and `recordOperationOutcome()` is called from `SubscriptionManager.emitTransferUpdate` (the universal terminal chokepoint, idempotent per operation):
- `surface_export_operations_total{operation,result,failure_stage}` — counter; `operation` ∈ transfer/export/import, `result` ∈ success/failure/cleanup_failed, `failure_stage` ∈ items/fluids/none
- `surface_export_operation_duration_seconds{operation,result,failure_stage}` — histogram (buckets 0.5s…300s)
- `surface_export_entities_transferred_total{operation}` — counter (entities placed on the destination)
- `surface_export_export_stall_seconds` — histogram; the source-side async export span (the tick-stall window that can heartbeat-drop a connected player)

These complement, not replace, the JSON-file logs above — metrics tell you *that* transfers are failing and how long they take; the `cluster-*.log` files tell you *why*. Scrape with `docker exec surface-export-controller sh -c 'curl -s http://localhost:8080/metrics | grep ^surface_export_'`.

**Note**: `--tail N` goes BEFORE the container name. After a container restart, `docker logs` loses pre-restart output — but the on-disk `/clusterio/logs/*` files persist across restarts (until date-rotation), so prefer the files for any post-restart investigation.

### Check Plugin Module is Loaded
```powershell
rc11 "/sc rcon.print(remote.interfaces['surface_export'] ~= nil)"  -- Should print 'true'
```

### View Factorio Log (from container)
```bash
docker exec surface-export-host-1 sh -c 'tail -100 /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log'
```

### Check Async Job Queue
```powershell
rc11 "/sc rcon.print(serpent.block(storage.async_jobs or {}))"
```

### List Available Remote Interfaces
```powershell
rc11 "/sc for name, _ in pairs(remote.interfaces) do rcon.print(name) end"
```

## Shared Clusterio knowledge (cross-repo)

- **Skill**: a user-level `clusterio-ops` skill (`C:\Users\Solar\.claude\skills\clusterio-ops\`)
  carries the Clusterio knowledge shared by this repo and FactorioMap — the @clusterio singleton
  rule, git-bash path mangling (incl. `--config=/...` → "Missing URL and/or token"), the
  controller-hello boot race, RCON/save-patching mechanics, and this machine's multi-cluster port
  map. Load it when operating or debugging any cluster.
- **Singleton problem, structural fix**: FactorioMap solved the shared "@clusterio in plugin
  node_modules breaks clusterioctl" problem structurally instead of by hand-recovery — the
  `@clusterio` devDeps live in a repo-root `package.json` (host tsc resolves them via the upward
  walk; the repo root is never bind-mounted) plus a plugin-level `.npmrc` with
  `legacy-peer-deps=true` so npm 7+ never auto-installs the peers back. See
  `FactorioMap/docs/lessons-learned.md` § "Wave C". Worth adopting here as a complement to the
  isolated `tools/build-plugin.ps1` container build.
- **Multi-cluster coexistence**: this cluster (controller :8080, game 34100–34209) shares the
  machine with the atlas cluster (controller :8090, game host-port 34300 → container 34100;
  containers prefixed `atlas-`). The authoritative port/coexistence map lives in
  `FactorioMap/docs/RUNBOOK.md` — never stop/restart another cluster's containers.
