local key = "__level__/modules/surface_export/import_phases/active_state_restoration.lua"
local active = assert(package.loaded[key], "active-state module not loaded")
local counter = assert(package.loaded["__level__/modules/surface_export/validators/cargo-counter.lua"])
assert(not game.surfaces[AUDIT_NAME], "fixture surface already exists")
local surface = game.create_surface(AUDIT_NAME, {width=32,height=32})
local ok, result = pcall(function()
    if INJECT_CLEANUP then error("injected construction stop") end
    local tiles = {}
    for x=-8,8 do for y=-8,8 do tiles[#tiles+1]={name="landfill",position={x,y}} end end
    surface.set_tiles(tiles)
    local function create(name,x,y)
        return assert(surface.create_entity{name=name,position={x,y},force="player"}, name.." creation failed")
    end
    local chest=create("steel-chest",-4,0)
    assert(chest.insert{name="iron-plate",count=10}==10)
    local awake=create("inserter",0,0)
    local asleep=create("inserter",3,0)
    awake.disabled_by_script=true
    asleep.disabled_by_script=true
    local tank=create("storage-tank",0,5)
    assert(tank.insert_fluid{name="water",amount=100}==100)
    local records={
        {entity_id=1,type="inserter",specific_data={held_item={name="iron-plate",quality="rare",count=1}}},
        {entity_id=2,type="inserter",specific_data={held_item={name="copper-plate",count=1}}},
    }
    local map={[1]=awake,[2]=asleep}
    local function oracle()
        return {
            chest=chest.get_item_count("iron-plate"),
            awake=awake.held_stack.valid_for_read and awake.held_stack.count or 0,
            awake_name=awake.held_stack.valid_for_read and awake.held_stack.name or "",
            awake_quality=awake.held_stack.valid_for_read and awake.held_stack.quality.name or "",
            asleep=asleep.held_stack.valid_for_read and asleep.held_stack.count or 0,
            water=tank.get_fluid_count("water"),
        }
    end
    local tick=game.tick
    local restored,failed=active.restore_held_items_only(records,map)
    assert(restored==2 and failed==0,"pre-validation held restoration failed")
    local before=oracle()
    assert(before.chest==10 and before.awake==1 and before.asleep==1 and before.water==100)
    assert(before.awake_name=="iron-plate" and before.awake_quality=="rare")
    local quantities=counter.count_all(surface)
    assert(quantities.item_total==12 and quantities.fluid_total==100)
    active.restore(records,map,{[1]=true,[2]=false})
    local after=oracle()
    for name,value in pairs(before) do assert(after[name]==value,"activation changed "..name) end
    assert(not awake.disabled_by_script and asleep.disabled_by_script,"activation policy not applied")
    assert(game.tick==tick,"unexpected simulation tick")
    -- A shortage is already visible to the original check; no activation/recount is needed.
    awake.held_stack.clear()
    local shortage=counter.count_all(surface)
    assert(shortage.item_total==11,"shortage control did not change cargo")
    return {success=true,before=before,after=after,shortage=shortage.item_total,tickStart=tick,tickEnd=game.tick}
end)
local deleted=game.delete_surface(surface)
assert(deleted,"cleanup was not queued")
if not ok then return {success=false,error=tostring(result),cleanupQueued=true} end
result.cleanupQueued=true
return result
