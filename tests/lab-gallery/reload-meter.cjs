const { Rcon } = require("/clusterio/node_modules/rcon-client");
const fs = require("node:fs");
const path = require("node:path");

// Thin composer over the shared measurement library: this meter no longer hand-inlines the corpus
// measurement Lua. It ships module/utils/fixture-meters.lua (staged next to this file by verify-save)
// as the /c prelude `FixtureMeters`, hands it a lean manifest (fixtures: id/fingerprint/anchors), and
// reads the corpus through FixtureMeters.measure_corpus — the SAME code the save-patched module and
// the gallery-runtime bake use, so the reload gate measures byte-identically (the literal-coordinate
// duplication cost a bake cycle on 2026-07-18 when only one meter was updated).
const meters = fs.readFileSync(path.join(__dirname, "fixture-meters.lua"), "utf8").replace(/\r/g, "");
if (meters.includes("]=]")) throw new Error("fixture-meters.lua contains unsafe Lua long-string delimiter ]=]");

// The runtime only needs the fixtures' ids/fingerprints/anchors to measure and locate the corpus.
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const leanManifest = JSON.stringify({
	fixtures: manifest.fixtures.map(({ id, fingerprint, anchors }) => ({ id, fingerprint, anchors })),
});
if (leanManifest.includes("]=]")) throw new Error("lean manifest contains unsafe Lua long-string delimiter ]=]");

const [port = "27977", password = "gallery-verify-only"] = process.argv.slice(2);

// The body may span many lines (the injected library is multi-line), but `/c` MUST be followed by
// real Lua on the SAME line — a leading `/c\n` makes Factorio echo the body instead of running it.
const command = `/c local FixtureMeters=(function() ${meters} end)()
local manifest=helpers.json_to_table([=[${leanManifest}]=])
local function table_size(value) local n=0 for _ in pairs(value or {}) do n=n+1 end return n end
local loop={beltCount=0,quantity=0,physicalStacks=0,maximumStack=0,lineQuantities={0,0}}
local omni_platform=FixtureMeters.surface_for_platform("lab-omnibus-state-v1")
if omni_platform then loop=FixtureMeters.measure_belt_loop(omni_platform,FixtureMeters.anchor_lookup(manifest,"belt-5x5-125-unstacked")) end
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
      mining_target=drill.mining_target and drill.mining_target.name or false,live_fluidbox_count=#drill.fluidbox,
      read_ok=read_ok,read_error=read_ok and nil or tostring(read_value),
      write_ok=write_ok,write_error=write_ok and nil or tostring(write_error)}
  else reachability={exists=true,drill_name=nil} end
end
local corpus=FixtureMeters.measure_corpus(manifest)
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
  source_belts=loop.beltCount,target_belts=0,source_quantity=loop.quantity,physical_stacks=loop.physicalStacks,
  maximum_stack=loop.maximumStack,source_line_quantities=loop.lineQuantities,target_quantity=0,
  index_texts=index_texts,index_tags=index and #game.forces.player.find_chart_tags(index)or 0,
  reachability=reachability,surface_settings=surface_settings,corpus=corpus,
  surface_census={total_entities=total_entities,total_generated_chunks=total_chunks,surface_names=surface_names}
}))`;

async function main() {
	const rcon = await Rcon.connect({ host: "127.0.0.1", port: Number(port), password });
	try {
		// Ship multi-line (strip \r only, KEEP \n): the injected fixture-meters library is heavily
		// line-commented, so collapsing newlines would swallow every `--` comment to end-of-command and
		// no-op the whole script. runtime-driver.cjs ships gallery-runtime.lua the same way (multi-line /c).
		const response = await rcon.send(command.replace(/\r/g, ""));
		const reading = JSON.parse(response.trim().split(/\r?\n/).filter(Boolean).at(-1));
		console.log(JSON.stringify({ status: "PASS", reading }));
		try { await rcon.send("/quit"); } catch { /* Expected when Factorio closes first. */ }
	} finally {
		try { rcon.end(); } catch { /* /quit can close first. */ }
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });
