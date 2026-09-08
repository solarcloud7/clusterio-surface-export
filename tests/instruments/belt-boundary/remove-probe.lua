local fixture = helpers.json_to_table([=[__FIXTURE__]=])
local token, name, mode, case = "__TOKEN__", "__NAME__", "__MODE__", "__CASE__"
local reverse, recover = __REVERSE__, __RECOVER__
local boundary = __BOUNDARY__
local paired = __PAIRED__
local fidelity = __FIDELITY__
local reverse_rebuild = __REVERSE_REBUILD__
local same_lane = __SAME_LANE__
local dense = __DENSE__
local import_groups = __IMPORT_GROUPS__
local route_flow = fixture.routingCases and fixture.routingCases[case]
local key, hookkey = "__belt_remove_experiment", "__belt_remove_hook"
assert(script.active_mods.base == fixture.engine, "engine pin mismatch")
local function unhook()
    local hook = _G[hookkey]
    if not hook then return end
    assert(hook.token == token, "foreign callback ownership")
    local current = script.get_event_handler(defines.events.on_tick)
    assert(current == hook.wrapper or current == hook.original, "on_tick handler changed during experiment")
    if current == hook.wrapper then script.on_event(defines.events.on_tick, hook.original) end
    assert(script.get_event_handler(defines.events.on_tick) == hook.original, "handler restoration failed")
    _G[hookkey] = nil
end
local function cleanup()
    unhook()
    local s = storage[key]
    if s then assert(s.token == token and s.name == name, "foreign storage ownership") end
    local surface = game.surfaces[name]
    if surface then assert(s, "surface without ownership"); assert(surface.valid); assert(game.delete_surface(surface)) end
    if s then storage[key] = nil end
    return {storageAbsent=storage[key]==nil,hookAbsent=_G[hookkey]==nil,
        handler=tostring(script.get_event_handler(defines.events.on_tick)),paused=game.tick_paused}
end
if mode == "cleanup" then return cleanup() end
local clock = helpers.create_profiler()
local ok, result = pcall(function()
    assert(not game.tick_paused and #game.connected_players == 0, "paused or player joined")
    assert(table_size(storage.async_jobs or {}) == 0 and table_size(storage.locked_platforms or {}) == 0, "transfer work started")
    if mode == "setup" or mode == "inject" then
        assert(not storage[key] and not _G[hookkey] and not game.surfaces[name], "existing lab ownership")
        for n in pairs(game.surfaces) do
            assert(type(n) ~= "string" or not n:find("belt-remove-",1,true), "foreign lab surface")
        end
        local s={token=token,name=name,case=case,status="PREPARED",journal={},steps={},expected={},callbacks=0}
        storage[key]=s
        local surface=game.create_surface(name,{width=32,height=32})
        if mode == "inject" then error("injected construction failure") end
        surface.request_to_generate_chunks({0,0},0); surface.force_generate_chunk_requests()
        local tiles={}
        for x=0,15 do for y=0,15 do tiles[#tiles+1]={name="lab-dark-1",position={x,y}} end end
        surface.set_tiles(tiles)
        for _,d in ipairs(fixture.cases[case]) do
            local e=surface.create_entity({name=d.name,position={d.x,d.y},direction=defines.direction[d.direction],type=d.type,force="player"})
            assert(e and e.valid, "fixture creation failed: "..d.id)
        end
        return {prepared=true,mods=script.active_mods,handler=tostring(script.get_event_handler(defines.events.on_tick))}
    end
    local s=assert(storage[key],"missing fixture state")
    assert(s.token == token and s.name == name and s.case == case,"ownership mismatch")
    local surface=assert(game.surfaces[name],"missing surface")
    local defs, order, numeric, letters={},{},{},{}
    for i,d in ipairs(fixture.cases[case]) do defs[d.id]=d;order[#order+1]=d.id;numeric[d.id]=i;letters[i]=d.id end
    if reverse then
        local reversed={}; for i=#order,1,-1 do reversed[#reversed+1]=order[i] end; order=reversed
    end
    local function entity(id)
        local d=defs[id];local e=surface.find_entity(d.name,{d.x,d.y})
        if not e then return nil end
        assert(e.valid and (e.type=="transport-belt" or e.type=="splitter" or e.type=="underground-belt"),"unsupported entity")
        return e
    end
    local function read(ids)
        local out={tick=game.tick,rows={},nativeCounts={}}
        for _,id in ipairs(ids) do
            local e=entity(id)
            if e then
                local max=e.get_max_transport_line_index(); assert(max<=8,"line budget exceeded")
                for li=1,max do
                    local line=e.get_transport_line(li);assert(line.valid,"invalid line")
                    out.nativeCounts[#out.nativeCounts+1]={belt=id,line=li,count=line.get_item_count(),length=line.line_length}
                    for _,item in ipairs(line.get_detailed_contents()) do
                        local stack=item.stack;assert(stack.valid_for_read,"unreadable cargo")
                        local row={belt=id,line=li,uid=tostring(item.unique_id),name=stack.name,
                            quality=stack.quality.name,count=stack.count,position=item.position}
                        if fidelity then
                            row.properties={health=stack.health}
                            if stack.name=="firearm-magazine" then row.properties.ammo=stack.ammo end
                            if stack.name=="repair-pack" then row.properties.durability=stack.durability end
                            if stack.is_blueprint then row.properties.blueprint=stack.get_blueprint_entities();row.properties.label=stack.label end
                        end
                        out.rows[#out.rows+1]=row
                    end
                end
            end
        end
        return out
    end
    local function counts(rows, dedup)
        local totals,seen={},{}
        for _,r in ipairs(rows) do
            if not dedup or not seen[r.uid] then
                seen[r.uid]=true;local k=r.name.."/"..r.quality;totals[k]=(totals[k] or 0)+r.count
            end
        end
        return totals
    end
    local function equal(a,b)
        for k,v in pairs(a) do if v~=(b[k] or 0) then return false end end
        for k,v in pairs(b) do if v~=(a[k] or 0) then return false end end
        return true
    end
    local function canonical(value)
        if type(value)~="table" then return helpers.table_to_json({value}) end
        local keys={};for k in pairs(value) do keys[#keys+1]=k end
        table.sort(keys,function(a,b) return tostring(a)<tostring(b) end)
        local parts={};for _,k in ipairs(keys) do parts[#parts+1]=canonical(k)..":"..canonical(value[k]) end
        return "{"..table.concat(parts,",").."}"
    end
    local function parity(rows,dedup,force_lane)
        local out,seen={},{}
        for _,r in ipairs(rows) do
            if not dedup or not seen[r.uid] then
                seen[r.uid]=true;local k=r.name.."/"..r.quality.."/"..canonical(r.properties)
                if (same_lane and not route_flow) or force_lane then k=k.."/"..tostring(r.line % 2) end
                out[k]=(out[k] or 0)+r.count
            end
        end
        return out
    end
    local function observe()
        local out=read(order)
        out.totals=counts(out.rows,true)
        out.ground={}
        for _,e in pairs(surface.find_entities_filtered({type="item-on-ground"})) do
            local st=e.stack;assert(st.valid_for_read,"invalid ground stack")
            out.ground[#out.ground+1]={name=st.name,count=st.count,quality=st.quality.name}
        end
        out.entities=0
        for _,id in ipairs(order) do if entity(id) then out.entities=out.entities+1 end end
        return out
    end
    local function journal_counts()
        local rows={}
        for _,entry in ipairs(s.journal) do
            if not entry.restored then for _,r in ipairs(entry.rows) do rows[#rows+1]=r end end
        end
        return counts(rows,false)
    end
    local function conserved(physical)
        if #physical.ground>0 then return false end
        local totals=journal_counts()
        for k,v in pairs(physical.totals) do totals[k]=(totals[k] or 0)+v end
        if not equal(totals,s.expected) then return false end
        if fidelity and s.expectedParity then
            local p=parity(physical.rows,true)
            for _,entry in ipairs(s.journal) do if not entry.restored then
                for k,v in pairs(parity(entry.rows,false)) do p[k]=(p[k] or 0)+v end
            end end
            if not equal(p,s.expectedParity) then return false end
        end
        return true
    end
    local function shape()
        local out,units={},{}
        for _,id in ipairs(order) do local e=entity(id);if e then units[e.unit_number]=id end end
        for _,id in ipairs(order) do
            local e=entity(id)
            if e then
                local row={id=id,name=e.name,type=e.type,direction=e.direction,position=e.position,neighbors={},aliases={}}
                for _,list in ipairs({e.belt_neighbours.inputs,e.belt_neighbours.outputs}) do
                    for _,n in pairs(list) do row.neighbors[#row.neighbors+1]=assert(units[n.unit_number],"external connection") end
                end
                if e.type=="underground-belt" and e.underground_belt_neighbour then
                    row.underground=assert(units[e.underground_belt_neighbour.unit_number],"external underground")
                end
                for _,other in ipairs(order) do
                    local n=entity(other)
                    if n then row.aliases[other]=e.get_transport_line(1).line_equals(n.get_transport_line(1)) end
                end
                table.sort(row.neighbors);out[#out+1]=row
            end
        end
        return out
    end
    local function finish(status,reason)
        s.status=status;s.reason=reason;s.final=observe();s.finalShape=shape();unhook();s.handlerRestored=true
    end
    if mode == "smoke" then return {shape=shape(),physical=observe()} end
    if mode == "read" then return s end
    assert(mode=="start" or mode=="tick-failure","unknown mode")
    assert(s.status=="PREPARED" and not _G[hookkey],"already started")
    s.initialShape=shape()
    local groups, grouped, partners = {}, {}, {}
    for _,r in ipairs(s.initialShape) do if r.underground then partners[r.id]=r.underground end end
    for _,id in ipairs(order) do
        if not grouped[id] then
            local ids={id};grouped[id]=true
            if paired and partners[id] then
                local other=partners[id]
                assert(partners[other]==id and not grouped[other],"invalid original underground pair")
                ids[#ids+1]=other;grouped[other]=true
            end
            groups[#groups+1]=ids
        end
    end
    s.groups=groups
    local helper, planner
    if fidelity then
        local bundle=assert(storage.__belt_remove_bundle,"missing module bundle")
        assert(bundle.token==token,"foreign module bundle")
        local input=helpers.json_to_table(bundle.json)
        local modules,loading={},{}
        local function require_local(path)
            if modules[path] then return modules[path] end
            assert(not loading[path],"circular module dependency");loading[path]=true
            local body=assert(input[path],"unbundled module")
            local constructor=assert(load("return function(require)\n"..body.."\nend",path))()
            local module=constructor(require_local);modules[path]=module;loading[path]=nil;return module
        end
        helper=require_local("modules/surface_export/import_phases/belt_restoration")
        if import_groups then planner=require_local("modules/surface_export/import_phases/belt_batches") end
        s.payloads={}
    end
    assert(#observe().rows==0,"fixture not empty")
    for i,d in ipairs(fixture.cases[case]) do
        local item=fixture.items[(i-1)%#fixture.items+1]
        local line=entity(d.id).get_transport_line(1)
        if fidelity then
            local spec=fixture.statefulItems[i]
            line.force_insert_at(1/64,{name=spec.name,count=spec.count,quality=spec.quality or "normal"},4)
            local stack
            for _,it in ipairs(line.get_detailed_contents()) do if it.position==1/64 and it.stack.name==spec.name then stack=it.stack end end
            assert(stack and stack.count==spec.count and stack.quality.name==(spec.quality or "normal"),"stateful seed identity mismatch")
            if spec.health then stack.health=spec.health;assert(stack.health==spec.health,"health seed mismatch") end
            if spec.ammo then stack.ammo=spec.ammo;assert(stack.ammo==spec.ammo,"ammo seed mismatch") end
            if spec.durability then stack.durability=spec.durability;assert(stack.durability==spec.durability,"durability seed mismatch") end
            if spec.blueprint then
                stack.set_blueprint_entities({{entity_number=1,name="transport-belt",position={0.5,0.5}},
                    {entity_number=2,name="wooden-chest",position={1.5,0.5}}})
                stack.label="capture-remove-parity"
                assert(#stack.get_blueprint_entities()==2 and stack.label=="capture-remove-parity","blueprint seed mismatch")
            end
            local second=entity(d.id).get_transport_line(2)
            second.force_insert_at(1/64,{name="iron-plate",count=4,quality="rare"},4)
            local k=spec.name.."/"..(spec.quality or "normal");s.expected[k]=(s.expected[k] or 0)+spec.count
            s.expected["iron-plate/rare"]=(s.expected["iron-plate/rare"] or 0)+4
            if dense then
                for _,position in ipairs({1/8,1/4}) do
                    line.force_insert_at(position,{name="copper-plate",quality="legendary",count=4},4)
                    second.force_insert_at(position,{name="steel-plate",quality="uncommon",count=4},4)
                end
                s.expected["copper-plate/legendary"]=(s.expected["copper-plate/legendary"] or 0)+8
                s.expected["steel-plate/uncommon"]=(s.expected["steel-plate/uncommon"] or 0)+8
            end
        else
            if boundary then line.force_insert_at(1/64,{name=item,count=1})
            else assert(line.insert_at_back({name=item,count=1}),"seed refused") end
            s.expected[item.."/normal"]=(s.expected[item.."/normal"] or 0)+1
        end
    end
    s.initial=observe();assert(equal(s.initial.totals,s.expected) and #s.initial.ground==0,"seed oracle failed")
    if fidelity then s.expectedParity=parity(s.initial.rows,true) end
    s.status="RUNNING";s.startTick=game.tick;s.phase="remove";s.index=1
    if import_groups then s.phase="capture-intact" end
    local original=script.get_event_handler(defines.events.on_tick)
    local function step()
        assert(#game.connected_players==0 and not game.tick_paused,"player joined or paused")
        assert(table_size(storage.async_jobs or {})==0 and table_size(storage.locked_platforms or {})==0,"transfer started")
        s.callbacks=s.callbacks+1;assert(s.callbacks<=(import_groups and 48 or 16),"callback bound exceeded")
        if mode=="tick-failure" then error("injected callback failure") end
        local rec={tick=game.tick,phase=s.phase,before=observe()};s.steps[#s.steps+1]=rec
        if not conserved(rec.before) then finish("STOP","conservation failed between callbacks");return end
        if s.phase=="capture-intact" then
            local pairs_to_capture,map={},{}
            for _,id in ipairs(order) do local e=assert(entity(id));map[numeric[id]]=e;pairs_to_capture[#pairs_to_capture+1]={id=numeric[id],entity=e} end
            local encoded=helpers.encode_string(helpers.table_to_json(helper.capture_side_groups(pairs_to_capture)))
            local decoded=helpers.json_to_table(assert(helpers.decode_string(encoded)))
            s.payloads={{encoded=encoded,groups=decoded}};s.plan=planner.plan(decoded,map,1)
            local seen={}
            for gi,g in ipairs(decoded) do
                local entry={id=gi,rows={}}
                for _,m in ipairs(g.members) do
                    for _,r in ipairs(rec.before.rows) do
                        if numeric[r.belt]==m.id and r.line==m.li and not seen[r.uid] then
                            entry.rows[#entry.rows+1]=r;seen[r.uid]=true
                        end
                    end
                end
                s.journal[#s.journal+1]=entry
            end
            for _,id in ipairs(order) do local e=entity(id);for li=1,e.get_max_transport_line_index() do e.get_transport_line(li).clear() end end
            rec.after=observe();rec.conserved=conserved(rec.after)
            if not rec.conserved or #rec.after.rows~=0 then finish("STOP","intact capture ledger mismatch");return end
            s.phase="restore-groups";s.restoreIndex=1
        elseif s.phase=="restore-groups" then
            local map={};for _,id in ipairs(order) do map[numeric[id]]=assert(entity(id)) end
            rec.indices=s.plan.batches[s.restoreIndex].indices
            local slice,expected_rows={},{}
            for _,gi in ipairs(rec.indices) do
                slice[#slice+1]=s.payloads[1].groups[gi]
                for _,row in ipairs(s.journal[gi].rows) do expected_rows[#expected_rows+1]=row end
            end
            local ok,placed,unplaced,anomalies,delta,stats=pcall(helper.restore_side_groups,slice,map,"intact-import-groups")
            rec.restores={{success=ok,placed=ok and placed or nil,error=not ok and tostring(placed) or nil,unplaced=unplaced,anomalies=anomalies,delta=delta,stats=stats}}
            if not ok or unplaced~=0 or anomalies~=0 then finish("STOP","connected group restoration rejected payload");return end
            for _,gi in ipairs(rec.indices) do s.journal[gi].restored=true end
            rec.after=observe();rec.conserved=conserved(rec.after)
            local before_ids,new_rows,seen={},{},{}
            for _,r in ipairs(rec.before.rows) do before_ids[r.uid]=true end
            rec.route=true
            for _,r in ipairs(rec.after.rows) do
                if not before_ids[r.uid] and not seen[r.uid] then
                    seen[r.uid]=true;new_rows[#new_rows+1]=r
                    local member=false
                    for _,g in ipairs(slice) do for _,m in ipairs(g.members) do if numeric[r.belt]==m.id and r.line==m.li then member=true end end end
                    if not member then rec.route=false end
                end
            end
            rec.arrivals=parity(new_rows,true,true);rec.expectedArrivals=parity(expected_rows,false,true)
            if not rec.conserved or not rec.route or not equal(rec.arrivals,rec.expectedArrivals) then finish("STOP","connected group physical lane/state mismatch");return end
            s.restoreIndex=s.restoreIndex+1;s.phase=s.restoreIndex<=#s.plan.batches and "restore-groups" or "verify"
        elseif s.phase=="remove" then
            local ids=groups[s.index]
            rec.selected=ids[1];rec.selectedIds=ids;rec.candidate=read(ids)
            if fidelity then
                local pairs_to_capture={}
                for _,id in ipairs(ids) do pairs_to_capture[#pairs_to_capture+1]={id=numeric[id],entity=assert(entity(id))} end
                local captured=helper.capture_side_groups(pairs_to_capture)
                local encoded=helpers.encode_string(helpers.table_to_json(captured))
                local decoded=helpers.json_to_table(assert(helpers.decode_string(encoded)))
                local valid,why=helper.validate_side_groups(decoded);assert(valid,why)
                local totals={}
                for _,g in ipairs(decoded) do for _,slot in ipairs(g.slots or {}) do
                    local k=slot.n.."/"..(slot.q or "normal");totals[k]=(totals[k] or 0)+slot.ct
                end end
                rec.payloadTotals=totals;rec.encodedBytes=#encoded
                if not equal(totals,counts(rec.candidate.rows,true)) then finish("STOP","production capture count mismatch");return end
                s.payloads[#s.payloads+1]={groups=decoded,encoded=encoded}
            end
            local rowsById,seen={},{}
            for _,id in ipairs(ids) do rowsById[id]={};assert(entity(id),"selected entity missing") end
            for _,r in ipairs(rec.candidate.rows) do
                if not seen[r.uid] then local rows=rowsById[r.belt];rows[#rows+1]=r;seen[r.uid]=true end
            end
            for _,id in ipairs(ids) do s.journal[#s.journal+1]={id=id,rows=rowsById[id],tick=game.tick} end
            rec.destroyed=true;rec.invalid=true;rec.deletions={}
            for _,id in ipairs(ids) do
                local e=assert(entity(id),"unit member disappeared")
                local destroyed=e.destroy({raise_destroy=false});local invalid=not e.valid
                rec.deletions[#rec.deletions+1]={id=id,destroyed=destroyed,invalid=invalid}
                rec.destroyed=rec.destroyed and destroyed;rec.invalid=rec.invalid and invalid
                if not destroyed or not invalid then break end
            end
            rec.after=observe();rec.captured=journal_counts();rec.conserved=conserved(rec.after)
            if not rec.destroyed or not rec.invalid or not rec.conserved then finish("STOP","capture/remove accounting failed");return end
            s.index=s.index+1
            if recover and s.index==3 then s.phase="rebuild";s.abortTick=game.tick
            elseif s.index>#groups then
                if fidelity and reverse_rebuild then s.phase="rebuild-inverse";s.restoreIndex=#groups
                else s.phase=fidelity and "rebuild" or "verify" end
            end
        elseif s.phase=="rebuild-inverse" then
            rec.ids=groups[s.restoreIndex]
            for _,id in ipairs(rec.ids) do
                local d=defs[id];assert(not entity(id),"inverse reconstruction would overwrite an entity")
                local e=surface.create_entity({name=d.name,position={d.x,d.y},direction=defines.direction[d.direction],type=d.type,force="player"})
                if not e or not e.valid then finish("STOP","inverse reconstruction refused");return end
            end
            rec.after=observe();rec.conserved=conserved(rec.after)
            if not rec.conserved then finish("STOP","inverse geometry reconstruction changed cargo");return end
            s.phase="restore-inverse"
        elseif s.phase=="restore-inverse" then
            local ids=groups[s.restoreIndex];rec.ids=ids
            local map={};for _,id in ipairs(order) do local e=entity(id);if e then map[numeric[id]]=e end end
            local payload=s.payloads[s.restoreIndex]
            local restored,placed,unplaced,anomalies,delta,stats=pcall(helper.restore_side_groups,payload.groups,map,"capture-remove-inverse")
            rec.restores={{success=restored,placed=restored and placed or nil,error=not restored and tostring(placed) or nil,
                unplaced=unplaced,anomalies=anomalies,delta=delta,stats=stats}}
            if not restored or unplaced~=0 or anomalies~=0 then finish("STOP","inverse restoration rejected captured payload");return end
            for _,entry in ipairs(s.journal) do for _,id in ipairs(ids) do if entry.id==id then entry.restored=true end end end
            rec.after=observe();rec.conserved=conserved(rec.after)
            if not rec.conserved then finish("STOP","inverse item-property parity mismatch");return end
            s.restoreIndex=s.restoreIndex-1;s.phase=s.restoreIndex>0 and "rebuild-inverse" or "verify"
        elseif s.phase=="rebuild" then
            for _,entry in ipairs(s.journal) do
                local d=defs[entry.id]
                assert(not entity(entry.id),"recovery would overwrite entity")
                local e=surface.create_entity({name=d.name,position={d.x,d.y},direction=defines.direction[d.direction],type=d.type,force="player"})
                if not e or not e.valid then finish("STOP","reconstruction refused");return end
            end
            rec.after=observe();rec.conserved=conserved(rec.after)
            if not rec.conserved then finish("STOP","reconstruction changed cargo");return end
            s.phase=same_lane and "restore-lane" or "restore";s.restoreIndex=1
        elseif s.phase=="restore-lane" then
            local ids=groups[s.restoreIndex];rec.ids=ids;rec.clamps={}
            local map={};for _,id in ipairs(order) do map[numeric[id]]=assert(entity(id)) end
            local payload=s.payloads[s.restoreIndex]
            for _,g in ipairs(payload.groups) do
                for i=1,#g.item_source_positions,3 do
                    local e=map[g.item_source_positions[i]]
                    local li,k=g.item_source_positions[i+1],g.item_source_positions[i+2]
                    local length=e.get_transport_line(li).line_length
                    if k/256>length then rec.clamps[#rec.clamps+1]={id=g.item_source_positions[i],line=li,from=k/256,to=length} end
                end
            end
            local ok,placed,unplaced,anomalies,delta,stats=pcall(helper.restore_side_groups,payload.groups,map,"capture-remove-same-lane")
            rec.restores={{success=ok,placed=ok and placed or nil,error=not ok and tostring(placed) or nil,
                unplaced=unplaced,anomalies=anomalies,delta=delta,stats=stats}}
            if not ok or unplaced~=0 or anomalies~=0 then finish("STOP","same-lane restoration rejected captured payload");return end
            for _,entry in ipairs(s.journal) do for _,id in ipairs(ids) do if entry.id==id then entry.restored=true end end end
            rec.after=observe();rec.conserved=conserved(rec.after)
            if not rec.conserved then finish("STOP","same-lane item-property parity mismatch");return end
            s.restoreIndex=s.restoreIndex+1;s.phase=s.restoreIndex<=#groups and "restore-lane" or "verify"
        elseif s.phase=="restore" then
            rec.insertions={}
            if fidelity then
                local map={};for _,id in ipairs(order) do map[numeric[id]]=assert(entity(id)) end
                rec.restores={}
                for _,payload in ipairs(s.payloads) do
                    local placed,unplaced,anomalies,delta,stats=helper.restore_side_groups(payload.groups,map,"capture-remove-parity")
                    rec.restores[#rec.restores+1]={placed=placed,unplaced=unplaced,anomalies=anomalies,delta=delta,stats=stats}
                    if unplaced~=0 or anomalies~=0 then finish("STOP","production restoration rejected captured payload");return end
                end
                for _,entry in ipairs(s.journal) do entry.restored=true end
                rec.after=observe();rec.conserved=conserved(rec.after)
                if not rec.conserved then finish("STOP","item-property parity failed after production restoration");return end
                s.phase="verify";return
            end
            for _,entry in ipairs(s.journal) do
                local e=assert(entity(entry.id),"recreated entity missing")
                for _,r in ipairs(entry.rows) do
                    local line=e.get_transport_line(r.line)
                    local before=observe();local insertion={row=r,before=before};rec.insertions[#rec.insertions+1]=insertion
                    if r.position<0 or r.position>line.line_length then finish("STOP","recovery coordinate out of range");return end
                    line.force_insert_at(r.position,{name=r.name,count=r.count,quality=r.quality})
                    insertion.after=observe();local expected={}
                    for k,v in pairs(before.totals) do expected[k]=v end
                    local k=r.name.."/"..r.quality;expected[k]=(expected[k] or 0)+r.count
                    local exact=false
                    for _,got in ipairs(read({entry.id}).rows) do
                        if got.line==r.line and got.name==r.name and got.quality==r.quality and got.count==r.count and math.abs(got.position-r.position)<1e-9 then exact=true end
                    end
                    insertion.exact=exact
                    if not exact or not equal(expected,insertion.after.totals) or #insertion.after.ground>0 then finish("STOP","recovery insertion mismatch");return end
                end
                entry.restored=true
            end
            rec.after=observe();rec.conserved=conserved(rec.after);s.phase="verify"
            if not rec.conserved then finish("STOP","recovered cargo mismatch");return end
        else
            rec.after=observe();rec.conserved=conserved(rec.after)
            if recover or fidelity then
                local actual=shape();local expected=s.initialShape;local topology=true
                for i,r in ipairs(actual) do
                    local e=expected[i]
                    if not e or r.id~=e.id or r.name~=e.name or r.direction~=e.direction or r.position.x~=e.position.x or r.position.y~=e.position.y or table.concat(r.neighbors,",")~=table.concat(e.neighbors,",") or r.underground~=e.underground then topology=false end
                end
                rec.topology=topology and #actual==#expected
                if not rec.topology then finish("STOP","recovered topology mismatch");return end
            elseif rec.after.entities~=0 then finish("STOP","uncaptured entities remain");return end
            if not rec.conserved then finish("STOP","final cargo mismatch");return end
            finish("PASS")
        end
    end
    local wrapper
    wrapper=function(event)
        if original then original(event) end
        local profiler=helpers.create_profiler()
        local step_ok,err=pcall(step)
        profiler.stop();log({"","[BELT_REMOVE_PROBE] ",token," ",case," ",game.tick," ",s.phase," ",profiler})
        if not step_ok then s.status="HARNESS_ERROR";s.error=tostring(err);unhook();s.handlerRestored=true end
    end
    _G[hookkey]={token=token,original=original,wrapper=wrapper}
    script.on_event(defines.events.on_tick,wrapper)
    return {started=true,tick=game.tick}
end)
clock.stop();log({"","[BELT_REMOVE_PROBE] ",token," ",mode," ",clock})
if not ok then local cleaned=cleanup();return {status="HARNESS_ERROR",error=tostring(result),cleanup=cleaned} end
return result
