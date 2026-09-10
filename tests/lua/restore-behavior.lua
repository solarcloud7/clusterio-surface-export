local root = "docker/seed-data/external_plugins/surface_export/module/"
package.preload["modules/surface_export/utils/util"] = function() return { QUALITY_NORMAL = "normal" } end
package.preload["modules/surface_export/export_scanners/inventory-scanner"] = function() return {} end
package.preload["modules/surface_export/import_phases/connection_restoration"] = function()
  return dofile(root .. "import_phases/connection_restoration.lua")
end

defines = {
  inventory = { chest = 1 },
  wire_connector_id = { pole_copper = 1 },
  wire_origin = { player = 11, script = 22 },
}
local logs = {}
function log(message) logs[#logs + 1] = message end
local Deserializer = dofile(root .. "core/deserializer.lua")
local passed = 0
local function test(name, run)
  logs = {}
  local ok, err = xpcall(run, debug.traceback)
  if not ok then error(name .. ": " .. tostring(err)) end
  passed = passed + 1
  print("PASS " .. name)
end
local function logged(text)
  for _, message in ipairs(logs) do if message:find(text, 1, true) then return true end end
  return false
end
local function entity(kind, id)
  return { valid = true, type = kind, name = kind, unit_number = id, position = { x = id or 0, y = 0 } }
end

test("inventory lookup failure is logged and later fields still restore", function()
  local chest = entity("container", 1)
  chest.get_inventory = function() error("lookup refused") end
  chest.set_fluid_filter = function(value) chest.seen_filter = value end
  Deserializer.restore_entity_state(chest, { specific_data = { bar = 7, fluid_filter = "water" } })
  assert(logged("lookup refused"))
  assert(chest.seen_filter == "water")
end)

test("inventory bar write failure is isolated", function()
  local chest = entity("container", 1)
  chest.get_inventory = function(index)
    assert(index == defines.inventory.chest)
    return { valid = true, set_bar = function() error("bar refused") end }
  end
  Deserializer.restore_entity_state(chest, { specific_data = { bar = 7 } })
  assert(logged("bar refused"))
end)

test("inventory bar restores its exact value and ignores absent inventories", function()
  local chest = entity("container", 1)
  local written
  chest.get_inventory = function() return { valid = true, set_bar = function(value) written = value end } end
  Deserializer.restore_entity_state(chest, { specific_data = { bar = 7 } })
  assert(written == 7)
  chest.get_inventory = function() return nil end
  Deserializer.restore_entity_state(chest, { specific_data = { bar = 9 } })
  assert(written == 7)
  assert(#logs == 0)
end)

test("one rejected display property does not prevent later false values restoring", function()
  local panel = setmetatable(entity("display-panel", 1), {
    __newindex = function(self, key, value)
      if key == "display_panel_text" then error("text refused") end
      rawset(self, key, value)
    end,
  })
  Deserializer.restore_entity_state(panel, { specific_data = {
    display_panel_text = "test", display_panel_always_show = false, display_panel_show_in_chart = true,
  } })
  assert(logged("text refused"))
  assert(panel.display_panel_always_show == false)
  assert(panel.display_panel_show_in_chart == true)
end)

test("circuit replay uses both connector IDs and continues after a failed connection", function()
  local source, target = entity("constant-combinator", 1), entity("arithmetic-combinator", 2)
  local calls = 0
  local target_connector = {}
  target.get_wire_connector = function(id, create) assert(id == 9 and create); return target_connector end
  source.get_wire_connector = function(id, create)
    assert(id == 4 and create)
    return { connect_to = function(other, check_reach)
      assert(other == target_connector and check_reach == false)
      calls = calls + 1
      if calls == 1 then error("wire refused") end
      return true
    end }
  end
  local wire = { source_circuit_id = 4, target_circuit_id = 9, target_entity_id = 2 }
  assert(Deserializer.restore_circuit_connections(source, { circuit_connections = { wire, wire } }, { [2] = target }) == 1)
  assert(calls == 2 and logged("wire refused"))
end)

test("position fallback resolves an unnumbered target and missing targets are skipped", function()
  local source, target = entity("constant-combinator", 1), entity("constant-combinator", 2)
  target.position = { x = -2.5, y = 7.25 }
  local connector = {}
  target.get_wire_connector = function() return connector end
  source.get_wire_connector = function() return { connect_to = function(other) assert(other == connector); return true end } end
  local data = { circuit_connections = {
    { target_entity_id = "pos_-2.5_7.25" }, { target_entity_id = "missing" },
  } }
  assert(Deserializer.restore_circuit_connections(source, data, { target }) == 1)
  assert(logged("Could not find target entity missing"))
  source.valid = false
  assert(Deserializer.restore_circuit_connections(source, data, { target }) == 0)
end)

local function pole(id, ghost)
  local pole_entity = entity(ghost and "entity-ghost" or "electric-pole", id)
  pole_entity.ghost_type = ghost and "electric-pole" or nil
  local connector = { owner = pole_entity, is_ghost = ghost or false, real_connections = {}, connections = {} }
  pole_entity.get_wire_connector = function() return connector end
  return pole_entity, connector
end

for _, ghost in ipairs({ false, true }) do
  test((ghost and "ghost" or "real") .. " copper prune preserves payload and outside peers and removes both origins", function()
    local source, connector = pole(1, ghost)
    local wanted, wanted_connector = pole(2, ghost)
    local extra, extra_connector = pole(3, ghost)
    local outside, outside_connector = pole(4, ghost)
    local wires = { { target = wanted_connector }, { target = extra_connector }, { target = outside_connector } }
    if ghost then connector.connections = wires else connector.real_connections = wires end
    local origins = {}
    connector.disconnect_from = function(target, origin)
      assert(target == extra_connector)
      origins[origin] = (origins[origin] or 0) + 1
      return true
    end
    local data = { entity_id = 1, circuit_connections = {
      { source_circuit_id = 1, target_circuit_id = 1, target_entity_id = 2 },
    } }
    assert(Deserializer.prune_pole_copper({ data }, { source, wanted, extra }) == 2)
    assert(origins[11] == 1 and origins[22] == 1)
    assert(outside.valid)
  end)
end

test("constant combinator logistic filter metadata survives capture and restoration", function()
  package.preload["modules/surface_export/utils/game-utils"] = function()return {} end
  local Scanner = dofile(root .. "export_scanners/connection-scanner.lua")
  for _, location in ipairs({"vulcanus", {name="vulcanus"}}) do
    local input = {value={name="turbo-transport-belt",quality="normal",comparator="="},
      min=250,max=500,import_from=location,minimum_delivery_count=20,request_from="planet"}
    local source = entity("constant-combinator", 1)
    source.get_control_behavior = function() return {sections={{group="",active=false,multiplier=3,filters_count=1,get_slot=function()return input end}}} end
    local captured = Scanner.extract_control_behavior(source)
    local filter = captured.constant_sections[1].filters[1]
    assert(filter.import_from=="vulcanus" and filter.minimum_delivery_count==20 and filter.request_from=="planet")
    local written, written_section
    local destination = entity("constant-combinator",2)
    destination.get_or_create_control_behavior = function()
      return {sections={},add_section=function()
        written_section={set_slot=function(index,value)assert(index==1);written=value end}
        return written_section
      end}
    end
    Deserializer.restore_control_behavior(destination,{control_behavior=captured})
    assert(written.import_from=="vulcanus" and written.minimum_delivery_count==20 and written.request_from=="planet")
    assert(written.min==250 and written.max==500 and written.value.name=="turbo-transport-belt")
    assert(written_section.active==false and written_section.multiplier==3)
    assert(#logs==0)
  end
end)

print(string.format("Lua restore behavior: %d/%d passed", passed, passed))
