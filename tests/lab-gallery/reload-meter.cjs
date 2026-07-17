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
  reachability=reachability,surface_settings=surface_settings,
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
