-- FactorioSurfaceExport - Entity Handlers
-- Per-entity-type serialization handlers

local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local Util = require("modules/surface_export/utils/util")
local GameUtils = require("modules/surface_export/utils/game-utils")

local EntityHandlers = {}

-- Flag: When true, belt handlers skip item extraction (for deferred atomic belt scan)
-- Set by AsyncProcessor during multi-tick export, cleared in complete_export_job
EntityHandlers.skip_belt_items = false

--- Attach ordinary inventories when a specialized handler does not own them.
--- @param entity LuaEntity
--- @param data table|nil
--- @return table
function EntityHandlers.attach_missing_inventories(entity, data)
  data = data or {}
  if data.inventories == nil then
    local inventories = InventoryScanner.extract_all_inventories(entity)
    if #inventories > 0 then
      data.inventories = inventories
    end
  end
  return data
end

--- Extract an entity's burner (fuel) energy-source state. Mirrors the equipment-burner capture in
--- inventory-scanner.lua (extract_equipment_grid) but ALSO records the burning item's quality, and
--- deliberately OMITS the fuel / burnt-result inventories: those are already exported as normal
--- entity inventories (defines.inventory.fuel / burnt_result), so re-capturing them here would
--- double-count the fuel items.
--- @param entity LuaEntity: an entity whose `.burner` is non-nil
--- @return table: { currently_burning = {name, quality}|nil, remaining_burning_fuel = number }
function EntityHandlers.extract_entity_burner(entity)
  local burner = entity.burner
  local currently_burning = nil
  local burning = burner.currently_burning
  if burning then
    -- 2.0.77: LuaBurner.currently_burning reads as an ItemIDAndQualityIDPair whose `.name` is a
    -- LuaItemPrototype and `.quality` a LuaQualityPrototype. Resolve both to plain strings (the only
    -- JSON-safe form); stay defensive if a build ever returns bare-string ids instead.
    local name = burning.name
    if type(name) ~= "string" and name then
      name = name.name
    end
    local quality = burning.quality
    if type(quality) ~= "string" and quality then
      quality = quality.name
    end
    currently_burning = {
      name = name,
      quality = quality or GameUtils.QUALITY_NORMAL
    }
  end
  return {
    currently_burning = currently_burning,
    remaining_burning_fuel = burner.remaining_burning_fuel
  }
end

--- Extract cross-cutting entity state (burner, energy buffer, heat buffer) that applies to ANY entity
--- regardless of category. Merges directly into `data` (the specific_data table being assembled) so a
--- single call in handle_entity covers every entity from BOTH export paths.
--- @param entity LuaEntity
--- @param data table: the specific_data table to populate in place
function EntityHandlers.extract_common_state(entity, data)
  -- BURNER (fuel) state — only the burning item + remaining-fuel scalar; the fuel/burnt inventories
  -- ride the normal inventory export. `.burner` is nil (never an error) on non-burner entities.
  if entity.burner then
    data.burner = EntityHandlers.extract_entity_burner(entity)
  end

  -- ENERGY BUFFER — accumulators ALWAYS (their stored charge is the whole point of the entity); any
  -- other entity only when it currently holds a positive buffer. Reading `.energy` throws on many
  -- prototypes that have no energy source, so probe.
  -- intentional probe; failure expected on entities without an energy buffer, no log
  local energy_ok, energy = pcall(function() return entity.energy end)
  if energy_ok and energy and (entity.type == "accumulator" or energy > 0) then
    data.energy = energy
  end

  -- ENTITY HEAT BUFFER — nuclear reactors, heat pipes, and heat-consuming machines expose
  -- `.temperature` (the entity's OWN heat buffer, NOT fluid temperature, which rides the fluidbox
  -- export path). Reading `.temperature` throws on entities without a heat energy source, so probe.
  -- intentional probe; failure expected on non-heat entities, no log
  local temp_ok, temperature = pcall(function() return entity.temperature end)
  if temp_ok and temperature ~= nil then
    data.temperature = temperature
  end

  -- BONUS PROGRESS — the banked productivity payout (0..1). Crafting machines, furnaces, labs and
  -- mining drills all expose it; captured HERE in the shared dispatcher so no specialized handler can
  -- silently drop the dimension (review finding: only the assembling-machine handler captured it, so a
  -- foundry/furnace lost its banked productivity bar on transfer). Reading may throw on categories
  -- without bonus production, so probe; 0 is the fresh-entity default, so only a positive value is
  -- meaningful. Restore rides the generic SIMPLE_RESTORE_RULES bonus_progress row (deserializer.lua).
  -- intentional probe; failure expected on entities without bonus production, no log
  local bp_ok, bonus_progress = pcall(function() return entity.bonus_progress end)
  if bp_ok and bonus_progress and bonus_progress > 0 then
    data.bonus_progress = bonus_progress
  end
end

--- Main dispatcher for entity-specific data extraction
--- @param entity LuaEntity: The entity to handle
--- @param category string: Entity category (from Util.get_entity_category)
--- @return table|nil: Entity-specific data, or nil if no special handling needed
function EntityHandlers.handle_entity(entity, category)
  local handler = EntityHandlers[category]
  local data
  if handler then
    data = handler(entity) or {}
  else
    data = {}

    -- Specialized fluid-capable platform entities own fluid extraction in their handlers.
    data.fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  end

  -- Ordinary inventories are attached exactly once whether or not a category handler exists.
  -- Specialized handlers that already use extract_all_inventories remain authoritative. This is the
  -- path that seats burner-inserter fuel inventories (#98 specialized-inventory fix); the burner STATE
  -- (currently_burning / remaining_burning_fuel) captured by extract_common_state complements it.
  data = EntityHandlers.attach_missing_inventories(entity, data)

  -- Cross-cutting entity state (burner / energy buffer / heat buffer / bonus progress) applies to ANY
  -- entity type regardless of category, so it is captured HERE in the shared dispatcher — both export
  -- paths (sync EntityScanner.scan_surface and async ExportPipeline.process_batch) route through
  -- EntityScanner.serialize_entity → handle_entity — rather than duplicated across every handler.
  EntityHandlers.extract_common_state(entity, data)

  if next(data) then
    return data
  end

  return nil
end

--- Assembling machine handler
EntityHandlers["assembling-machine"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Fluids (chemical plants, oil refineries, etc. all use assembling-machine type)
  data.fluidboxes = InventoryScanner.extract_fluidboxes(entity)

  -- Recipe
  if entity.get_recipe then
    local recipe = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name

      -- Capture recipe properties that affect inventory limits (for validation)
      -- overload_multiplier determines how many extra items inserters put in
      -- allow_inserter_overload determines if stack bonus applies
      local proto = recipe.prototype
      if proto then
        data.recipe_overload_multiplier = proto.overload_multiplier
        data.recipe_allow_inserter_overload = proto.allow_inserter_overload
      end
    end
  end

  -- RECIPE QUALITY — measured on 2.0.77 (state-dimensions-lab notebook, closer probe):
  -- LuaEntity.get_recipe_quality() does NOT exist (the old probe here silently never captured), and
  -- quality is get_recipe()'s SECOND return value. Restore passes it atomically via set_recipe(name, q).
  if entity.get_recipe then
    local _, recipe_quality = entity.get_recipe()
    if recipe_quality and recipe_quality.name ~= GameUtils.QUALITY_NORMAL then
      data.recipe_quality = recipe_quality.name
    end
  end

  -- Crafting progress
  if entity.crafting_progress then
    data.crafting_progress = entity.crafting_progress
  end

  -- Productivity bonus
  if entity.productivity_bonus then
    data.productivity_bonus = entity.productivity_bonus
  end

  -- (bonus_progress is captured for ALL categories by extract_common_state in the shared dispatcher.)

  return data
end

--- Furnace handler
EntityHandlers["furnace"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Fluids (foundries have fluidboxes for molten metals)
  data.fluidboxes = InventoryScanner.extract_fluidboxes(entity)

  -- Recipe (smelting recipe; quality is get_recipe()'s SECOND return at 2.0.77 — see the
  -- assembling-machine handler)
  if entity.get_recipe then
    local recipe, recipe_quality = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name

      -- Capture recipe properties that affect inventory limits (for validation)
      -- This is especially important for foundries which have complex recipes
      local proto = recipe.prototype
      if proto then
        data.recipe_overload_multiplier = proto.overload_multiplier
        data.recipe_allow_inserter_overload = proto.allow_inserter_overload
      end
    end
    if recipe_quality and recipe_quality.name ~= GameUtils.QUALITY_NORMAL then
      data.recipe_quality = recipe_quality.name
    end
  end

  -- Previous recipe (Factorio 2.0+ - for foundries and other furnaces)
  if entity.previous_recipe then
    data.previous_recipe = {
      name = entity.previous_recipe.name,
      quality = entity.previous_recipe.quality and entity.previous_recipe.quality.name or GameUtils.QUALITY_NORMAL
    }
  end

  -- Smelting progress
  if entity.crafting_progress then
    data.crafting_progress = entity.crafting_progress
  end

  return data
end

--- Transport belt handler
EntityHandlers["transport-belt"] = function(entity)
  return {
    -- Belt items are deferred to atomic scan pass when skip_belt_items is set
    items = EntityHandlers.skip_belt_items and {} or InventoryScanner.extract_belt_items(entity)
  }
end

--- Underground belt handler
EntityHandlers["underground-belt"] = function(entity)
  local data = {
    -- Belt items are deferred to atomic scan pass when skip_belt_items is set
    items = EntityHandlers.skip_belt_items and {} or InventoryScanner.extract_belt_items(entity),
    belt_to_ground_type = entity.belt_to_ground_type  -- "input" or "output"
  }

  -- Connection partner (for verification)
  if entity.neighbours then
    data.has_partner = true
  end

  return data
end

--- Splitter handler
EntityHandlers["splitter"] = function(entity)
  local data = {
    -- Belt items are deferred to atomic scan pass when skip_belt_items is set
    items = EntityHandlers.skip_belt_items and {} or InventoryScanner.extract_belt_items(entity)
  }

  -- Filter settings — capture quality too ({name,quality} table; the deserializer's splitter rule
  -- assigns either shape directly, and legacy name-string exports still restore).
  if entity.splitter_filter then
    -- 2.0.77: splitter_filter.quality reads as a plain STRING (measured live); stay defensive if a
    -- build returns a LuaQualityPrototype instead — resolve either shape to the JSON-safe string.
    local sf = entity.splitter_filter
    local quality = sf.quality
    if type(quality) ~= "string" and quality then
      quality = quality.name
    end
    data.filter = { name = sf.name, quality = quality or GameUtils.QUALITY_NORMAL }
  end

  -- Input/output priority
  if entity.splitter_input_priority then
    data.input_priority = entity.splitter_input_priority
  end
  if entity.splitter_output_priority then
    data.output_priority = entity.splitter_output_priority
  end

  return data
end

--- Inserter handler
EntityHandlers["inserter"] = function(entity)
  local data = {}

  -- Held item (if any)
  data.held_item = InventoryScanner.extract_inserter_held_item(entity)

  -- Pickup and drop positions
  data.pickup_position = Util.round_position(entity.pickup_position, 2)
  data.drop_position = Util.round_position(entity.drop_position, 2)

  -- Filter mode (whitelist/blacklist)
  if entity.inserter_filter_mode then
    data.filter_mode = entity.inserter_filter_mode  -- "whitelist" or "blacklist"
  end
  
  -- USE FILTERS flag - Whether filtering is enabled/active
  data.use_filters = GameUtils.safe_get(entity, "use_filters")

  -- Stack size override (0 = no override)
  if entity.inserter_stack_size_override and entity.inserter_stack_size_override > 0 then
    data.stack_size_override = entity.inserter_stack_size_override
  end

  -- Spoil priority (Factorio 2.0 Space Age)
  if entity.inserter_spoil_priority then
    data.spoil_priority = entity.inserter_spoil_priority  -- "spoiled-first", "fresh-first", "any"
  end

  return data
end

--- Container (chest) handler
EntityHandlers["container"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- BAR position (inventory limit)
  local bar_success, bar = pcall(function() 
    local inv = entity.get_inventory(defines.inventory.chest)
    return inv and inv.valid and inv.get_bar() or nil
  end)
  if not bar_success then log(string.format("[entity-handlers] read container bar failed on %s: %s", entity.name, tostring(bar))) end
  if bar_success and bar and bar < 65535 then  -- 65535 is "no bar"
    data.bar = bar
  end
  
  return data
end

--- Fluid storage (tanks) handler
EntityHandlers["fluid-storage"] = function(entity)
  return {
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }
end

--- Pipe handler
EntityHandlers["pipe"] = function(entity)
  return {
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }
end

--- Underground pipe handler
EntityHandlers["pipe-to-ground"] = function(entity)
  return {
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }
end

--- Pump handler
EntityHandlers["pump"] = function(entity)
  local data = {
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }
  
  -- FLUID FILTER
  -- intentional probe; failure expected, no log
  local filter_success, fluid_filter = pcall(function() return entity.get_fluid_filter() end)
  if filter_success and fluid_filter then
    data.fluid_filter = fluid_filter.name
  end
  
  return data
end

--- Train (locomotive/wagon) handler
EntityHandlers["train"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Train schedule (only for locomotives)
  if entity.train and entity.type:find("locomotive") then
    data.schedule = entity.train.schedule
  end

  -- Orientation
  if entity.orientation then
    data.orientation = entity.orientation
  end

  -- Train ID (for matching during import)
  if entity.train then
    data.train_id = entity.train.id
  end
  
  -- COLOR (locomotives and wagons)
  data.color = GameUtils.extract_color(entity)
  
  -- ENABLE LOGISTICS WHILE MOVING (locomotives and wagons)
  data.enable_logistics_while_moving = GameUtils.safe_get(entity, "enable_logistics_while_moving")
  
  -- COPY COLOR FROM TRAIN STOP (locomotives and wagons)
  data.copy_color_from_train_stop = GameUtils.safe_get(entity, "copy_color_from_train_stop")

  -- Equipment grid (locomotives can have equipment in Space Age)
  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end

  return data
end

--- Car/Tank handler
EntityHandlers["car"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Equipment grid (cars and tanks can have equipment grids)
  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end
  
  -- ENABLE LOGISTICS WHILE MOVING
  data.enable_logistics_while_moving = GameUtils.safe_get(entity, "enable_logistics_while_moving")
  
  -- DRIVER IS MAIN GUNNER
  data.driver_is_main_gunner = GameUtils.safe_get(entity, "driver_is_main_gunner")
  
  -- SELECTED GUN INDEX
  -- intentional probe; failure expected, no log
  local gun_success, selected_gun_index = pcall(function() return entity.selected_gun_index end)
  if gun_success and selected_gun_index then
    data.selected_gun_index = selected_gun_index
  end
  
  -- ORIENTATION
  if entity.orientation then
    data.orientation = entity.orientation
  end
  
  -- COLOR
  data.color = GameUtils.extract_color(entity)

  return data
end

--- Spider vehicle (Spidertron) handler
EntityHandlers["spider-vehicle"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }

  -- Equipment grid (spidertrons always have equipment grids)
  if entity.grid and entity.grid.valid and #entity.grid.equipment > 0 then
    data.equipment_grid = InventoryScanner.extract_equipment_grid(entity.grid)
  end

  -- Autopilot destination
  if entity.autopilot_destination then
    data.autopilot_destination = entity.autopilot_destination
  end
  
  -- AUTOMATIC TARGETING PARAMETERS (critical for combat configuration)
  -- intentional probe; failure expected, no log
  local targeting_success, auto_targeting = pcall(function() return entity.vehicle_automatic_targeting_parameters end)
  if targeting_success and auto_targeting then
    data.automatic_targeting_parameters = {
      auto_targeting_without_gunner = auto_targeting.auto_targeting_without_gunner,
      auto_targeting_with_gunner = auto_targeting.auto_targeting_with_gunner
    }
  end
  
  -- SELECTED GUN INDEX
  -- intentional probe; failure expected, no log
  local gun_success, selected_gun_index = pcall(function() return entity.selected_gun_index end)
  if gun_success and selected_gun_index then
    data.selected_gun_index = selected_gun_index
  end
  
  -- DRIVER IS MAIN GUNNER
  data.driver_is_main_gunner = GameUtils.safe_get(entity, "driver_is_main_gunner")
  
  -- ENABLE LOGISTICS WHILE MOVING
  data.enable_logistics_while_moving = GameUtils.safe_get(entity, "enable_logistics_while_moving")
  
  -- COLOR
  data.color = GameUtils.extract_color(entity)
  
  -- LABEL (spider name)
  -- intentional probe; failure expected, no log
  local label_success, label = pcall(function() return entity.label end)
  if label_success and label and label ~= "" then
    data.label = label
  end

  return data
end

--- Combinator handler
EntityHandlers["combinator"] = function(entity)
  local data = {}
  
  -- PLAYER DESCRIPTION (user-set description for arithmetic/decider/selector combinators)
  -- intentional probe; failure expected, no log
  local desc_success, description = pcall(function() return entity.entity_description end)
  if desc_success and description and description ~= "" then
    data.player_description = description
  end

  local cb = entity.get_control_behavior()
  if cb then
    -- Try to get parameters (exists for arithmetic/decider combinators, not constant)
    -- intentional probe; failure expected, no log
    local success, params = pcall(function() return cb.parameters end)
    if success and params then
      data.parameters = params
    end

    -- Other combinator types can be added here
  end

  return data
end

--- Turret handler
-- Factorio 2.0 turret priority targeting API:
-- LuaEntity properties:
--   - priority_targets (read-only array[LuaEntityPrototype]): current priority list
--   - get_priority_target(index) -> LuaEntityPrototype?: read single entry
--   - set_priority_target(index, entity_id?): write single entry
--   - ignore_unprioritised_targets (RW boolean): whether to only shoot prioritised targets
-- LuaTurretControlBehavior (circuit control):
--   - set_priority_list (boolean): enables circuit-controlled priorities from signals
--   - set_ignore_unlisted_targets (boolean): enables ignoring unlisted targets via circuit
--   - ignore_unlisted_targets_condition: circuit condition for ignoring
--   - read_ammo (boolean): turret sends ammo count to circuit network
EntityHandlers["turret"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- Priority targets (entity's own priority list - not circuit controlled)
  -- intentional probe; failure expected, no log
  local priority_success, priority_targets = pcall(function() return entity.priority_targets end)
  if priority_success and priority_targets and #priority_targets > 0 then
    data.priority_targets = {}
    for i, target_proto in ipairs(priority_targets) do
      table.insert(data.priority_targets, {
        index = i,
        name = target_proto.name
      })
    end
  end
  
  -- Whether turret ignores non-prioritised targets
  data.ignore_unprioritised_targets = GameUtils.safe_get(entity, "ignore_unprioritised_targets")
  
  -- Turret control behavior (circuit-controlled targeting)
  local cb = entity.get_control_behavior()
  if cb then
    -- Circuit conditions for ignoring unlisted targets
    -- intentional probe; failure expected, no log
    local success, ignore_condition = pcall(function() return cb.ignore_unlisted_targets_condition end)
    if success and ignore_condition then
      data.ignore_unlisted_targets_condition = ignore_condition
    end
    
    -- Whether to ignore unlisted targets based on circuit
    -- intentional probe; failure expected, no log
    local success2, set_ignore = pcall(function() return cb.set_ignore_unlisted_targets end)
    if success2 and set_ignore then
      data.set_ignore_unlisted_targets = set_ignore
    end
    
    -- Whether to set priority list from circuit signals
    -- intentional probe; failure expected, no log
    local success3, set_priority = pcall(function() return cb.set_priority_list end)
    if success3 and set_priority then
      data.set_priority_list = set_priority
    end
    
    -- Read ammo to circuit
    -- intentional probe; failure expected, no log
    local success4, read_ammo = pcall(function() return cb.read_ammo end)
    if success4 and read_ammo then
      data.read_ammo = read_ammo
    end
  end
  
  return data
end

--- Resource handler (ore patches on platform/surface fixtures): the ONLY state a resource carries
--- is its remaining amount — without it, import recreates the patch at the engine default
--- (50/tile; the mining-drill-acid-feed pad measured 30398 -> 200 on paste, 2026-07-20).
EntityHandlers["resource"] = function(entity)
  return { amount = entity.amount }
end

--- Mining drill handler
EntityHandlers["mining-drill"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity),
    -- fluids: acid-fed drills (big mining drill on uranium) hold sulfuric acid in a fluidbox.
    -- Pitfall #18 class (a specific handler that only exports inventories silently drops fluid
    -- data); caught live 2026-07-20 by the mining-drill-acid-feed pad audit (paste lost exactly
    -- the drill's 104.4 acid).
    fluidboxes = InventoryScanner.extract_fluidboxes(entity)
  }

  -- Mining target
  if entity.mining_target then
    data.mining_target = {
      name = entity.mining_target.name,
      position = Util.round_position(entity.mining_target.position, 2)
    }
  end

  -- Drop target (output position)
  if entity.drop_target then
    data.drop_target = Util.round_position(entity.drop_target.position, 2)
  end
  
  -- FILTER (resource filter for mining drills). Measured 2026-07-17 at 2.0.77 (see the
  -- mining-drill filter entry in docs/factorio-2.0-api-notes.md): get_filter REQUIRES the slot
  -- index (the old zero-arg call ALWAYS threw, silently killing this capture), every vanilla
  -- drill has filter_slot_count == 0 (only modded drills can reach the read), and a drill
  -- filter is an EntityID — no quality component. Resolve string/prototype shapes defensively.
  if (entity.filter_slot_count or 0) > 0 then
    local filter_success, filter = pcall(function() return entity.get_filter(1) end)
    if not filter_success then
      log(string.format("[EntityHandlers] mining-drill get_filter(1) failed on %s: %s",
        entity.name, tostring(filter)))
    elseif filter then
      local name = filter
      if type(name) ~= "string" then
        name = filter.name
        if type(name) ~= "string" and name then name = name.name end
      end
      if name then
        data.filter = { name = name }
      end
    end
  end

  return data
end

--- Lab handler
EntityHandlers["lab"] = function(entity)
  return {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
end

--- Roboport handler
EntityHandlers["roboport"] = function(entity)
  return {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
end

--- Artillery turret handler
EntityHandlers["artillery-turret"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- ARTILLERY AUTO TARGETING
  data.artillery_auto_targeting = GameUtils.safe_get(entity, "artillery_auto_targeting")
  
  return data
end

EntityHandlers["rocket-silo"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- RECIPE (+ quality — get_recipe()'s SECOND return at 2.0.77; get_recipe_quality() does not exist,
  -- so the old probe here silently never captured quality. See the assembling-machine handler.)
  if entity.get_recipe then
    local recipe, recipe_quality = entity.get_recipe()
    if recipe then
      data.recipe = recipe.name
    end
    if recipe_quality and recipe_quality.name ~= GameUtils.QUALITY_NORMAL then
      data.recipe_quality = recipe_quality.name
    end
  end

  -- Rocket parts
  if entity.rocket_parts then
    data.rocket_parts = entity.rocket_parts
  end

  -- Auto-launch setting
  if entity.auto_launch ~= nil then
    data.auto_launch = entity.auto_launch
  end

  return data
end

--- Gate handler
EntityHandlers["gate"] = function(entity)
  local data = {}
  
  -- Gate open state
  if entity.opened ~= nil then
    data.opened = entity.opened
  end
  
  return next(data) and data or nil
end

--- Power switch handler
EntityHandlers["power-switch"] = function(entity)
  local data = {}
  
  -- SWITCH STATE (on/off)
  data.switch_state = GameUtils.safe_get(entity, "power_switch_state")
  
  return next(data) and data or nil
end

--- Agricultural tower handler (Space Age)
EntityHandlers["agricultural-tower"] = function(entity)
  local data = {
    inventories = InventoryScanner.extract_all_inventories(entity)
  }
  
  -- Planting position
  if entity.planting_position then
    data.planting_position = entity.planting_position
  end
  
  return data
end

--- Programmable speaker handler
EntityHandlers["programmable-speaker"] = function(entity)
  local data = {}
  
  -- Control behavior will be captured by ConnectionScanner
  -- but we can add any speaker-specific state here
  
  return next(data) and data or nil
end

--- Lamp handler
EntityHandlers["lamp"] = function(entity)
  local data = {}
  
  -- COLOR
  data.color = GameUtils.extract_color(entity)
  
  -- ALWAYS ON setting
  data.always_on = GameUtils.safe_get(entity, "always_on")
  
  -- Control behavior (use_colors) will be captured by ConnectionScanner
  
  return next(data) and data or nil
end

--- Entity ghost handler (blueprinted entities not yet built)
EntityHandlers["entity-ghost"] = function(entity)
  local data = {
    ghost_name = entity.ghost_name,
    ghost_type = entity.ghost_type
  }
  
  -- Capture item requests for this ghost. 2.0 shape: ARRAY of ItemWithQualityCount
  -- ({name, quality, count}) — same 1.1-era dict-iteration defect as the item-request-proxy
  -- handler (fixed together, 2026-07-17, caught by the selection-lab drive battery).
  if entity.item_requests then
    data.item_requests = {}
    for _, req in pairs(entity.item_requests) do
      table.insert(data.item_requests, {
        item = req.name,
        quality = req.quality,
        count = req.count
      })
    end
  end

  -- Ghost quality
  if entity.quality and entity.quality.name ~= GameUtils.QUALITY_NORMAL then
    data.ghost_quality = entity.quality.name
  end
  
  return data
end

--- Tile ghost handler (blueprinted tiles not yet placed)
EntityHandlers["tile-ghost"] = function(entity)
  local data = {
    ghost_name = entity.ghost_name
  }
  
  -- Tile ghosts don't have as many properties as entity ghosts
  -- but we still need the ghost_name to recreate them
  
  return data
end

--- Item request proxy handler (construction material requests)
EntityHandlers["item-request-proxy"] = function(entity)
  local data = {}
  
  -- Capture item requests. 2.0 shape: item_requests is an ARRAY of ItemWithQualityCount
  -- ({name, quality, count}) — the old 1.1 dict iteration ({item_with_quality -> count}) indexed
  -- the array KEY (a number) and crashed serialize_entity on every proxy (caught 2026-07-17 by the
  -- selection-lab drive battery on the state fixture).
  if entity.item_requests then
    data.item_requests = {}
    for _, req in pairs(entity.item_requests) do
      table.insert(data.item_requests, {
        item = req.name,
        quality = req.quality,
        count = req.count
      })
    end
  end
  
  -- Capture insert plan (inventory positions for items)
  if entity.insert_plan and #entity.insert_plan > 0 then
    data.insert_plan = entity.insert_plan
  end
  
  -- Target entity position + NAME (the entity this proxy is for). The name lets the import
  -- resolver verify identity instead of taking the first bbox-intersecting neighbor (review F2,
  -- 2026-07-19); position alone is ambiguous when the true target failed to place.
  if entity.proxy_target and entity.proxy_target.valid then
    data.target_position = Util.round_position(entity.proxy_target.position, 2)
    data.target_name = entity.proxy_target.name
  end
  
  return next(data) and data or nil
end

--- Display panel handler (text + control-behavior messages + visibility flags). Without this
--- handler the default path exported only inventories/fluids (a panel has neither), so EVERY
--- transferred display panel arrived blank/unconfigured — measured 2026-07-19 on the delivered
--- pad platform (description text len=0, status messages 1/3, both flags cleared).
EntityHandlers["display-panel"] = function(entity)
  local data = {}
  data.display_panel_text = entity.display_panel_text
  data.display_panel_always_show = entity.display_panel_always_show
  data.display_panel_show_in_chart = entity.display_panel_show_in_chart
  local behavior = entity.get_control_behavior()
  if behavior and behavior.messages and #behavior.messages > 0 then
    data.display_panel_messages = behavior.messages
  end
  return next(data) and data or nil
end

--- Train stop handler
EntityHandlers["train-stop"] = function(entity)
  local data = {}
  
  -- Station name (already captured in entity_data.backer_name by entity-scanner)
  
  -- COLOR
  data.color = GameUtils.extract_color(entity)
  
  -- MANUAL TRAINS LIMIT
  -- intentional probe; failure expected, no log
  local limit_success, trains_limit = pcall(function() return entity.trains_limit end)
  if limit_success and trains_limit then
    data.manual_trains_limit = trains_limit
  end
  
  -- PRIORITY
  -- intentional probe; failure expected, no log
  local priority_success, priority = pcall(function() return entity.priority end)
  if priority_success and priority then
    data.priority = priority
  end
  
  return next(data) and data or nil
end

return EntityHandlers
