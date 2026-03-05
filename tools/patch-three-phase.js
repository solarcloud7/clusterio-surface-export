const fs = require("fs");
const file = "docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua";
let content = fs.readFileSync(file, "utf8");
const e = "\r\n";

// ── 1. Update Phase 1 end comment and introduce pending_beacon_tick ──────────
const oldPhase1End =
	`  -- Phase 1 complete: schedule Phase 2 for next tick so beacon effects have propagated.${e}` +
	`  -- Beacon speed bonuses apply on the tick AFTER the beacon is placed; set_stack() called${e}` +
	`  -- in the same tick as entity creation sees the unmodified crafting_speed (lower cap).${e}` +
	`  job.pending_finish_tick = game.tick + 1${e}` +
	`  log(string.format("[Import] Phase 1 complete (tick %d). Inventory restoration deferred to tick %d (beacon propagation)", game.tick, job.pending_finish_tick))${e}` +
	`end`;

const newPhase1End =
	`  -- Phase 1 complete. Schedule Phase 2 (beacon activation) for the next tick.${e}` +
	`  -- Beacons are placed inactive. We activate them in Phase 2, then wait ONE MORE tick${e}` +
	`  -- before restoring inventories (Phase 3). The engine needs a full tick after beacon${e}` +
	`  -- activation before crafting_speed changes take effect for set_stack() cap calculation.${e}` +
	`  job.pending_beacon_tick = game.tick + 1${e}` +
	`  log(string.format("[Import] Phase 1 complete (tick %d). Beacon activation scheduled for tick %d", game.tick, job.pending_beacon_tick))${e}` +
	`end`;

if (!content.includes(oldPhase1End)) { console.error("oldPhase1End not found"); process.exit(1); }
content = content.replace(oldPhase1End, newPhase1End);

// ── 2. Rename finish_import_job_phase2 → finish_import_job_phase3, add Phase 2 fn ──
const oldPhase2Header =
	`--- Phase 2 of import completion: restore inventories, activate entities, restore fluids, validate.${e}` +
	`--- Called one tick after finish_import_job (Phase 1) so beacon crafting_speed bonuses are active.${e}` +
	`local function finish_import_job_phase2(job)`;

const newPhase2Header =
	`--- Phase 2: activate beacons so their speed bonuses propagate before inventory restoration.${e}` +
	`--- Called one tick after Phase 1 (entity creation). Beacon effects require a full engine tick to${e}` +
	`--- take effect on crafting_speed — activating and calling set_stack() in the same tick still sees${e}` +
	`--- the unmodified cap. Phase 3 (inventory restoration) runs the following tick.${e}` +
	`local function finish_import_job_phase2(job)${e}` +
	`  local entity_map = job.entity_map or {}${e}` +
	`  local entities_to_create = job.entities_to_create or {}${e}` +
	`  local beacons_activated = 0${e}` +
	`  for _, entity_data in ipairs(entities_to_create) do${e}` +
	`    if entity_data and entity_data.entity_id then${e}` +
	`      local entity = entity_map[entity_data.entity_id]${e}` +
	`      if entity and entity.valid and entity.type == "beacon" then${e}` +
	`        entity.active = true${e}` +
	`        beacons_activated = beacons_activated + 1${e}` +
	`      end${e}` +
	`    end${e}` +
	`  end${e}` +
	`  log(string.format("[Import] Phase 2 complete (tick %d): activated %d beacons. Inventory restore scheduled for tick %d.", game.tick, beacons_activated, game.tick + 1))${e}` +
	`  job.pending_finish_tick = game.tick + 1${e}` +
	`end${e}` +
	`${e}` +
	`--- Phase 3 of import completion: restore inventories, activate entities, restore fluids, validate.${e}` +
	`--- Called one tick after Phase 2 (beacon activation) so crafting_speed caps are correct.${e}` +
	`local function finish_import_job_phase3(job)`;

if (!content.includes(oldPhase2Header)) { console.error("oldPhase2Header not found"); process.exit(1); }
content = content.replace(oldPhase2Header, newPhase2Header);

// ── 3. Remove the old Step 6a beacon activation block from what is now Phase 3 ──
// The beacon block was: Step 6a + beacons_activated loop
const oldBeaconBlock =
	`  -- Step 6: Restore inventories.${e}` +
	`  -- CRITICAL: set_stack() ceiling = ingredient_amount \u00D7 quality_multiplier \u00D7 crafting_speed_factor.${e}` +
	`  -- crafting_speed is boosted by beacons. But beacons are placed in frozen/inactive state,${e}` +
	`  -- so their speed bonus does not apply until they are activated. We must activate beacons${e}` +
	`  -- BEFORE restoring inventories so the correct (boosted) crafting_speed cap is used.${e}` +
	`  -- Other machines (crushers, foundries) remain deactivated throughout \u2014 they cannot${e}` +
	`  -- consume items. Beacons are passive emitters with no item consumption.${e}` +
	`  -- Step 6a: Activate beacons so their speed bonus propagates to nearby machines.${e}` +
	`  local beacons_activated = 0${e}` +
	`  for _, entity_data in ipairs(entities_to_create) do${e}` +
	`    if entity_data and entity_data.entity_id then${e}` +
	`      local entity = entity_map[entity_data.entity_id]${e}` +
	`      if entity and entity.valid and entity.type == "beacon" then${e}` +
	`        entity.active = true${e}` +
	`        beacons_activated = beacons_activated + 1${e}` +
	`      end${e}` +
	`    end${e}` +
	`  end${e}` +
	`  if beacons_activated > 0 then${e}` +
	`    log(string.format("[Import] Activated %d beacons before inventory restore (crafting_speed bonus propagation)", beacons_activated))${e}` +
	`  end${e}` +
	`  -- Step 6b: Restore inventories with correct crafting_speed caps.${e}` +
	`  if not job.inventory_overflow_losses then`;

const newBeaconBlock =
	`  -- Step 6: Restore inventories.${e}` +
	`  -- Beacons were activated in Phase 2 (one tick ago) so crafting_speed caps are now correct.${e}` +
	`  if not job.inventory_overflow_losses then`;

if (!content.includes(oldBeaconBlock)) { console.error("oldBeaconBlock not found"); process.exit(1); }
content = content.replace(oldBeaconBlock, newBeaconBlock);

// ── 4. Update process_tick to handle pending_beacon_tick → Phase 2, pending_finish_tick → Phase 3 ──
const oldProcessBlock =
	`    elseif job.type == "import" then${e}` +
	`      if job.pending_finish_tick then${e}` +
	`        -- Phase 1 done; waiting one tick before inventory restore (ensures entity creation is fully committed).${e}` +
	`        if game.tick >= job.pending_finish_tick then${e}` +
	`          job.pending_finish_tick = nil${e}` +
	`          finish_import_job_phase2(job)${e}` +
	`          complete = true${e}` +
	`        end${e}` +
	`      else${e}` +
	`        complete = process_import_batch(job)${e}` +
	`        if complete then${e}` +
	`          finish_import_job(job)${e}` +
	`          complete = false  -- Phase 2 fires next tick; keep job alive${e}` +
	`        end${e}` +
	`      end`;

const newProcessBlock =
	`    elseif job.type == "import" then${e}` +
	`      if job.pending_finish_tick then${e}` +
	`        -- Phase 2 done (beacons activated); waiting one tick for crafting_speed caps to propagate.${e}` +
	`        if game.tick >= job.pending_finish_tick then${e}` +
	`          job.pending_finish_tick = nil${e}` +
	`          finish_import_job_phase3(job)${e}` +
	`          complete = true${e}` +
	`        end${e}` +
	`      elseif job.pending_beacon_tick then${e}` +
	`        -- Phase 1 done (entities placed); waiting one tick before beacon activation.${e}` +
	`        if game.tick >= job.pending_beacon_tick then${e}` +
	`          job.pending_beacon_tick = nil${e}` +
	`          finish_import_job_phase2(job)${e}` +
	`          complete = false  -- Phase 3 fires next tick; keep job alive${e}` +
	`        end${e}` +
	`      else${e}` +
	`        complete = process_import_batch(job)${e}` +
	`        if complete then${e}` +
	`          finish_import_job(job)${e}` +
	`          complete = false  -- Phase 2 fires next tick; keep job alive${e}` +
	`        end${e}` +
	`      end`;

if (!content.includes(oldProcessBlock)) { console.error("oldProcessBlock not found"); process.exit(1); }
content = content.replace(oldProcessBlock, newProcessBlock);

fs.writeFileSync(file, content);
console.log("Done");
console.log("phase2 fn defined:", content.includes("local function finish_import_job_phase2(job)"));
console.log("phase3 fn defined:", content.includes("local function finish_import_job_phase3(job)"));
console.log("pending_beacon_tick set:", content.includes("job.pending_beacon_tick = game.tick + 1"));
console.log("pending_finish_tick in phase2:", content.includes("job.pending_finish_tick = game.tick + 1"));
console.log("phase3 called in process_tick:", content.includes("finish_import_job_phase3(job)"));
