const { Rcon } = require("/clusterio/node_modules/rcon-client");

const [port = "27977", password = "gallery-verify-only"] = process.argv.slice(2);

const command = `/c
local function table_size(value) local n=0 for _ in pairs(value or {}) do n=n+1 end return n end
local function census(belts,selected_line)
  local seen,quantity,stacks,maximum={},0,0,0
  for _,belt in ipairs(belts)do
    local first=selected_line or 1
    local last=selected_line or belt.get_max_transport_line_index()
    for line_index=first,last do
      for _,row in ipairs(belt.get_transport_line(line_index).get_detailed_contents())do
        if not seen[row.unique_id]then
          seen[row.unique_id]=true;quantity=quantity+row.stack.count;stacks=stacks+1;maximum=math.max(maximum,row.stack.count)
        end
      end
    end
  end
  return{quantity=quantity,physical_stacks=stacks,maximum_stack=maximum}
end
local surface=game.surfaces.nauvis
local source=surface.find_entities_filtered{area={{-17,-26},{-12,-21}},name="turbo-transport-belt"}
local target=surface.find_entities_filtered{area={{4,-26},{9,-21}},name="turbo-transport-belt"}
local all,line1,line2,empty=census(source),census(source,1),census(source,2),census(target)
local index=game.surfaces["lab-gallery-index-v2"]
local index_texts=0
for _,object in ipairs(rendering.get_all_objects(""))do if object.type=="text"and object.surface==index then index_texts=index_texts+1 end end
local platform=nil
for _,candidate in pairs(game.forces.player.platforms)do if candidate.valid and candidate.name=="lab-specialized-fluid-r1"then platform=candidate end end
local reachability={exists=false}
if platform then
  local drill=platform.surface.find_entities_filtered{name="electric-mining-drill"}[1]
  if drill and drill.valid then
    local read_ok,read_value=pcall(function()return drill.fluidbox[1]end)
    local write_ok,write_error=pcall(function()drill.fluidbox[1]={name="water",amount=1}end)
    reachability={exists=true,platform_name=platform.name,drill_name=drill.name,
      pressure=platform.surface.get_property("pressure"),gravity=platform.surface.get_property("gravity"),
      mining_target=drill.mining_target and drill.mining_target.name or nil,live_fluidbox_count=#drill.fluidbox,
      read_ok=read_ok,read_error=read_ok and nil or tostring(read_value),
      write_ok=write_ok,write_error=write_ok and nil or tostring(write_error)}
  else reachability={exists=true,drill_name=nil} end
end
local function at(surf,name,x,y) return surf.find_entities_filtered{name=name,area={{x-0.6,y-0.6},{x+0.6,y+0.6}}}[1] end
local function platsurf(name) for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name==name then return p.surface,p end end end
local corpus={}
local omni,omniP=platsurf("lab-omnibus-state-v1")
if omni then
  local chest=at(omni,"steel-chest",13,-3)
  local cinv=chest.get_inventory(defines.inventory.chest)
  local armor
  for i=1,#cinv do local s=cinv[i] if s.valid_for_read and s.name=="power-armor-mk2" then armor=s break end end
  local adv={}
  for _,eq in ipairs(armor.grid.equipment) do
    if eq.name=="battery-mk2-equipment" then adv.battEnergy=eq.energy adv.battQuality=eq.quality.name end
    if eq.name=="energy-shield-mk2-equipment" then adv.shieldValue=eq.shield adv.shieldMax=eq.max_shield adv.shieldQuality=eq.quality.name end
  end
  local am=at(omni,"assembling-machine-2",16,-3)
  local rec,qual=am.get_recipe()
  adv.recipe=rec and rec.name or nil adv.recipeQuality=qual and qual.name or nil
  corpus["omnibus-adversarial-inventory"]=adv
  corpus["omnibus-heat-temperature"]={temperature=at(omni,"heat-pipe",27,1).temperature}
  local dec=at(omni,"decider-combinator",36,0)
  local dnet=dec.get_circuit_network(defines.wire_connector_id.combinator_output_red)
  corpus["omnibus-decider-latch"]={signalS=dnet and dnet.get_signal{type="virtual",name="signal-S"} or nil}
  local mc=at(omni,"assembling-machine-1",47,-2)
  local mci=mc.get_inventory(defines.inventory.assembling_machine_input)
  corpus["omnibus-midcraft-progress"]={progress=mc.crafting_progress,active=mc.active,inputPlates=mci and mci.get_item_count("iron-plate") or nil}
  local bi=at(omni,"burner-inserter",63,1)
  local bfi=bi.get_inventory(defines.inventory.fuel)
  corpus["omnibus-burner-fuel"]={coal=bfi and bfi.get_item_count("coal") or nil,active=bi.active,burning=bi.burner and bi.burner.currently_burning and bi.burner.currently_burning.name.name or nil,remaining=bi.burner and bi.burner.remaining_burning_fuel or nil}
  local sp=at(omni,"spidertron",74,0)
  local grid={holder="spidertron"}
  for _,eq in ipairs(sp.grid.equipment) do if eq.name=="battery-mk2-equipment" then grid.battEnergy=eq.energy grid.battMax=eq.max_energy end end
  corpus["omnibus-equipment-grid"]=grid
  local cc=at(omni,"constant-combinator",84,1)
  local ccb=cc.get_control_behavior()
  local circ={}
  local ccs=ccb.sections and ccb.sections[1]
  if ccs then local f=ccs.filters and ccs.filters[1] if f then circ.constantSignal=f.value and f.value.name or nil circ.constantMin=f.min end end
  local lamp=at(omni,"small-lamp",90,1)
  local lb=lamp.get_control_behavior()
  circ.lampUseColors=lb and lb.use_colors or nil
  corpus["omnibus-circuit-config"]=circ
  local bm=at(omni,"assembling-machine-2",99,1)
  local bmi=bm.get_module_inventory()
  corpus["omnibus-module-bonus-progress"]={bonusProgress=bm.bonus_progress,modules=bmi and bmi.get_item_count("productivity-module") or nil,active=bm.active}
  local fl={}
  local tank=at(omni,"storage-tank",119,1)
  if tank.fluidbox[1] then fl.steam=tank.fluidbox[1].amount fl.steamTemp=tank.fluidbox[1].temperature end
  local chem=at(omni,"chemical-plant",123,1)
  for i=1,#chem.fluidbox do local f=chem.fluidbox[i] if f then if f.name=="water" then fl.chemWater=f.amount elseif f.name=="petroleum-gas" then fl.chemGas=f.amount end end end
  local foundry=at(omni,"foundry",127,1)
  for i=1,#foundry.fluidbox do local f=foundry.fluidbox[i] if f and f.name=="molten-iron" then fl.foundryMolten=f.amount fl.foundryTemp=f.temperature end end
  corpus["omnibus-crafting-fluids"]=fl
  local ge=omni.find_entities_filtered{type="entity-ghost"}[1]
  corpus["omnibus-ghosts-and-proxies"]={entityGhosts=#omni.find_entities_filtered{type="entity-ghost"},tileGhosts=#omni.find_entities_filtered{type="tile-ghost"},proxies=#omni.find_entities_filtered{type="item-request-proxy"},ghostInner=ge and ge.ghost_name or nil}
  local gi=0
  for _,e in pairs(omni.find_entities_filtered{type="item-entity"}) do local st=e.stack if st and st.valid_for_read and st.name=="iron-plate" then gi=gi+st.count end end
  corpus["omnibus-ground-items"]={ironPlate=gi}
  local sch=omniP.get_schedule()
  local ints=sch.get_interrupts()
  corpus["omnibus-platform-schedule"]={records=#sch.get_records(),interrupts=#ints,interruptName=ints[1] and ints[1].name or nil}
end
local es=platsurf("lab-energy-v1")
if es then
  local acc=es.find_entities_filtered{type="accumulator"}[1]
  local elec=0
  for _,e in pairs(es.find_entities_filtered{}) do if e.type~="space-platform-hub" and e.prototype.electric_energy_source_prototype then elec=elec+1 end end
  corpus["energy-accumulator-drain"]={accEnergy=acc and acc.energy or nil,accName=acc and acc.name or nil,electricEntities=elec,entities=#es.find_entities_filtered{}}
end
local bcs=platsurf("lab-belt-corner-v1")
if bcs then
  local belts=bcs.find_entities_filtered{type="transport-belt"}
  local tot=0
  for _,b in ipairs(belts) do for li=1,b.get_max_transport_line_index() do for _,row in ipairs(b.get_transport_line(li).get_detailed_contents()) do tot=tot+row.stack.count end end end
  local cor=bcs.find_entity("turbo-transport-belt",{16.5,0.5})
  local il=cor and cor.get_transport_line(1) or nil
  local ic=0
  if il then for _,row in ipairs(il.get_detailed_contents()) do ic=ic+row.stack.count end end
  corpus["belt-corner-recovery"]={beltCount=#belts,totalIron=tot,cornerShape=cor and cor.belt_shape or nil,cornerX=cor and cor.position.x or nil,cornerY=cor and cor.position.y or nil,insideItems=ic,insideLength=il and il.line_length or nil,entities=#bcs.find_entities_filtered{}}
end
local ws=platsurf("lab-transfer-fixture-v1")
if ws then corpus["transfer-workhorse"]={entities=#ws.find_entities_filtered{}} end
for n=1,3 do local cs=platsurf("lab-consumable-"..n) if cs then corpus["consumable-hub-"..n]={entities=#cs.find_entities_filtered{}} end end
local surface_names,surface_settings,total_entities,total_chunks={},{},0,0
for _,row in pairs(game.surfaces)do
  local chunks=0 for _ in row.get_chunks()do chunks=chunks+1 end
  surface_names[#surface_names+1]=row.name;total_entities=total_entities+#row.find_entities_filtered({});total_chunks=total_chunks+chunks
  surface_settings[#surface_settings+1]={name=row.name,is_platform=row.platform~=nil,generate_with_lab_tiles=row.generate_with_lab_tiles,
    has_global_electric_network=row.has_global_electric_network,ignore_surface_conditions=row.ignore_surface_conditions}
end
table.sort(surface_names)
table.sort(surface_settings,function(a,b)return a.name<b.name end)
rcon.print(helpers.table_to_json({
  version=script.active_mods.base,save_role=storage.lab_gallery and storage.lab_gallery.saveRole or nil,
  gallery_storage=storage.lab_gallery~=nil,index_surface=index~=nil,game_paused=not not game.tick_paused,
  transient={jobs=table_size(storage.async_jobs),locks=table_size(storage.locked_platforms),holds=table_size(storage.destination_holds),tombstones=table_size(storage.committed_source_transfer_tombstones)},
  source_belts=#source,target_belts=#target,source_quantity=all.quantity,physical_stacks=all.physical_stacks,
  maximum_stack=all.maximum_stack,source_line_quantities={line1.quantity,line2.quantity},target_quantity=empty.quantity,
  index_texts=index_texts,index_tags=index and #game.forces.player.find_chart_tags(index)or 0,
  reachability=reachability,surface_settings=surface_settings,corpus=corpus,
  surface_census={total_entities=total_entities,total_generated_chunks=total_chunks,surface_names=surface_names}
}))`;

async function main() {
	const rcon = await Rcon.connect({ host: "127.0.0.1", port: Number(port), password });
	try {
		const response = await rcon.send(command.replace(/\s*\n\s*/g, " "));
		const reading = JSON.parse(response.trim().split(/\r?\n/).filter(Boolean).at(-1));
		console.log(JSON.stringify({ status: "PASS", reading }));
		try { await rcon.send("/quit"); } catch { /* Expected when Factorio closes first. */ }
	} finally {
		try { rcon.end(); } catch { /* /quit can close first. */ }
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
