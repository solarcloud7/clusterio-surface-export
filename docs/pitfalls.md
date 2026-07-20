# Common Pitfalls & Solutions

The full pitfall corpus: every hard-won lesson with its mechanism, fix, evidence, and key files.
Machine-readable metadata (stable slug, status, enforcing guard) lives in [pitfalls.json](pitfalls.json);
the compact index table is in [CLAUDE.md](../CLAUDE.md). All three are held consistent by
`npm run lint:doc-refs`.

> **Numbering is frozen.** Numbers are legacy aliases — never renumber, never reuse (#8 is retired;
> code comments cite numbers). When citing a pitfall, always write number + short name
> (e.g. "Pitfall #19, platform.destroy is a no-op") so the reference means something to a human
> without a lookup. New citations may also use the registry slug.

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
**See**: [EXPORT_IMPORT_FLOW.md](EXPORT_IMPORT_FLOW.md) — import phase call tree and validation summary

### 16. Verification Counts From Live Scan vs Serialized Data (CRITICAL — Fixed)
**Symptom**: Transfer validation fails with "GAINED items" across many item types (iron-plate, copper-cable, piercing-rounds-magazine, etc.). Gains are a fraction of belt item totals.
**Cause**: Export verification used `Verification.count_surface_items()` (live scan) AFTER entity scanning completed across multiple ticks. **Belts keep moving** — belt-class `active` writes are rejected by the engine (BELT-R13; even on paused platforms), so belt items cannot be frozen during a multi-tick scan. During the multi-tick export, items move between belts causing a "rolling snapshot" effect: an item on belt A captured in tick 1 may move to belt B captured in tick 5 → double-counted in serialized data. Conversely, items can move from unscanned to already-scanned belts and be missed. The net result is the serialized data doesn't match the live surface state at any single point in time.
**Evidence status**: the FIX (atomic single-tick belt scan) is [empirical] — the GAINED-items failures were reproducible and v2 eliminated them. The "rolling snapshot" mechanism is [hypothesis] (consistent with all observations, never isolated as its own rung).
**Fix (v2 — Atomic Belt Scan)**: Belt item extraction is now **deferred** during async entity scanning. Entity structure (position, direction, type, belt_to_ground_type, etc.) is still captured async per-tick, but `extract_belt_items()` is skipped (controlled by `EntityHandlers.skip_belt_items` flag). When all entities are scanned, `complete_export_job` does a single-tick atomic pass over all tracked belt entities, calling `extract_belt_items()` and patching the serialized data. This gives a consistent snapshot: no items can move between belts within a single tick. Verification is then generated from this consistent serialized data.
**Key files**: `entity-handlers.lua` (`skip_belt_items` flag on transport-belt/underground-belt/splitter handlers), `async-processor.lua` (`process_export_batch` sets flag + tracks belt entities, `complete_export_job` atomic belt scan block before verification)
**Previous approach (v1)**: Used `Verification.count_all_items()` from serialized data for verification (self-consistent but inaccurate). This masked the problem — verification matched import, but both were based on inconsistent belt data.

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

### 20. Failed Entity Loss Attribution (Fixed)
**Symptom**: Transfer validation fails or shows unexplained item/fluid losses when some entities fail to place (e.g., mod mismatch, prototype collision). Validation reports "expected 500 iron-plate, got 450" with no indication of why.
**Cause**: When `create_entity` returns nil, all downstream restoration phases skip that entity silently (they check `entity_map[id]` and move on). Items and fluids inside the failed entity are never placed, but they remain in the "expected" totals from verification data, causing false validation failures or unexplained loss.
**Fix**: At the failure site in `entity_creation.lua`, tally items (inventories, belt lines, held item) and fluids from the serialized entity data into `job.failed_entity_losses`. In `async-processor.lua`, before calling `validate_import`, deep-copy and subtract failed-entity items from expected counts so validation only compares achievable totals. Attach `failedEntityLosses` to the validation result so it flows through `send_json` to the controller and web UI. In `loss-analysis.lua`, log a full per-entity breakdown.
**Key files**: `entity_creation.lua` (tally at failure site), `async-processor.lua` (adjust expected + attach to result), `loss-analysis.lua` (report section)
**Output**: Log lines like `[Entity Creation] FAILED to create 'foundry' (type=furnace) at (12.5,4.5) — lost 50 items, 200.0 fluids` and `[Loss Analysis] 1 entities failed to place — 50 items, 200.0 fluids unrestorable`. `failedEntityLosses` field in validation result JSON sent to controller.

### 21. Fusion Plasma Handling (revision queued)
Fusion write rejection does NOT reproduce at 2.0.77 — reactor and generator plasma writes stick in every scratch condition (fluid-lab R14). Current shipped behavior still EXCLUDES plasma via prototype connection-category (`fluid-ownership.lua`) and tracks `write_rejected` in `fluid_restoration.lua`; revision is the queued shared-accessor /di-change. Until it lands, plasma never rides a transfer.

### 22. Activatable Entities Expose No Own Segment ID on 2.0.77 (REFINED: fusion reactor is the exception)
Fluid-lab R7 found no tested activatable entity whose own fluidbox exposes a non-nil `get_fluid_segment_id(i)`, including a pump connected to segmented pipes/tanks; machine buffers likewise returned nil. Pipes/tanks expose segment IDs but are not activatable. `inventory-scanner.lua` handles the nil case by reading `fluidbox[i]` directly; without it, these fluids are silently dropped.
**Refinement [empirical, 2.0.77, live probe 2026-07-17]:** the **fusion reactor's OWN boxes DO expose segment IDs** (coolant input AND plasma output), while the fusion-generator plasma inputs sharing the same segment read nil. So "activatable ⇒ nil segment ID" is not a law — an engine-owned exclusion keyed on the nil check alone misses the reactor's segmented plasma (the census phantom-plasma abort; see the fusion segment-ID entry in [docs/factorio-2.0-api-notes.md](factorio-2.0-api-notes.md)).

### 23. Temperature Merge and Key Boundaries
Fluid-lab R12 [empirical, 2.0.77] connected `500 steam@165°C` to `1500 steam@500°C` and read one exact `2000@416.25°C` segment: volume and V×T were conserved by a volume-weighted merge. The requested key sweep from 9,999 through 10,000,000°C did not expose floating-point drift because the steam prototype clamped every write to 5,000°C, producing one stable `steam@5000.0C` key. The generic ">1,000,000°C doubles lose precision" story does not license the current 10,000 threshold; the threshold value remains task #30 territory.
**Key files**: `loss-analysis.lua` (`reconcile_fluids` → `highTempAggregates`), `web/utils.js`, `web/TransactionLogsTab.jsx`.

### 24. LuaProfiler Serialization — LocalisedString Snapshots (CRITICAL)
`LuaProfiler` cannot be serialized and `tostring()` returns a memory address, not a time — see [factorio-2.0-api-notes.md](factorio-2.0-api-notes.md). To persist timing across save/load, embed the profiler in a LocalisedString array (`{"", profiler}`); the engine bakes the value in and a GUI label renders it. Keep live profilers in module-local tables (never `storage`), and snapshot them to LocalisedStrings at job completion. Display-only — no math, no JSON.
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
**Mechanical guard**: the `gate-item-loss` pad fixture (run through `tests/integration/pad-transfer-suite`) injects a real shortfall (`test_force_item_loss`)
and asserts the strict gate FAILS + the source is preserved — so reverting to a loose gate goes RED in CI.
**Clock evidence (2026-07-07, 2.0.77)**: the no-tick-sync-lab PR0b runner (archived at `labs-archive-2026-07-19`) proves the synchronous pass
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
**Mechanical guard**: the `force-bonus-held` pad fixture (run through `tests/integration/pad-transfer-suite`) forces the dest bonus to 0, transfers, and asserts
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

### 32. Export-Only Destination Must Be `nil` (Not `0`)
**Symptom**: Export succeeds but source platform remains locked (looks stuck in UI).
**Cause**: `Number(null) === 0` in JS. Passing `0` as destination to Lua is truthy, so export is treated as transfer and unlock is skipped.
**Fix**: In `instance.ts`, only treat `targetInstanceId` as a transfer destination if it is a positive integer (`> 0`); otherwise pass Lua `nil`.
