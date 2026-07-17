const { Rcon } = require("/clusterio/node_modules/rcon-client");

const [port = "27978", password = "gallery-census-only"] = process.argv.slice(2);

const command = `/c
local function table_size(value)
  local count=0
  for _ in pairs(value or {}) do count=count+1 end
  return count
end
local surfaces={}
local total_entities,total_generated_chunks=0,0
for _,surface in pairs(game.surfaces) do
  local generated_chunks=0
  for _ in surface.get_chunks() do generated_chunks=generated_chunks+1 end
  local entity_count=#surface.find_entities_filtered({})
  total_entities=total_entities+entity_count
  total_generated_chunks=total_generated_chunks+generated_chunks
  surfaces[#surfaces+1]={
    name=surface.name,
    entity_count=entity_count,
    generated_chunks=generated_chunks,
    platform=surface.platform and surface.platform.valid and surface.platform.name or nil,
    planet=surface.planet and surface.planet.name or nil
  }
end
table.sort(surfaces,function(a,b)return a.name<b.name end)
local platforms={}
for _,platform in pairs(game.forces.player.platforms) do
  if platform.valid then
    platforms[#platforms+1]={name=platform.name,index=platform.index,surface=platform.surface.name,entity_count=#platform.surface.find_entities_filtered({})}
  end
end
table.sort(platforms,function(a,b)return a.name<b.name end)
rcon.print(helpers.table_to_json({
  version=script.active_mods.base,
  mods=script.active_mods,
  game_paused=game.tick_paused==true,
  transient={
    jobs=table_size(storage.async_jobs),
    locks=table_size(storage.locked_platforms),
    holds=table_size(storage.destination_holds),
    tombstones=table_size(storage.committed_source_transfer_tombstones)
  },
  surfaces=surfaces,
  platforms=platforms,
  total_entities=total_entities,
  total_generated_chunks=total_generated_chunks
}))`;

async function main() {
	const rcon = await Rcon.connect({ host: "127.0.0.1", port: Number(port), password });
	try {
		const response = await rcon.send(command.replace(/\s*\n\s*/g, " "));
		const reading = JSON.parse(response.trim().split(/\r?\n/).filter(Boolean).at(-1));
		console.log(JSON.stringify({ status: "PASS", reading }, null, 2));
		try { await rcon.send("/quit"); } catch { /* Expected when Factorio closes the socket first. */ }
	} finally {
		try { rcon.end(); } catch { /* /quit can close first. */ }
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });

