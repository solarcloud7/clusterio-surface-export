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

### Integration-probe iteration discipline (shared live cluster — read BEFORE debugging tests/integration)

The cluster is a shared, stateful, EXPENSIVE test target (platform clone ≈60–90s async; docker restart ≈30–60s;
other work may be in flight). The default agent failure mode is re-running a full multi-minute probe to debug one
tail check — turning a 30-second fix into a 6-minute cycle that also churns cluster state. Rules (each was paid
for in a real incident — the destination-hold probe audit):

These rules govern probes that dynamically mutate the shared cluster. Certified single-use baked-fixture batches
follow the lifecycle in [the Physical Truth Lab Standard](docs/lab-tests.md): they do not clean between fixtures
and reload the paired golden saves at the batch boundary. Cleanup-specific tests and non-baked shared-cluster
probes retain the zero-leftover obligations below.

1. **Build probes in sections; iterate on sections.** Any `run-tests.ps1` using more than one expensive resource
   MUST take a section-selection param (e.g. `-Sections main,restart,ttl`). Debug loops run ONLY the failing
   section; the full unsegmented run is reserved for final evidence passes.
2. **Cheapest fixture that proves the invariant.** A check that doesn't measure content uses a bare
   `force.create_space_platform{...}` + `apply_starter_pack()` (instant) — NOT a clone of the 1359-entity test
   platform. Clone only where fidelity is physically measured.
3. **Never docker-restart per debug iteration.** Restart-durability sections run in final passes only. After any
   restart, POLL for RCON readiness (deadline loop) — never a fixed sleep (a 30s sleep is a race you will lose).
4. **Derive counts; never hardcode totals.** Summary math comes from actual recorded results (a hardcoded
   `$total` overreported a phantom pass). Treat a new harness like production code: regression-test its
   accounting before trusting its summary.
5. **Clean up EVERY state layer, then assert zero leftovers.** Surfaces AND persistent Lua storage records
   (`storage.destination_holds`, `storage.locked_platforms`, …) — a `finally` that deletes surfaces but strands
   storage records leaks landmines into the shared cluster. Post-run: assert both empty and the game unpaused.
6. **Scope every predicate to THIS cluster.** Only `surface-export-*` containers / this instance's own RCON
   stream. `atlas-*` (a second, unrelated cluster on this machine) must never appear in a probe's input — if its
   text shows up, find the cross-wire; do not widen the regex around it.
7. **Assert measured behavior, not desired architecture.** When a probe exists to answer an unknown, the
   assertion records the MEASURED fact (labelled a hazard if undesired); changing the behavior is a separate,
   adjudicated design decision.
8. **A "passed" claim requires two consecutive full green runs + zero-leftover evidence, reported ONCE at the
   end.** No live-narration of running passes; no trusting a single lucky green.

### Empirical lab discipline (how engine lore becomes law — exemplar: `tests/fluid-lab/`)

The canonical test taxonomy, baked-fixture contract, measurement boundary, and promotion path are defined in
[the Physical Truth Lab Standard](docs/lab-tests.md). The evidence rules in this section remain mandatory.

Engine-behavior knowledge carries evidence tags in [docs/factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md):
**[API]** / **[empirical, <pin>]** / **[hypothesis]**. A mechanism EXPLANATION is [hypothesis] until its
*predictions* are tested — a behavioral rule can be [empirical] while its explanation is lore, and an
unverifiable source ("expert analysis" of closed-source internals) must NEVER be cited as "Confirmed by."
(Paid for: Pitfall #17's ghost-buffer mechanism survived 4 months as law; the fluid-lab refuted it in hours and
prevented two unnecessary primitive redesigns.)

**A lab rung is MANDATORY when:** (a) a design decision rests on engine behavior not tagged
`[empirical, <current pin>]`; (b) CI and local disagree on a physical measurement; (c) a mechanism explanation
cites uninspectable internals; (d) the engine pin bumps — **re-run every `tests/*-lab/` runner** (the labs are
the version-drift re-certification suite).

**The pattern** (belt-lab → inserter-lab → fluid-lab → hold-completeness-lab → no-tick-sync-lab lineage): append-only NOTEBOOK; a rung ladder isolating ONE
variable per rung; controls first (trust the instrument before the experiment); every reading tick-stamped and
carrying ALL meters + paused flags; a TRIED-&-SETTLED do-not-repeat ledger; inherited LAB HAZARDS (the on_tick
clobber, `platform.destroy` no-op, recipe-enable + write-assert); `--reset` + zero-leftover proof; untracked
until a conclusion is worth committing — then commit the RUNNERS with the conclusions and promote facts to
api-notes WITH tags. Record negative and unexplained results honestly (an eliminated failure whose root cause
was never isolated is UNEXPLAINED, not fixed — never retcon green into understood).

**Two audit-boundary rules (each paid for in a real incident):**
- **Commit labels are audit boundaries.** A `docs:` commit must never carry code — reviewers allocate attention
  by label, and a mislabeled rider evaded two review passes before fresh eyes caught the defect it contained.
- **A merge isn't done until main's own post-merge run is green.** PR runs get watched; push runs don't — main
  once sat red for 12+ hours because nobody looked. Watch the post-merge run, every time.

## Clusterio Core Development

This repo is a **plugin + dev cluster**; the dev cluster runs **published** `@clusterio/* 2.0.0-alpha.25`
baked into the `ghcr.io/solarcloud7/clusterio-docker-*` images. When you need to change **Clusterio core
itself** (lib/host/controller/ctl), here is where that work lives and how to test it with `surface_export`.

### Home: the sibling fork checkout `../clusterio`
All Clusterio core development lives in the **canonical fork** at `C:\Users\Solar\source\clusterio`
(`origin` = your fork `solarcloud7/clusterio`, `upstream` = `clusterio/clusterio`) — a **sibling** of this
repo, NOT an in-repo checkout (the old `FactorioSurfaceExport/clusterio` was retired; the `/clusterio/`
.gitignore line is a guard so it can't be re-committed). Clusterio uses a **fork-based, pnpm** workflow
(see its `docs/contributing.md`):
- `git fetch upstream` (never `git pull upstream`) → branch off `upstream/master` → push to `origin` →
  PR to `clusterio/clusterio`. Update a branch by rebasing (`git rebase upstream/master`, force-push `+branch`).
- Long-lived fork-only work (e.g. `ExtendedExportData`) stays on its own fork branch.
- Add a changelog entry for user-visible changes; run `pnpm test` + `pnpm lint`.
- To touch a different branch without disturbing in-progress work, use a `git worktree` off `upstream/master`.

### Two ways to test a core change with the plugin
1. **Native pnpm dev env (recommended for *iterating* on a core feature).** Per Clusterio's contributing.md,
   in `../clusterio`: `pnpm install`, put/junction the plugin into `external_plugins/surface_export`,
   `node packages/ctl plugin add ./external_plugins/surface_export`, run `node packages/controller run` +
   `node packages/host run`, iterate with `pnpm watch`. Core edits go live immediately, with source maps.
   The upstream-blessed loop; no version-compat hacks.
2. **Full-cluster Docker override (this repo's 2-host cluster running your fork build).** `pnpm build` the
   fork, then layer `docker-compose.clusterio-src.yml` (bind-mounts each `../clusterio/packages/<pkg>/dist`
   over the image's `@clusterio/<pkg>/dist`):
   ```powershell
   ./tools/rebuild-clusterio.ps1          # pnpm build the fork + recreate the cluster on it
   # revert to the published image:  docker compose up -d --force-recreate
   ```
   **Compatibility caveat:** the fork build must be API-compatible with the plugin's pinned `@clusterio`
   version (alpha.25). Build a branch CLOSE to that release; a heavily-diverged branch may not drop in — if
   instances fail to start, use loop 1 instead. `CLUSTERIO_SRC` overrides the fork path (default `../clusterio`).

### Promoting a change
- **General fix/feature** → verify (loop 1 or 2) → upstream PR to `clusterio/clusterio`. When merged & released,
  the published `@clusterio` version advances.
- **Fork-baseline feature the cluster must persist on** → bake into the images via the **`clusterio-docker`**
  builder (`C:\Users\Solar\source\clusterio-docker`: build from the fork or publish fork packages, bump
  `CLUSTERIO_VERSION`), then bump the pinned tag in `docker-compose.yml` + the plugin `package.json`.

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

## Common Pitfalls & Solutions

> Numbering note (2026-07-08): #8 does not exist (retired); #20 (Failed Entity Loss) sits out of sequence between
> #15 and #16 for historical reasons — do not renumber it, code comments cite it; the former *second* #20
> (Export-Only Destination) was renumbered to #32. When citing a pitfall, always write number + short name
> (e.g. "Pitfall #19, platform.destroy is a no-op") so the reference survives renumbering and means something
> to a human without a lookup.

### 1. Empty RCON Response
**Symptom**: `rc11` returns nothing (or, in a non-interactive/agent shell, `rc11: not recognized` — the aliases are interactive-profile-only; use `./tools/rcon.ps1 11 "..."`)
**Cause**: Instance not running or mod not loaded
**Fix**: Run `./tools/show-cluster-status.ps1` to check status, then `./tools/check-cluster-logs.ps1` for errors

### 2. Import Fails Silently
**Symptom**: Import command returns but no platform created
**Cause**: JSON too large for a single RCON command
**Fix**: Import via the web UI **Import JSON** (Manual Transfer / Exports tab) or `/plugin-import-file <file> <name>` — both chunk automatically (the instance layer runs the chunked RCON protocol, 100 KB chunks). There is no standalone import script.

### 3. Version Mismatch After Deploy
**Symptom**: Old code still running after deploy
**Fix**: Ensure `deploy-cluster.ps1` completed successfully, check for container restart

### 4. Lua `storage` vs `global`
**Important**: Factorio 2.0 renamed `global` to `storage`. Always use `storage.` for persistent data.
**Enforced**: the Lua guard (`npm run lint:lua` → `scripts/lint-lua-invariants.mjs`, gated in CI) fails on any `global.`/`global[`/`global =` in the module tree.

### 5. Finding Platform Index
Platform indices are **per-force** and **1-based**. Use `/list-platforms` to find correct index.

### 6. Read-Only Entity Properties (Factorio 2.0)
**Symptom**: Crash with "property is read only" error
**Cause**: Factorio 2.0 made many properties read-only (quality, productivity_bonus, etc.)
**Fix**: Set properties during entity creation, not after. Use pcall for optional properties.

### 7. Unknown Items During Import
**Symptom**: Import crashes with "Unknown item name: ..." 
**Cause**: Export from modded game, importing to instance with different mods
**Expected**: v1.0.84+ gracefully skips unknown items with warnings. Check logs for what was skipped.

### 9. Duplicate Instances on Restart — FIXED IN BASE IMAGE
`docker compose restart` is safe — the base image's `seed-instances.sh` is idempotent (checks for the instance before creating, writes a `.seed-complete` marker, and reconfigures on host token desync). Use `docker compose down -v` only for a full volume wipe.

### 10. Instances Missing Space Age Mods
**Symptom**: Platforms don't exist, Space Age entities missing, game runs in base-game-only mode
**Cause**: `DEFAULT_MOD_PACK` defaults to `"Base Game 2.0"` in the base image controller entrypoint
**Fix**: Set `DEFAULT_MOD_PACK=Space Age 2.0` in `.env`. Requires `docker compose down -v` since mod pack is assigned on first run only.

### 11. Both Instances Have Same Game Port — FIXED IN BASE IMAGE
The base image's `host-entrypoint.sh` auto-derives the port range from HOST_ID (host N → `34N00-34N99`); docker-compose mappings must match. A `down -v` + image pull is needed when upgrading from an older base image.

### 12. Clusterio API Require Path (CRITICAL)
Use `require("modules/clusterio/api")` — the save-patched module path — NOT `require("__clusterio_lib__/api")`. `clusterio_lib` is not a Factorio mod (Clusterio injects its API via save-patching under `modules/`, not as a registered mod), so an `__clusterio_lib__` require or a `script.active_mods["clusterio_lib"]` guard is always nil → "Clusterio API not available - aborting".
**Enforced**: `npm run lint:lua` (gated in CI) fails on any `__clusterio_lib__` reference or `active_mods[...clusterio_lib...]` guard in the module tree.

### 13. Debug Mode Lost After Save Reset
**Symptom**: Integration tests fail with "Debug mode not enabled on source instance" after patch-and-reset
**Cause**: `debug_mode` is stored in `storage.surface_export_config`, which lives in the save file. When saves are wiped (by `patch-and-reset.ps1`), the config is gone.
**Fix**: `on_init()` in `control.lua` now defaults `debug_mode = true` for fresh saves:
```lua
storage.surface_export_config = storage.surface_export_config or { debug_mode = true }
```
If the default was added after the current save was created, you need either:
- A `patch-and-reset` (since the default only runs on `on_init`, which only fires for fresh saves)
- Or manual enable: `rc11 "/sc remote.call('surface_export', 'configure', {debug_mode = true})"`

### 14. Instance 2 "Platform Hasn't Been Built Yet"
**Symptom**: Connecting to instance 2 shows "space platform hasn't been built yet" for spikedoom08, `/list-platforms` shows 0 entities
**Cause**: Instance 2 uses a **minimal seed save** (`test2.zip`) that has a platform stub in save metadata but no physical space platform hub entity. The surface doesn't actually exist.
**Expected behavior**: Instance 2 is the **import target**. Integration tests clone from the fully-built "test" platform on host 1 (1359 entities) and transfer it to host 2. The empty spikedoom08 is not used for exports.

### 15. Entity Activation Before Validation (Historical Bug, Fixed)
**Symptom**: Transfer validation fails with "Item mismatches: iron-plate: GAINED items — expected 590, got 600"
**Cause**: `ActiveStateRestoration.restore()` was called as Phase 7 of import (before validation), which re-activated machines. In the ticks between activation and item counting, furnaces processed iron ore → iron plate, causing a net gain that triggered validation failure.
**Evidence status**: the FIX (validate pre-activation) is [empirical]. No-tick-sync LAB-B5 [empirical, 2.0.77] isolated the boundary: reactivating a mid-craft furnace and reading it again in the same Lua execution left `game.tick`, `crafting_progress`, input, and output unchanged; crafting resumed only after ticks elapsed. The ordering rule is therefore "count before an elapsed tick," not "never read after activation."
**Fix**: For **transfers only**, Phase 7 (activation) is deferred until after validation passes. Entities stay deactivated through all restoration phases and validation. Activation happens via `ActiveStateRestoration.restore()` using `frozen_states` only after `TransferValidation.validate_import()` succeeds. On failure, entities are left deactivated for investigation.
**Key files**: `async-processor.lua` (`complete_import_job` function), `active_state_restoration.lua`
**See**: [TRANSFER_WORKFLOW_GUIDE.md](docs/TRANSFER_WORKFLOW_GUIDE.md) — "Entity Lifecycle (Critical Invariant)" section

### 20. Failed Entity Loss Attribution (Fixed)
**Symptom**: Transfer validation fails or shows unexplained item/fluid losses when some entities fail to place (e.g., mod mismatch, prototype collision). Validation reports "expected 500 iron-plate, got 450" with no indication of why.
**Cause**: When `create_entity` returns nil, all downstream restoration phases skip that entity silently (they check `entity_map[id]` and move on). Items and fluids inside the failed entity are never placed, but they remain in the "expected" totals from verification data, causing false validation failures or unexplained loss.
**Fix**: At the failure site in `entity_creation.lua`, tally items (inventories, belt lines, held item) and fluids from the serialized entity data into `job.failed_entity_losses`. In `async-processor.lua`, before calling `validate_import`, deep-copy and subtract failed-entity items from expected counts so validation only compares achievable totals. Attach `failedEntityLosses` to the validation result so it flows through `send_json` to the controller and web UI. In `loss-analysis.lua`, log a full per-entity breakdown.
**Key files**: `entity_creation.lua` (tally at failure site), `async-processor.lua` (adjust expected + attach to result), `loss-analysis.lua` (report section)
**Output**: Log lines like `[Entity Creation] FAILED to create 'foundry' (type=furnace) at (12.5,4.5) — lost 50 items, 200.0 fluids` and `[Loss Analysis] 1 entities failed to place — 50 items, 200.0 fluids unrestorable`. `failedEntityLosses` field in validation result JSON sent to controller.
**See**: [docs/FAILED_ENTITY_LOSS_TRACKING.md](docs/FAILED_ENTITY_LOSS_TRACKING.md)

### 16. Verification Counts From Live Scan vs Serialized Data (CRITICAL — Fixed)
**Symptom**: Transfer validation fails with "GAINED items" across many item types (iron-plate, copper-cable, piercing-rounds-magazine, etc.). Gains are a fraction of belt item totals.
**Cause**: Export verification used `Verification.count_surface_items()` (live scan) AFTER entity scanning completed across multiple ticks. **Belts keep moving** — belt-class `active` writes are rejected by the engine (BELT-R13; even on paused platforms), so belt items cannot be frozen during a multi-tick scan. During the multi-tick export, items move between belts causing a "rolling snapshot" effect: an item on belt A captured in tick 1 may move to belt B captured in tick 5 → double-counted in serialized data. Conversely, items can move from unscanned to already-scanned belts and be missed. The net result is the serialized data doesn't match the live surface state at any single point in time.
**Evidence status**: the FIX (atomic single-tick belt scan) is [empirical] — the GAINED-items failures were reproducible and v2 eliminated them. The "rolling snapshot" mechanism is [hypothesis] (consistent with all observations, never isolated as its own rung).
**Fix (v2 — Atomic Belt Scan)**: Belt item extraction is now **deferred** during async entity scanning. Entity structure (position, direction, type, belt_to_ground_type, etc.) is still captured async per-tick, but `extract_belt_items()` is skipped (controlled by `EntityHandlers.skip_belt_items` flag). When all entities are scanned, `complete_export_job` does a single-tick atomic pass over all tracked belt entities, calling `extract_belt_items()` and patching the serialized data. This gives a consistent snapshot: no items can move between belts within a single tick. Verification is then generated from this consistent serialized data.
**Key files**: `entity-handlers.lua` (`skip_belt_items` flag on transport-belt/underground-belt/splitter handlers), `async-processor.lua` (`process_export_batch` sets flag + tracks belt entities, `complete_export_job` atomic belt scan block before verification)
**Previous approach (v1)**: Used `Verification.count_all_items()` from serialized data for verification (self-consistent but inaccurate). This masked the problem — verification matched import, but both were based on inconsistent belt data.

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

> `npm run lint` runs eleven **correctness** guards, all gated in CI:
> - **TS** — `eslint.config.js` in the plugin root (flat config, type-aware via `tsconfig.node.json`). The unbound Clusterio Link-method guard (Pitfall #26, call Link methods bound) via `@typescript-eslint/unbound-method` + a `no-restricted-syntax` selector, PLUS `no-empty` + an empty-arrow `.catch(() => {})` selector so a swallowed promise rejection can't ship silently (the TS analogue of the Lua pcall-logging guard below).
> - **Lua** — `scripts/lint-lua-invariants.mjs` (`npm run lint:lua`), a static guard over the `module/` tree for documented Factorio/Clusterio footguns we've already been bitten by: `global` persistence (Pitfall #4, storage vs global), `__clusterio_lib__` require/`active_mods` guard (#12), and `*platform*.destroy()` no-op (#19). Each rule maps to a Pitfall and was verified clean when added. Add a `-- lint-lua:allow` comment (with a reason) to suppress a verified false positive.
> - **Web cache** — `scripts/lint-webpack-cache.mjs` (`npm run lint:web-cache`), guards that `webpack.config.js` keeps its output filenames content-hashed. A fixed-name `filename`/`chunkFilename` override silently defeats `@clusterio/web_ui`'s hashed default and, with the controller's immutable 1y `/static` cache, serves returning users stale chunks (the regression that shipped in `94e1b8c`; see [docs/static-asset-caching.md](docs/static-asset-caching.md)). Add a `lint-webpack-cache:allow` comment (with a reason) to suppress a verified exception.
> - **Test grounding** — `scripts/lint-test-grounding.mjs` (`npm run lint:test-grounding`), guards that integration tests measure fidelity **independently of the code under test**: a `*fidelity*` test MUST do a physical `get_item_count(...)` count, and any test reading a validator self-report field (`totalItemLoss`/`expectedItemCounts`/`actualItemCounts`) MUST cross-ground it with a physical count. Exists because a `transfer-fidelity` test that asserted on `totalItemLoss` (the value under test) would have gone green on a broken meter — the catch came from physical counts + adversarial review, never the self-report. **Rule of thumb: if the thing under test could be wrong and the test would still pass, it's grounded in the wrong place.** Rule 3 requires success-path tests to parse `debug_import_result`, call `Assert-TransferSucceeded`, and only then perform destination census; Black-Box Discard must not be misreported as physical loss. Also: ship the adversarial fixture (inactive inserter, failed entity, non-normal quality) WITH the fix, and run `/code-review` before merging any gate/validation/source-deletion change. Add a `lint-test-grounding:allow` comment (with a reason) to suppress a verified exception.
> - **pcall logging** — `scripts/lint-pcall-logging.mjs` (`npm run lint:pcall-logging`), every `pcall`/`xpcall` in the `module/` tree must SURFACE its error (log it / route through `pcall_warn` / propagate it to the caller) or be an annotated `-- intentional probe` — never a silent swallow. Exists because a swallowed pcall hid a belt-API signature mismatch across two failed fix attempts. Add `-- pcall:allow` (with a reason) for a verified false positive.
> - **Catch swallow** — `scripts/lint-catch-swallow.mjs` (`npm run lint:catch-swallow`), the TS analogue of the pcall guard, closing the blind spot the eslint empty-catch rules can't see: a catch that **substitutes a default** (`catch (err) { allLogs = []; }`) without surfacing the error. Every catch in plugin TS/TSX must reference its error binding in a log/throw/rejection/user-visible error, or carry an approved `// catch:allow <reason>`. Exists because exactly that shape hid the transaction-log and controller-storage wipe-on-read-failure bugs for months (fixed in PR #81; guard in PR #82). The guard exports `findCatchSwallows` and ships its own unit tests (`test/lint-catch-swallow.test.cjs`).
> - **Test hooks** — `scripts/lint-test-hooks.mjs` (`npm run lint:test-hooks`), an integration test arming a `test_force_*` hook must disarm it in a guaranteed `finally`/`trap`, unless the hook is verified pre-gate and enumerated in `FAIL_SAFE_HOOKS` (a reviewable act). See Pitfall #30, mutating test hooks must be fail-safe on leak.
> - **Doc refs** — `scripts/lint-doc-refs.mjs` (`npm run lint:doc-refs`), guards the pitfall corpus itself: duplicate pitfall numbers, references to nonexistent pitfalls, and pure-pointer citations (a bare "#N" with no short name — write number + short name so the reference survives renumbering).
> - **Allow manifest** — `scripts/lint-allow-manifest.mjs` (`npm run lint:allow-manifest`), every `*:allow` escape-hatch annotation on any of the guards above must be enumerated in `scripts/lint-allow-manifest.json` with a reason and approver — an allow is an **escalation**, never self-approved (see [memory] `lint-allows-are-escalations`). The manifest must match reality exactly in both directions.
>
> - **Evidence claims** — `scripts/lint-evidence-claims.mjs` (`npm run lint:evidence-claims`), an empirical claim in a code comment ("verified empirically", "[empirical…") must carry a citation (lab rung / commit / Pitfall N + short name / api-notes) within ±3 lines of the claim, in the same comment block. Born from a false "tolerances verified empirically" comment that survived four months as law until the fluid-lab refuted it. Allow marker `lint-evidence-claims:allow` (manifest-gated).
> - **Version certification** — `scripts/lint-version-certification.mjs` (`npm run lint:version-certification`), the pinned Factorio version must equal `tests/labs-certified.json` (which records each lab's evidence commits at the certified pin). An engine pin bump goes red until every `tests/*-lab/` runner re-runs on the new pin — mechanizing the pin-bump re-certification rule (2.0.76→2.0.77 shipped real `destroy()` semantics drift, caught by LAB-I B7). No allow marker: the only fix is re-certification.
> A twelfth guard runs as its own PR-gated CI step (not in `npm run lint`): **commit labels** — `scripts/lint-commit-labels.mjs` fails a PR whose `docs:`-labeled commit touches non-doc paths (commit labels are audit boundaries; a mislabeled rider once evaded two review passes).
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
- **Fluid restoration runs in the frozen world before the exact gate.** R11 proved the shipped restoration code conserves exactly there (Pitfall #17, historical pre-activation fluid loss). **Fusion-reactor output rejects writes** (Pitfall #21, fusion outputs are engine-managed). Subtract
  only physically rejected writes from expected counts; capacity drops remain gate failures. One pre-activation verdict covers exact items and aggregate-by-name fluids (`epsilon=1e-6`).
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
7. Fluid restoration      — inject while platform remains paused and entities deactivated
8. Exact validation       — one immutable verdict: exact items + by-name fluids
9. Activation             — only after the verdict passes; then gateway park if requested
10. Loss analysis         — post-activation reporting under `postActivationReport`; never changes verdict
```

**Why this order matters**:
- Step 4 (beacon activation): beacons are kept active during entity creation (never deactivated). Phase 2 explicitly activates them and fills their energy buffer. This is necessary but not sufficient — beacons need their **module inventory populated** before `crafting_speed` reflects the beacon bonus.
- Step 5 (inventories, 2 passes): The two-pass approach is critical. `crafting_speed` on a machine updates **immediately** when its nearby beacon's `beacon_modules` inventory is populated — no tick delay, no power required. Pass 1 populates all beacon modules. Pass 2 then restores crafter inputs with `set_stack()`, which uses the now-correct beacon-boosted cap (e.g. cs=17.375 → 12 slots instead of cs=2.5 → 7 slots). Machines remain deactivated throughout — they cannot consume items.
- Steps 6→8 are one synchronous frozen-world completion and verdict pass. The old pipeline's ~15% pre-activation loss was historical and class-unisolated; R11 measured the current restoration path exact before activation, and five consecutive 1,359-entity transfers grounded the production ordering. A failure banks an always-on black box, then discards the destination unless the debug-gated preserve flag is explicitly armed.

### 17. Historical Pre-Activation Fluid Loss (Class Unisolated)
**Measured history**: an old import pipeline lost ~15% when fluids were injected pre-activation; moving injection after activation eliminated that whole-pipeline loss. The responsible entity/topology class was never isolated.
**Current-pin result**: fluid-lab R11 [empirical, 2.0.77] ran the shipped `FluidRestoration.restore()` in a paused, deactivated destination world, including two real 1,359-entity transfers. Frozen and same-tick post-activation censuses conserved all eight fluid names exactly (`max |delta| = 0`, comparison epsilon `1e-6`), after subtracting only engine-rejected fusion output writes.
**Historical hypothesis, not law**: the old "detached ghost buffer overwritten on segment merge" explanation cited closed-source internals and its constructible predictions did not reproduce. Tested activatable entities expose no non-nil segment ID on their own fluidboxes at 2.0.77; `LuaEntity.frozen` is read-only. Keep the old loss as an honest historical fact, not as proof that current restoration requires a live world.
**Production state**: the production path now restores fluids in the paused/deactivated world, applies the single exact gate, and activates only after success. Post-activation fluid counts are telemetry only.
**Key files**: `async-processor.lua` (`complete_import_job`), `fluid_restoration.lua`, `active_state_restoration.lua`

### 18. Entity Handlers Must Export Fluids for Crafting Machines
**Symptom**: Assembling machines (chemical plants, oil refineries) and furnaces (foundries) lose all fluid on transfer, even though pipes/tanks preserve fluid correctly.
**Root Cause**: `EntityHandlers["assembling-machine"]` and `EntityHandlers["furnace"]` in `entity-handlers.lua` only exported `inventories`, not `fluids`. These entity types have fluidboxes (chemical plants hold fluid reagents, foundries hold molten metals), but the handler never called `InventoryScanner.extract_fluids(entity)`. Entities without a specific handler use the default handler, which correctly exports both inventories AND fluids — so pipes, tanks, pumps, and thrusters (no specific handler) worked fine.
**Fix**: Added `fluids = InventoryScanner.extract_fluids(entity)` to both the `assembling-machine` and `furnace` handlers.
**Key files**: `entity-handlers.lua` (lines ~45 and ~92)
**Lesson**: When adding a new entity handler, always check if the entity type has a fluidbox. The default handler exports both inventories and fluids — a specific handler that only exports inventories silently drops fluid data.

### 19. Removing a Space Platform — use `game.delete_surface`, not `platform.destroy()` (CRITICAL)
At 2.0.77, LAB-I B7 measured `platform.destroy()` with no argument as a silent no-op, while `destroy(0)` deleted after an elapsed tick and `destroy(60)` deleted on the deferred schedule. Keep `game.delete_surface(platform.surface)` as this project's deterministic removal route through `GameUtils.delete_platform(platform)` (`module/utils/game-utils.lua`), which also handles the surfaceless edge case; do not generalize the old 2.0.76 all-no-op result to ticked calls on 2.0.77.
**Enforced**: `npm run lint:lua` (gated in CI) fails on any `*platform*.destroy()` call.
**Key files**: `instance.ts` (`handleDeleteSourcePlatform`), `module/core/import-pipeline.lua` (import rollback paths).

### 32. Export-Only Destination Must Be `nil` (Not `0`)
**Symptom**: Export succeeds but source platform remains locked (looks stuck in UI).
**Cause**: `Number(null) === 0` in JS. Passing `0` as destination to Lua is truthy, so export is treated as transfer and unlock is skipped.
**Fix**: In `instance.ts`, only treat `targetInstanceId` as a transfer destination if it is a positive integer (`> 0`); otherwise pass Lua `nil`.

### 21. Fusion Plasma Handling (revision queued)
Fusion write rejection does NOT reproduce at 2.0.77 — reactor and generator plasma writes stick in every scratch condition (fluid-lab R14). Current shipped behavior still EXCLUDES plasma via prototype connection-category (`fluid-ownership.lua`) and tracks `write_rejected` in `fluid_restoration.lua`; revision is the queued shared-accessor /di-change. Until it lands, plasma never rides a transfer.

### 22. Activatable Entities Expose No Own Segment ID on 2.0.77 (REFINED: fusion reactor is the exception)
Fluid-lab R7 found no tested activatable entity whose own fluidbox exposes a non-nil `get_fluid_segment_id(i)`, including a pump connected to segmented pipes/tanks; machine buffers likewise returned nil. Pipes/tanks expose segment IDs but are not activatable. `inventory-scanner.lua` handles the nil case by reading `fluidbox[i]` directly; without it, these fluids are silently dropped.
**Refinement [empirical, 2.0.77, live probe 2026-07-17]:** the **fusion reactor's OWN boxes DO expose segment IDs** (coolant input AND plasma output), while the fusion-generator plasma inputs sharing the same segment read nil. So "activatable ⇒ nil segment ID" is not a law — an engine-owned exclusion keyed on the nil check alone misses the reactor's segmented plasma (the census phantom-plasma abort; see the fusion segment-ID entry in [docs/factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md)).

### 23. Temperature Merge and Key Boundaries
Fluid-lab R12 [empirical, 2.0.77] connected `500 steam@165°C` to `1500 steam@500°C` and read one exact `2000@416.25°C` segment: volume and V×T were conserved by a volume-weighted merge. The requested key sweep from 9,999 through 10,000,000°C did not expose floating-point drift because the steam prototype clamped every write to 5,000°C, producing one stable `steam@5000.0C` key. The generic ">1,000,000°C doubles lose precision" story does not license the current 10,000 threshold; the threshold value remains task #30 territory.
**Key files**: `loss-analysis.lua` (`reconcile_fluids` → `highTempAggregates`), `web/utils.js`, `web/TransactionLogsTab.jsx`.

### 24. LuaProfiler Serialization — LocalisedString Snapshots (CRITICAL)
`LuaProfiler` cannot be serialized and `tostring()` returns a memory address, not a time — see [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md). To persist timing across save/load, embed the profiler in a LocalisedString array (`{"", profiler}`); the engine bakes the value in and a GUI label renders it. Keep live profilers in module-local tables (never `storage`), and snapshot them to LocalisedStrings at job completion. Display-only — no math, no JSON.
**Key files**: `utils/phase-profiler.lua`, `utils/transaction-history.lua`, `interfaces/gui/transaction-dashboard.lua`, `core/import-completion.lua`, `core/export-pipeline.lua`.

### 25. LocalisedString 20-Parameter Limit Can Crash on_tick (CRITICAL)
**Symptom**: Instance shuts down with code 255 during import completion/validation, RCON drops with `Connection closed`, and host logs show `Factorio server unexpectedly shut down`.
**Root Cause**: A single `game.print({...})` LocalisedString exceeded Factorio's hard parameter cap: `Too many parameters for localised string: 39 > 20 (limit)`. This occurred when printing all phase profiler values in one array.
**Error signature**:
```text
Error while running event level::on_tick (ID 0)
Too many parameters for localised string: 39 > 20 (limit)
... import-completion.lua:479 ...
```
**Fix**: Split output into multiple `game.print({"", ...})` calls (one line per phase) so each LocalisedString stays under 20 parameters. Do not pack full perf summaries into one LocalisedString.
**Key file**: `module/core/import-completion.lua`

### 26. NEVER Extract a Clusterio Link Method — Call It Bound (CRITICAL, caused 2 crashes)
**Symptom**: `Cannot read properties of undefined (reading 'handleRequest')` at instance **start**, or `Cannot read properties of undefined (reading 'sendRequest')` during a **transfer**. The instance may even start fine and only crash later when the broken path runs.
**Root Cause**: Clusterio's `Link` methods (`handle`, `sendTo`, `send`, `sendRequest`, `subscribe`, …) rely on `this`. **Extracting one as a value** — directly OR via a cast — loses the binding, so the method runs with `this === undefined` and throws inside `@clusterio/lib`:
```ts
// BROKEN — both of these lose `this`:
const handleMessage = this.i.handle as (cls, h) => void;   // → "reading 'handleRequest'" at start
handleMessage(messages.TransferStatusUpdate, …);
const sendToController = this.i.sendTo as (...) => …;       // → "reading 'sendRequest'" on transfer
await sendToController("controller", new messages.TransferPlatformRequest({…}));
```
Both were introduced by PR #2 (`902c5f8`) as "permissive casts" for Request/Response type mismatches — the `as (...) => …` cast on the *method* silenced the type error AND would silence the lint rule meant to catch it.
**Fix**: ALWAYS call the method **bound** (`this.i.handle(...)`, `this.i.sendTo(...)`). When the plugin's duck-typed message classes don't satisfy the strict overloads, cast the **arguments/result**, never the method:
```ts
this.i.handle(messages.TransferStatusUpdate as never, this.handleTransferStatusUpdate.bind(this) as never);
const resp = await this.i.sendTo(
  "controller",
  new messages.TransferPlatformRequest({ exportId, targetInstanceId }) as never,
) as messages.SimpleResponse & { transferId?: string };
```
**Diagnosing it**: the `this.logger` lines around the throw are in the host log file, not `docker logs` — see Observability above. Read `/clusterio/logs/host/host-*.log` for the exact `Error handling … : Cannot read properties of undefined (reading 'sendRequest')`.
**Mechanical guard**: `npm run lint` (eslint `@typescript-eslint/unbound-method` + a `no-restricted-syntax` rule flagging extraction/cast of any Link method) catches this — and is enforced in CI. This Pitfall exists because a manual audit caught the `handle` site but **missed** the identical `sendTo` site; do not rely on manual review for this class of bug.
**Key file**: `instance.ts` (handler registration ~line 79, `handleExportComplete` sendTo sites).

### 27. Web-UI Icons Blank ("?") — export-data / game-client persistence (CRITICAL)
**Symptom**: Transfer Details / Entities tab shows `?` placeholder icons; browser console/network shows
`Failed to fetch prototype metadata for mod pack <id>, server returned: 404 Not Found`.
**Cause**: the mod pack has no **export-data** (icon spritesheets + prototype metadata). In alpha.25 the icon
system is upstream-native (`FactorioIcon` + `useExportPrototypeMetadata`, [PR #875]; the old `ExtendedExportData`
fork is retired — see [[clusterio-alpha25-migration]]). The data is produced by **`clusterioctl instance
export-data <instance>`**, which is **never** generated unless the export host actually runs the **graphical game
client** (headless has no sprites). Two things silently break it:
  1. **`SKIP_CLIENT=true` on the EXPORT_HOST (host-1).** The base image's `seed-instances.sh` auto-runs
     `export-data` on first seed **only** when `EXPORT_HOST` is set (controller has `EXPORT_HOST=1`) **and** the
     host has a client. With `SKIP_CLIENT=true`, host-1 runs headless-only → export skipped, icons blank. A
     `docker-compose.debug.yml` override once set this on host-1 — **never set `SKIP_CLIENT=true` on host-1**
     (host-2 is import-only and keeps it).
  2. **Stale client version after a Factorio bump.** host-1 uses the client as its `factorio_directory`, a
     single-version **direct install** (clusterio-docker Pitfall #11 — client & multi-version headless are
     mutually exclusive). Clusterio auto-downloads the **free headless** for any version, but **NOT** the
     **owned graphics client** (needs the account token), so the client is a hand-managed install that does
     **not** move when you bump the instance `factorio.version`. A 2.0.x **client** can export icons for any
     2.0.y pack (icons are version-agnostic), but Clusterio refuses to *run the instance* on a mismatched
     binary → export fails. Keep them in lockstep via **`FACTORIO_CLIENT_TAG`** in `.env` (= the instances'
     `factorio.version`; `FACTORIO_CLIENT_BUILD=expansion` for Space Age).
**How it works / where it lands**: `export-data` (instance must be **stopped**) launches the client with
`--export-data` → assets written to the controller's **`/clusterio/static/<kind>.<hash>.{json,png}`**
(prototypes/spritesheet/metadata/locale/defines/settings), referenced by an **`export_manifest`** on the mod-pack
record in `mod-packs.json`, served at **`/static/...`**; `FactorioIcon` fetches them. Verify:
`curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/static/<prototypes-asset>` → `200`.
**Persistence (3 invariants)**: (a) host-1 (=`EXPORT_HOST`) never `SKIP_CLIENT=true`; (b) `FACTORIO_CLIENT_TAG`
pinned in `.env` to the instance version — **bump both together**; (c) the **external** `factorio-client` volume
persists the client across `down -v`, so fresh-seed auto-export always has a client. After a manual version bump
(no `down -v`), the seed-time auto-export does **not** re-run (`.seed-complete`); regenerate by hand:
```powershell
# host-1 must already have a client matching the instance version (FACTORIO_CLIENT_TAG)
./tools/rcon.ps1 ...                                  # (not needed) — use clusterioctl directly:
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json instance stop clusterio-host-1-instance-1'
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json instance export-data clusterio-host-1-instance-1'  # "Export complete: N icons"
docker exec surface-export-controller sh -c 'npx clusterioctl --config /clusterio/tokens/config-control.json instance start clusterio-host-1-instance-1'
```
Then **hard-refresh** the browser (the 404 is cached). After a `down -v`, fresh seed regenerates it automatically.
**Key files/config**: `.env` (`FACTORIO_CLIENT_TAG`/`FACTORIO_CLIENT_BUILD`), `docker-compose.debug.yml` (no
`SKIP_CLIENT` on host-1), clusterio-docker `scripts/seed-instances.sh` (auto-export), `web/icons.tsx`.

### 28. Transfer Validation Timing — the gate must count a COMPLETE state (CRITICAL, data-integrity)
**Symptom**: the transfer gate reports a few hundred items "lost" (the phantom 382/417) even though the
transfer physically preserves ~100%. Tightening the loose tolerance to catch real loss then fails *every*
transfer.
**Root cause**: the gate counts the destination **pre-activation** (Pitfall #15 — machines must stay
deactivated through validation or they craft in the gap and produce false GAINS), and inserter **held items**
had NO restore path that actually ran before the gate: `Deserializer.restore_inventories`' held block was
**dead code** (stranded behind its `has_inventories` early-return, unreachable for every bare inserter), so
hands were never seated — absent at the gate. The gate measured a *deliberately-incomplete* reality. The data
was fine; nothing owned held seating at the right time.
**Mechanism correction (2026-07-18, inserter-lab B6)**: the original diagnosis — "`set_stack` silently fails
on a settled-deactivated inserter" — was REFUTED by measurement [empirical, 2.0.77, inserter-lab B6]:
seating is **activation-independent** (a deactivated inserter, fresh or settled, seats fully when force
capacity allows; at bonus 0 the clamp is identical active or inactive). The wake-toggle the fix originally
carried was refuted cargo and has been removed.
**DO NOT re-attempt** (each is a proven dead-end — see [memory] `validation-timing-trilemma`): (1) move
validation after activation → craft-gain false failures; (2) subtract *predicted* held items from expected
(PR #25, closed) → prediction ≠ restoration → the subtracted item is never physically restored →
**silent permanent loss**; (3) gate-vs-display two-pass → coupling hell.
**Fix (approach #4 — give held seating one owner that runs pre-gate)**: a synchronous pre-gate pass
(`ActiveStateRestoration.restore_held_items_only`) — the SINGLE owner of held seating — seats every hand
via plain `set_stack` (no engine tick → no swing, no crafting), so the gate counts a **complete** physical
reality with every machine still deactivated. Fluid restoration then completes the same frozen world and
`validate_import(..., {strict=true})` requires exact per-key items and exact aggregate-by-name fluids.
**Rule**: a gate must measure a COMPLETE state, never a mid-process one — fix the timing, not the number. The current transfer verdict is one immutable pre-activation result; `failedStage` names the mismatched category (`items` or `fluids`).
**Mechanical guard**: `tests/integration/gate-detects-loss` injects a real shortfall (`test_force_item_loss`)
and asserts the strict gate FAILS + the source is preserved — so reverting to a loose gate goes RED in CI.
**Clock evidence (2026-07-07, 2.0.77)**: `tests/no-tick-sync-lab/run-pr0b.mjs` proves the synchronous pass
keeps `game.tick`, `crafting_progress`, and the restored inserter hand stable through the strict count.
**Key files**: `module/import_phases/active_state_restoration.lua`, `module/core/import-completion.lua`,
`module/validators/transfer-validation.lua`.
**Deeper root cause (the CI-only residual): see Pitfall #29** — `restore_held_items_only` (the timing fix
above) is necessary but NOT sufficient on an under-researched destination: `set_stack` clamps to the dest
inserter's *physical* hand capacity, which the dest **force's** research governs. The phantom 382/417 was that
clamp, not the clock alone.

### 29. Inserter Held-Item Capacity Is Governed by the DEST Force's Research — Replicate It On Import (CRITICAL, data-integrity)
**Symptom**: a transfer of a busy platform fails the strict gate **only on CI** (railgun-ammo 80→33,
"held_failed=214"), while the *same payload + same code* restores held items fully **locally**. "Same bytes,
different by machine."
**Root cause**: a bulk-inserter hand's physical capacity = the **destination force's**
`bulk_inserter_capacity_bonus` (normal inserters: `inserter_stack_size_bonus`) — research-derived scalars that
live in the **dest save**, which the plugin did not transfer. Measured on 2.0.76: CI's fresh `test2.zip` seed
has `bulk_inserter_capacity_bonus = 0` → a fresh legendary bulk inserter caps at 1 (`set_stack(8)→1`,
`.count=8→1`); a long-lived local host-2 has bonus 11 → seats 8. So the held items the source legitimately held
are **genuinely unplaceable** on a less-researched dest, and the strict gate (Pitfall #28, count a complete state) **correctly** refuses
(two-phase commit preserves the source). NOT a restoration bug. This also overturns the "`held_stack.count` has
no capacity cap" assumption — it clamps (CI: `.count=8→1`).
**Fix — Pre-Hydration Force Sync**: export captures the source force's inserter bonuses (`force_data`); import
replicates them onto the dest force in a one-shot **Phase 0** (`ImportPipeline.process_batch`) **before** any
entity is created — **RAISE-ONLY** (`math.max`; never lower an unrelated destination force's state during an import). It raises **every distinct force the entities land on** (`entity_data.force or "player"`), not just
the platform force, so a differently-forced inserter can't be left under-capacity (silent loss). The property
list is a single source of truth: `GameUtils.FORCE_SYNC_PROPS`. The existing `restore_held_items_only` → strict
gate then seats full and passes **natively** — the gate is unchanged. A non-fatal `forceDataMismatches` warning
surfaces the raise in the UI. **Applies to ALL imports (transfer AND uploaded-JSON), by design** — fidelity over
avoiding the (warned, raise-only) research-boost side effect; uploads delete no source, so there is no loss risk
either way.
**Durability (verified on 2.0.77, inserter-lab B4)**: an unbacked direct write grants real seating capacity, and once seated a legendary bulk-inserter hand stayed at 8 when the bonus dropped 11→0, after elapsed ticks, and after `reset_technology_effects()` — so there is no
post-commit loss path; the write need not be tech-backed.
**Mechanical guard**: `tests/integration/force-bonus-sync` forces the dest bonus to 0, transfers, and asserts
(physical held counts) the bonus is raised, held items seat in full, the strict gate passes, and the warning
fired — reverting the sync goes RED. CI's native bonus-0 host-2 means platform-roundtrip / transfer-fidelity
corroborate.
**Key files**: `module/core/export-pipeline.lua` (capture), `module/core/import-pipeline.lua` (Phase-0 sync),
`module/core/import-completion.lua` (warning), `module/import_phases/active_state_restoration.lua` (the
disproven `count=` hack removed). Memory: [memory] `held-item-loss-is-dest-force-research`.

### 30. A Mutating Debug/Test Hook Must Be Fail-Safe On LEAK (CRITICAL, data-integrity)
**Symptom**: a debug-gated `test_force_*` hook silently corrupts the NEXT unrelated transfer (not the one under
test) — e.g. destroys destination entities *after* the gate passed, so the transfer still reports SUCCESS and the
source is deleted = unattributed data loss, firing only on the flaky/error path (hardest to notice).
**Root cause**: `debug_mode` defaults **true** on the always-up shared cluster (Pitfall #13, debug mode defaults true on fresh saves) and hook flags
persist in `storage.surface_export_config`. If the arming integration test disarms only on its **success path**
(no `finally`/`trap`; an early `exit 1` skips the cleanup), a leaked flag stays armed and detonates on a later
transfer. `/code-review` (not the author) caught exactly this in `test_force_entity_loss`: post-gate, destructive,
persisted, non-blocking — the worst combination.
**Rule**: a hook that MUTATES game state must be fail-safe on leak. Prefer **PRE-gate** placement (a leak makes
the next transfer FAIL its gate + PRESERVE its source — self-protecting, like `test_force_item_loss`); if it must
be post-gate/destructive, the arming test MUST disarm in a guaranteed `finally`/`trap` (PowerShell runs `finally`
even on `exit`); best of all, use a **non-destructive** hook (inflate the *expected* value, don't destroy real
state).
**Mechanical guard**: `npm run lint:test-hooks` (`scripts/lint-test-hooks.mjs`, gated in CI) fails when an
integration test arms a `test_force_*` hook without a `finally`/`trap`, UNLESS the hook is verified pre-gate and
listed in `FAIL_SAFE_HOOKS` (a reviewable act). Run the **`/di-change`** skill before merging any
gate/validation/rollback/source-delete/test-hook change — it codifies this plus the grounding / commensurate /
two-phase-commit rules. Memory: [memory] `test-hook-mutating-must-be-fail-safe`.

### 31. Platform Identity Is `surface.index` / Unique Index — NEVER the Mutable `platform.name` (CRITICAL, data-integrity + exploit)
**Symptom**: transferring a platform that a player RENAMES mid-flight produces a DUPLICATE (two live copies on
different instances). A malicious player can farm duplicates on demand.
**Root cause**: `LuaSpacePlatform.name` is MUTABLE — a player can rename a platform any time from the hub GUI
(verified: Factorio wiki, *"space platforms can later be renamed from the menus of their space platform hubs"*;
`surface.index` and `platform.index` are the STABLE unique identifiers). The sole source-delete path
(`delete-platform-for-transfer.lua`) keyed its identity cross-check on the name (`platform.name ~= expected` →
refuse). On a rename mid-transfer the LIVE name no longer matched the name captured at lock time → the delete
REFUSED → the source survived while the destination copy had already committed = two live copies. (Names also
COLLIDE — two platforms can share one — so name-based identity can match the WRONG platform.)
**Fix**: key EVERY transfer/lock/delete IDENTITY decision on the STABLE `surface.index` (recorded in the lock at
lock time) or the unique `platform.index` — never `platform.name`. The delete gate reads `lock.surface_index`
(before the best-effort unlock clears it) and compares it to the current `platform.surface.index` via the pure
`SurfaceLock.transfer_delete_identity_ok(lock, surface)`; a rename is then correctly IGNORED (same surface ⇒ same
platform ⇒ proceed), a released/reused lock is REFUSED. Resolve a user-supplied NAME→index ONLY at the admin
tooling boundary, failing LOUD on ambiguity (`find_lock_key_by_name`).
**Rule**: NAME is a display label, NEVER an identity/join key for a destructive or lock decision. Same owner rule
as [memory] `lookup-by-unique-id-not-name` — now mechanically enforced.
**Mechanical guard**: `npm run lint:lua` (`scripts/lint-lua-invariants.mjs`, gated in CI) — the
`no-name-as-transfer-identity` rule fails on `platform.name`/`platform_name` used in an `==`/`~=` comparison
within the source-delete + lock-identity spine (`delete-platform-for-transfer.lua`, `surface-lock.lua`,
`transfer-trigger.lua`, `export-pipeline.lua`). Sanctioned name→index boundary lookups carry a
`-- lint-lua:allow <reason>` annotation. Teeth verified: reverting the delete gate to a name comparison goes RED.
**Key files**: `module/interfaces/remote/delete-platform-for-transfer.lua`, `module/utils/surface-lock.lua`
(`transfer_delete_identity_ok`; the lock record stores `surface_index`), `scripts/lint-lua-invariants.mjs`.
Behavioral teeth: the `transfer_delete_identity_ok` checks in `transfer-lock-selftest.lua` (a renamed source
STILL deletes). Memory: [memory] `lookup-by-unique-id-not-name`.

## Factorio 2.0 Fluid API & Simulation Behavior

Moved to [factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md) — the fluid-segment model, the
fluidbox proxy/capacity behavior, segment-ID dedup, the floating-point epsilon rule, and the
inject-after-activation requirement. Read it before touching fluid scanning or restoration.

## Additional Documentation

- [docs/README.md](docs/README.md) - Plugin overview and documentation index
- [docs/commands-reference.md](docs/commands-reference.md) - All available commands
- [docs/QUICK_START.md](docs/QUICK_START.md) - End-to-end transfer walkthrough
- [docs/CI_CD.md](docs/CI_CD.md) - CI pipeline, Factorio-baking for integration tests, and debugging failed runs
- [docs/TRANSFER_WORKFLOW_GUIDE.md](docs/TRANSFER_WORKFLOW_GUIDE.md) - Transfer phases and validation
- [docs/EXPORT_IMPORT_FLOW.md](docs/EXPORT_IMPORT_FLOW.md) - Complete action trace with debugging
- [docs/IMPLEMENTATION_SUMMARY.md](docs/IMPLEMENTATION_SUMMARY.md) - Module structure and design decisions
- [docs/async-processing.md](docs/async-processing.md) - Async batch processing architecture
- [docs/TRANSFER_CODE_PATHS.md](docs/TRANSFER_CODE_PATHS.md) - Transfer feature mapped to its code paths
- [docs/factorio-2.0-api-notes.md](docs/factorio-2.0-api-notes.md) - Verified Factorio 2.0 API & fluid-simulation facts
- [docs/FAILED_ENTITY_LOSS_TRACKING.md](docs/FAILED_ENTITY_LOSS_TRACKING.md) - How losses from entities that fail to place are attributed

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
- `surface_export_operations_total{operation,result}` — counter; `operation` ∈ transfer/export/import, `result` ∈ success/failure/cleanup_failed
- `surface_export_operation_duration_seconds{operation,result}` — histogram (buckets 0.5s…300s)
- `surface_export_entities_transferred_total{operation}` — counter (entities placed on the destination)

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
