const fs = require("fs");
const file = "docker/seed-data/external_plugins/surface_export/module/core/async-processor.lua";
let content = fs.readFileSync(file, "utf8");
const e = "\r\n";

// Replace the Step 6 comment block + inventory loop preamble to add beacon activation first
const oldBlock =
	`  -- Step 6: Restore inventories \u2014 runs on NEXT TICK after all entities are placed.${e}` +
	`  -- CRITICAL: set_stack() ceiling = ingredient_amount \u00D7 quality_multiplier \u00D7 crafting_speed_factor.${e}` +
	`  -- crafting_speed is boosted by beacons, but beacon effects only propagate on the tick AFTER${e}` +
	`  -- the beacon entity is placed. Calling set_stack() in the same tick as entity creation still${e}` +
	`  -- sees the unmodified crafting_speed and hits the lower cap.${e}` +
	`  -- This function (finish_import_job_phase2) is called on tick N+1 so beacon effects are live.${e}` +
	`  -- Entities are still deactivated \u2014 machines cannot consume items during restoration.${e}` +
	`  if not job.inventory_overflow_losses then`;

if (!content.includes(oldBlock)) {
	console.error("oldBlock not found");
	console.error("Expected (JSON):", JSON.stringify(oldBlock));
	process.exit(1);
}

const newBlock =
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

content = content.replace(oldBlock, newBlock);
fs.writeFileSync(file, content);
console.log("Done");
console.log("beacon activation block present:", content.includes("Activated %d beacons before inventory restore"));
console.log("inventory_overflow_losses still present:", content.includes("inventory_overflow_losses"));
