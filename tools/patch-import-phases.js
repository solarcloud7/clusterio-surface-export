const fs = require("fs");

const file = "docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua";
let content = fs.readFileSync(file, "utf8");
const EOL = "\r\n";
const e = EOL;

function lines(...args) { return args.join(e); }

// ── 1. Rename function definition ────────────────────────────────────────────
content = content.replace(
	`local function complete_import_job(job)${e}`,
	`local function finish_import_job(job)${e}`
);

// ── 2. Fix the log line at the start ─────────────────────────────────────────
content = content.replace(
	`log("[Import] Starting post-processing (hub inventories, fluids, belts, control behavior, filters, connections)...")${e}`,
	`log("[Import] Phase 1 post-processing: hub inventories, belts, entity state...")${e}`
);

// ── 3. Update Step 6 comment ─────────────────────────────────────────────────
const oldStep6 = [
	`  -- Step 6: Restore inventories AFTER all entities are placed.`,
	`  -- CRITICAL: set_stack() ceiling = ingredient_amount × quality_multiplier × crafting_speed_factor.`,
	`  -- crafting_speed is boosted by beacons. Restoring per-entity during async creation means`,
	`  -- beacons may not yet exist → low crafting_speed → low set_stack() cap → items silently lost.`,
	`  -- All entities (including beacons) are now placed and their effects propagated, so caps are correct.`,
	`  -- Entities are still deactivated at this point — machines cannot consume items during restoration.`,
].join(e);

const newStep6 = [
	`  -- Step 6: Restore inventories — runs on NEXT TICK after all entities are placed.`,
	`  -- CRITICAL: set_stack() ceiling = ingredient_amount × quality_multiplier × crafting_speed_factor.`,
	`  -- crafting_speed is boosted by beacons, but beacon effects only propagate on the tick AFTER`,
	`  -- the beacon entity is placed. Calling set_stack() in the same tick as entity creation still`,
	`  -- sees the unmodified crafting_speed and hits the lower cap.`,
	`  -- This function (finish_import_job_phase2) is called on tick N+1 so beacon effects are live.`,
	`  -- Entities are still deactivated — machines cannot consume items during restoration.`,
].join(e);

if (!content.includes(oldStep6)) { console.error("Step 6 comment not found"); process.exit(1); }
content = content.replace(oldStep6, newStep6);

// ── 4. Split Phase 1 / Phase 2 ───────────────────────────────────────────────
// After entity state restoration, end Phase 1 and start finish_import_job_phase2
const splitMarker = `  job.metrics.circuits_connected = state_result and state_result.circuits_connected or 0${e}${e}  -- Step 6:`;
const splitReplacement = [
	`  job.metrics.circuits_connected = state_result and state_result.circuits_connected or 0`,
	``,
	`  -- Phase 1 complete: schedule Phase 2 for next tick so beacon effects have propagated.`,
	`  -- Beacon speed bonuses apply on the tick AFTER the beacon is placed; set_stack() called`,
	`  -- in the same tick as entity creation sees the unmodified crafting_speed (lower cap).`,
	`  job.pending_finish_tick = game.tick + 1`,
	`  log(string.format("[Import] Phase 1 complete (tick %d). Inventory restoration deferred to tick %d (beacon propagation)", game.tick, job.pending_finish_tick))`,
	`end`,
	``,
	`--- Phase 2 of import completion: restore inventories, activate entities, restore fluids, validate.`,
	`--- Called one tick after finish_import_job (Phase 1) so beacon crafting_speed bonuses are active.`,
	`local function finish_import_job_phase2(job)`,
	`  job.metrics = job.metrics or {}`,
	`  local entity_map = job.entity_map or {}`,
	`  local entities_to_create = job.entities_to_create or {}`,
	``,
	`  -- Step 6:`,
].join(e);

if (!content.includes(splitMarker)) { console.error("splitMarker not found"); process.exit(1); }
content = content.replace(splitMarker, splitReplacement);

// ── 5. Update process_tick call site ─────────────────────────────────────────
const oldProcessBlock = [
	`    elseif job.type == "import" then`,
	`      complete = process_import_batch(job)`,
	`      if complete then`,
	`        complete_import_job(job)`,
	`      end`,
].join(e);

const newProcessBlock = [
	`    elseif job.type == "import" then`,
	`      if job.pending_finish_tick then`,
	`        -- Phase 1 done; waiting one tick for beacon effect propagation before inventory restore.`,
	`        if game.tick >= job.pending_finish_tick then`,
	`          job.pending_finish_tick = nil`,
	`          finish_import_job_phase2(job)`,
	`          complete = true`,
	`        end`,
	`      else`,
	`        complete = process_import_batch(job)`,
	`        if complete then`,
	`          finish_import_job(job)`,
	`          complete = false  -- Phase 2 fires next tick; keep job alive`,
	`        end`,
	`      end`,
].join(e);

if (!content.includes(oldProcessBlock)) { console.error("process_tick block not found"); process.exit(1); }
content = content.replace(oldProcessBlock, newProcessBlock);

fs.writeFileSync(file, content);
console.log("Done");

// Validate
const fnCheck = content.indexOf("local function finish_import_job(job)");
const fn2Check = content.indexOf("local function finish_import_job_phase2(job)");
const pendingCheck = content.indexOf("job.pending_finish_tick = game.tick + 1");
const phaseCheck = content.indexOf("if job.pending_finish_tick then");
console.log("finish_import_job at char:", fnCheck, fnCheck !== -1 ? "OK" : "MISSING");
console.log("finish_import_job_phase2 at char:", fn2Check, fn2Check !== -1 ? "OK" : "MISSING");
console.log("pending_finish_tick set at char:", pendingCheck, pendingCheck !== -1 ? "OK" : "MISSING");
console.log("pending_finish_tick check at char:", phaseCheck, phaseCheck !== -1 ? "OK" : "MISSING");
