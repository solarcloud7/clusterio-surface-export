local fixture = helpers.json_to_table([=[__FIXTURE__]=])
local token, name, mode, case, selected, target = "__TOKEN__", "__NAME__", "__MODE__", "__CASE__", "__SELECTED__", "__TARGET__"
local key = "__belt_capture_experiment"
assert(script.active_mods.base == fixture.engine, "engine pin mismatch")
local function cleanup()
    local state = storage[key]
    if state then assert(state.token == token and state.name == name, "foreign experiment ownership") end
    local surface = game.surfaces[name]
    if surface then assert(state, "surface without owned experiment state"); assert(game.delete_surface(surface), "surface deletion failed") end
    if state then storage[key] = nil end
    return {surfaceAbsent=game.surfaces[name] == nil, storageAbsent=storage[key] == nil, paused=game.tick_paused}
end
if mode == "cleanup" then return cleanup() end
local clock = helpers.create_profiler()
local ok, result = pcall(function()
    assert(not game.tick_paused and #game.connected_players == 0, "simulation paused or player joined")
    assert(table_size(storage.async_jobs or {}) == 0 and table_size(storage.locked_platforms or {}) == 0, "transfer work started")
    local state = storage[key]
    if mode == "setup" or mode == "inject" then
        assert(not state and not game.surfaces[name], "experiment already exists")
        for n in pairs(game.surfaces) do assert(type(n) ~= "string" or not n:find("belt-capture-",1,true), "foreign lab surface") end
        state = {token=token,name=name,case=case}
        storage[key] = state
        local surface = game.create_surface(name, {width=32,height=32})
        if mode == "inject" then error("injected construction failure") end
        surface.request_to_generate_chunks({0,0},0)
        surface.force_generate_chunk_requests()
        local tiles = {}
        for x=0,15 do for y=0,15 do tiles[#tiles+1]={name="lab-dark-1",position={x,y}} end end
        surface.set_tiles(tiles)
        for _, data in ipairs(fixture.cases[case]) do
            local e = surface.create_entity({name=data.name,position={data.x,data.y},direction=defines.direction[data.direction],type=data.type,force="player"})
            assert(e and e.valid, "fixture entity creation failed: " .. data.id)
        end
        return {prepared=true,tick=game.tick,mods=script.active_mods}
    end
    assert(state and state.token == token and state.name == name and state.case == case, "ownership mismatch")
    local surface = assert(game.surfaces[name], "fixture surface missing")
    local entities, units, all = {}, {}, {}
    for _, data in ipairs(fixture.cases[case]) do
        local entity = assert(surface.find_entity(data.name,{data.x,data.y}), "fixture entity missing")
        assert(entity.valid and (entity.type == "transport-belt" or entity.type == "splitter" or entity.type == "underground-belt"), "unsupported transport type")
        entities[data.id], units[entity.unit_number] = entity, data.id
        all[#all+1] = data.id
    end
    local function neighbors(id)
        local ids, seen = {id}, {[id]=true}
        local e = entities[id]
        local connections = e.belt_neighbours
        for _, list in ipairs({connections.inputs,connections.outputs}) do
            for _, other in pairs(list) do
                local n = assert(units[other.unit_number], "connection outside fixture")
                if not seen[n] then ids[#ids+1]=n;seen[n]=true end
            end
        end
        if e.type == "underground-belt" and e.underground_belt_neighbour then
            local n = assert(units[e.underground_belt_neighbour.unit_number], "underground outside fixture")
            if not seen[n] then ids[#ids+1]=n end
        end
        table.sort(ids)
        return ids
    end
    local function read(ids)
        local rows, counts = {}, {}
        for _, id in ipairs(ids) do
            local e = entities[id]
            for li=1,e.get_max_transport_line_index() do
                local line = e.get_transport_line(li)
                assert(line and line.valid, "line missing")
                counts[#counts+1] = {id=id,line=li,count=line.get_item_count(),length=line.line_length}
                for _, item in ipairs(line.get_detailed_contents()) do
                    local stack = item.stack
                    assert(stack.valid_for_read, "unreadable item")
                    rows[#rows+1] = {belt=id,line=li,uid=tostring(item.unique_id),name=stack.name,count=stack.count,
                        quality=stack.quality.name,position=item.position}
                end
            end
        end
        return {tick=game.tick,rows=rows,lineCounts=counts}
    end
    local function observe()
        local value = read(all)
        local seen, total = {}, 0
        for _, row in ipairs(value.rows) do
            assert(row.name == "iron-plate" and row.quality == "normal" and row.count == 1, "seed cargo changed")
            if not seen[row.uid] then seen[row.uid]=true;total=total+row.count end
        end
        value.total = total
        assert(#surface.find_entities_filtered({type="item-on-ground"}) == 0, "ground cargo appeared")
        if state.seeded then
            assert(total == 1 and table_size(seen) == 1 and seen[state.uid], "whole-network seed/identity oracle failed")
        else assert(total == 0, "unseeded fixture contains cargo") end
        return value
    end
    if mode == "smoke" then
        local shape = {}
        for _, id in ipairs(all) do
            local e=entities[id]; local line=e.get_transport_line(1)
            shape[#shape+1] = {id=id,type=e.type,neighbors=neighbors(id),length=line.line_length,selfEquals=line.line_equals(line)}
        end
        return {shape=shape,physical=observe()}
    end
    if mode == "seed" then
        assert(not state.seeded, "already seeded")
        observe()
        assert(entities[target].get_transport_line(1).insert_at_back({name="iron-plate",count=1}), "seed insertion refused")
        local value = read(all)
        local ids = {}
        for _, row in ipairs(value.rows) do ids[row.uid]=true end
        assert(table_size(ids)==1, "seed must create exactly one identity")
        state.uid=next(ids);state.seeded=true;state.seedTick=game.tick
        local first=read({selected});local haloIds=neighbors(selected);local halo=read(haloIds)
        return {sampled=true,selected=selected,haloIds=haloIds,single=first,halo=halo,physical=observe(),tick=game.tick}
    end
    assert(state.seeded, "fixture not seeded")
    local physical=observe()
    local inTarget, elsewhere=false,false
    for _, row in ipairs(physical.rows) do
        if string.find(","..target..",",","..row.belt..",",1,true) then inTarget=true else elsewhere=true end
    end
    if not inTarget or elsewhere then return {sampled=false,tick=game.tick,physical=physical} end
    assert(game.tick > state.seedTick, "simulation did not advance")
    local haloIds=neighbors(selected)
    return {sampled=true,selected=selected,haloIds=haloIds,single=read({selected}),halo=read(haloIds),physical=physical,tick=game.tick}
end)
clock.stop()
log({"", "[BELT_CAPTURE_PROBE] ",token," ",mode," ",clock})
if not ok then
    local clean=cleanup()
    return {status="HARNESS_ERROR",error=tostring(result),cleanup=clean}
end
return result
