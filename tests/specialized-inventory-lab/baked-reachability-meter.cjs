const { Rcon } = require("/clusterio/node_modules/rcon-client");

const [port, password, sectionsJson] = process.argv.slice(2);
const sections = JSON.parse(Buffer.from(sectionsJson, "base64").toString("utf8"));

// The whole body runs under pcall so a fixture-drift assert ("platform is missing",
// "requires exactly one electric-mining-drill") comes back as structured JSON instead of
// raw RCON text that dies in JSON.parse and buries the diagnostic.
// NOTE: no Lua `--` comments inside this string — newline collapse would comment out
// the remainder of the command (created/can_place are measured below, never hardcoded).
const command = `/c
local ok,failure=pcall(function()
local wanted=helpers.json_to_table([=[${JSON.stringify(sections)}]=])
local selected={} for _,name in ipairs(wanted)do selected[name]=true end
local platform=nil
for _,candidate in pairs(game.forces.player.platforms)do
  if candidate.valid and candidate.name=="lab-specialized-fluid-r1"then platform=candidate break end
end
assert(platform,"baked specialized reachability platform is missing")
local surface=platform.surface
local result={success=true}
if selected.prototype then
  local names={"chemical-plant","storage-tank","pump","flamethrower-turret","fluid-wagon","electric-mining-drill"}
  local entities={}
  for _,name in ipairs(names)do
    local proto=assert(prototypes.entity[name],"missing prototype "..name)
    local conditions={}
    for _,condition in ipairs(proto.surface_conditions or{})do
      local actual=surface.get_property(condition.property)
      conditions[#conditions+1]={property=condition.property,min=condition.min,max=condition.max,actual=actual,passes=actual>=condition.min and actual<=condition.max}
    end
    local position=surface.find_non_colliding_position(name,{x=20,y=0},8,0.5)
    local can_place=position~=nil and surface.can_place_entity{name=name,position=position,force=game.forces.player}or false
    entities[name]={fluidbox_count=#(proto.fluidbox_prototypes or{}),can_place=can_place,position=position,surface_conditions=conditions}
  end
  result.prototype={success=true,pin=script.active_mods.base,tick=game.tick,game_paused=not not game.tick_paused,
    platform_paused=platform.paused,platform={name=platform.name,index=platform.index,pressure=surface.get_property("pressure"),gravity=surface.get_property("gravity")},entities=entities}
end
if selected.placement then
  local drills=surface.find_entities_filtered{name="electric-mining-drill"}
  assert(#drills==1,"baked fixture requires exactly one electric-mining-drill")
  local drill=drills[1]
  local created=drill.valid==true
  local probe_position=surface.find_non_colliding_position("electric-mining-drill",{x=20,y=0},8,0.5)
  local can_place=probe_position~=nil and surface.can_place_entity{name="electric-mining-drill",position=probe_position,force=game.forces.player}or false
  local read_ok,read_value=pcall(function()return drill.fluidbox[1]end)
  local write_ok,write_error=pcall(function()drill.fluidbox[1]={name="water",amount=1}end)
  result.placement={success=true,pin=script.active_mods.base,tick=game.tick,game_paused=not not game.tick_paused,platform_paused=platform.paused,
    drill={name=drill.name,created=created,can_place=can_place,position=drill.position,mining_target=drill.mining_target and drill.mining_target.name or nil,
      live_fluidbox_count=#drill.fluidbox,read_ok=read_ok,read_value=read_ok and read_value or nil,read_error=read_ok and nil or tostring(read_value),
      write_ok=write_ok,write_error=write_ok and nil or tostring(write_error)}}
end
rcon.print(helpers.table_to_json(result))
end)
if not ok then rcon.print(helpers.table_to_json({success=false,error=tostring(failure)})) end`;

async function main() {
	const rcon = await Rcon.connect({ host: "127.0.0.1", port: Number(port), password, timeout: 15_000 });
	try {
		const response = await rcon.send(command.replace(/\s*\n\s*/g, " "));
		const line = response.trim().split(/\r?\n/).filter(Boolean).at(-1);
		let result;
		try { result = JSON.parse(line); }
		catch { throw new Error(`meter returned non-JSON RCON output (raw): ${response.trim().slice(0, 500)}`); }
		if (result?.success !== true) throw new Error(`baked fixture measurement failed: ${result?.error || "missing success=true"}`);
		console.log(JSON.stringify(result));
		try { await rcon.send("/quit"); } catch { /* Expected when Factorio exits first. */ }
	} finally {
		try { rcon.end(); } catch { /* /quit can close first. */ }
	}
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
