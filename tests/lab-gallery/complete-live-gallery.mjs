#!/usr/bin/env node
// complete-live-gallery.mjs — complete the LIVE gallery source-of-truth in place (2026-07-19).
//
// The owner is PLAYING on surface-export-lab-gallery (the live save is now the source of truth). This
// script does the completion work via RCON only — it NEVER stops/restarts/loads saves and never
// teleports the owner or deletes the omnibus platform. It ports the construction recipes from
// tests/lab-gallery/seed-prep-ops.lua (which normally run in the isolated seed-prep Factorio) to run
// directly against the live gallery, following the working RCON-construction patterns of
// rig-wave-belt-rigs.mjs / rig-wave-replay.mjs.
//
//   node tests/lab-gallery/complete-live-gallery.mjs --phase=survey
//   node tests/lab-gallery/complete-live-gallery.mjs --phase=build      (stamp + build the 3 missing pads)
//   node tests/lab-gallery/complete-live-gallery.mjs --phase=repair     (4 in-place defect repairs)
//   node tests/lab-gallery/complete-live-gallery.mjs --phase=verify     (read-only fingerprint census)
//   node tests/lab-gallery/complete-live-gallery.mjs --phase=checkpoint (server_save the source of truth)
//
// Phases are independent and re-runnable; construction ops are idempotent (skip-if-present).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LEGEND, TEMPLATE_ROWS } from "./test-foundation.mjs";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const GALLERY = "surface-export-lab-gallery";
const OMNIBUS = "lab-omnibus-state-v1";

const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("./manifest.json", import.meta.url)), "utf8"));
const fixtureById = id => manifest.fixtures.find(f => f.id === id);
const originOf = id => { const f = fixtureById(id); if (!f || !f.origin) throw new Error(`no origin for ${id}`); return f.origin; };
const anchorsOf = id => Object.fromEntries(((fixtureById(id) || {}).anchors || []).map(a => [a.entity, { x: a.x, y: a.y }]));
const cardOf = id => {
	const c = (fixtureById(id) || {}).testCard || {};
	return { law: c.law || "", action: c.action || "", expect: c.expected || "", forbidden: c.forbidden || "" };
};

function docker(args, timeout = 120_000) {
	return execFileSync("docker", args, {
		encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
	});
}
function rcon(command, timeout = 240_000) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", GALLERY, command, "--config", CTL_CONFIG], timeout).trim();
}
function luaJson(body, timeout = 240_000) {
	const raw = rcon(`/sc local out={} local ok,err=pcall(function() ${body} end) ` +
		`if not ok then out={success=false,error=tostring(err)} end rcon.print(helpers.table_to_json(out))`, timeout);
	const last = raw.split(/\r?\n/).filter(Boolean).at(-1) || "";
	try { return JSON.parse(last); }
	catch (error) { throw new Error(`unparseable Lua JSON (${error.message}): ${last.slice(0, 500)}`); }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Lua prelude: find the omnibus platform + surface by name (identity is name here only because the
// omnibus is unique in this save; all lookups are read-first).
const OMNI = `local plat for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${OMNIBUS}' then plat=p end end ` +
	`if not plat then out.success=false out.error='omnibus platform missing' return end local s=plat.surface `;

// Interior of a stamped pad: left 12x12 fixture area (matches seed-prep-ops interior_of).
function interiorCountLua(ox, oy) {
	return `local n=0 for _,e in ipairs(s.find_entities_filtered({area={{${ox},${oy}},{${ox}+13.5,${oy}+12}}})) do ` +
		`local p=e.position if p.x<${ox}+13.25 and p.y<${oy}+11.25 then n=n+1 end end`;
}

// ---- survey ---------------------------------------------------------------------------------------
function survey() {
	const padFixtures = manifest.fixtures.filter(f => f.padKind === "pad" && f.origin);
	const padProbe = padFixtures.map(f => {
		const { x, y } = f.origin;
		return `do ${interiorCountLua(x, y)} out.pads['${f.id}']={x=${x},y=${y},interior=n} end`;
	}).join(" ");
	const body = `${OMNI}
		out.success=true out.paused=plat.paused==true out.surface=s.name out.tick_paused=game.tick_paused==true
		out.total_entities=#s.find_entities_filtered({})
		out.pads={}
		${padProbe}
		-- defect a: decider latch signal-S on combinator_output_red
		local d=s.find_entities_filtered({name='decider-combinator',area={{68-0.6,-14-0.6},{68+0.6,-14+0.6}}})[1]
		if d then local net=d.get_circuit_network(defines.wire_connector_id.combinator_output_red)
			out.latch={found=true,signalS=net and net.get_signal({type='virtual',name='signal-S'}) or nil,active=d.active,destructible=d.destructible}
		else out.latch={found=false} end
		-- defect b: inserter-held bulk-inserter destructible
		local bi=s.find_entities_filtered({name='bulk-inserter',area={{98.5-0.6,13.5-0.6},{98.5+0.6,13.5+0.6}}})[1]
		if bi then out.bulk_inserter={found=true,destructible=bi.destructible,active=bi.active,held=bi.held_stack.valid_for_read and bi.held_stack.count or 0} else out.bulk_inserter={found=false} end
		-- defect c: no-tick pair destructibles (machine 13.5,27.5 ; inserter 16.5,27.5)
		local m=s.find_entities_filtered({name='assembling-machine-1',area={{13.5-0.6,27.5-0.6},{13.5+0.6,27.5+0.6}}})[1]
		local ni=s.find_entities_filtered({name='inserter',area={{16.5-0.6,27.5-0.6},{16.5+0.6,27.5+0.6}}})[1]
		out.no_tick={machine=m and {destructible=m.destructible,active=m.active} or nil, inserter=ni and {destructible=ni.destructible,active=ni.active} or nil}
		-- defect d: item-request-proxies in ghosts pad rect (origin 36,8 -> interior)
		local proxies={}
		for _,px in ipairs(s.find_entities_filtered({type='item-request-proxy',area={{36,8},{36+13.5,8+12}}})) do
			local tgt=px.proxy_target
			proxies[#proxies+1]={x=px.position.x,y=px.position.y,target=tgt and tgt.name or nil}
		end
		out.ghost_proxies=proxies
		-- all item-request-proxies on the omnibus (whole surface) for context
		out.all_proxies=#s.find_entities_filtered({type='item-request-proxy'})`;
	const result = luaJson(body);
	console.log(JSON.stringify(result, null, 2));
}

// Embed a JS value as a Lua single-quoted JSON literal for helpers.json_to_table (escape ' like
// rig-wave does). JSON.stringify already escapes newlines/quotes inside the JSON.
function jlit(value) { return JSON.stringify(value).replace(/'/g, "\\'"); }

// ---- stamp a test-foundation cell (ported from seed-prep-ops.lua stamp_test_cell) ----------------
function stampCell(id) {
	const { x: ox, y: oy } = originOf(id);
	const body = `${OMNI}
		local rows=helpers.json_to_table('${jlit(TEMPLATE_ROWS)}')
		local legend=helpers.json_to_table('${jlit(LEGEND)}')
		local card=helpers.json_to_table('${jlit(cardOf(id))}')
		local ox,oy=${Math.trunc(ox)},${Math.trunc(oy)}
		local tiles,mismatch,already={},0,0
		for r=1,#rows do local row=rows[r] for c=1,#row do
			local ch=string.sub(row,c,c) local want=legend[ch]
			if want then local x,y=ox+c-1,oy+r-1 local cur=s.get_tile(x,y).name
				if cur==want then already=already+1
				elseif cur=='empty-space' or cur=='space-platform-foundation' then tiles[#tiles+1]={name=want,position={x,y}}
				else mismatch=mismatch+1 end
			end
		end end
		if mismatch>0 then out.success=false out.error='REFUSED: '..mismatch..' target tile(s) hold foreign tiles' return end
		if #tiles>0 then s.set_tiles(tiles) end
		local dpx,dpy=ox+13.5,oy+11.5
		local desc=s.find_entities_filtered({name='display-panel',area={{dpx-0.4,dpy-0.4},{dpx+0.4,dpy+0.4}}})[1]
		if not desc then desc=s.create_entity({name='display-panel',position={dpx,dpy},force='player'}) end
		if not desc then out.success=false out.error='desc panel failed' return end
		local function cf(f) return tostring(card[f] or '') end
		desc.display_panel_text='LAW: \\n'..cf('law')..'\\n\\nACTION: \\n'..cf('action')..'\\n\\nEXPECT: \\n'..cf('expect')..'\\n\\nFORBIDDEN: \\n'..cf('forbidden')
		local ccx,ccy=ox+14.5,oy+11.5
		local comb=s.find_entities_filtered({name='constant-combinator',area={{ccx-0.4,ccy-0.4},{ccx+0.4,ccy+0.4}}})[1]
		if not comb then comb=s.create_entity({name='constant-combinator',position={ccx,ccy},force='player'}) end
		if not comb then out.success=false out.error='combinator failed' return end
		local cb=comb.get_or_create_control_behavior()
		local sec1=cb.sections[1] or cb.add_section()
		local sec2=cb.sections[2] or cb.add_section()
		sec1.filters={{value={type='virtual',name='signal-check',quality='normal',comparator='='},min=1}}
		sec2.filters={{value={type='virtual',name='signal-deny',quality='normal',comparator='='},min=1}}
		sec1.active=false sec2.active=false
		local spx,spy=ox+15.5,oy+11.5
		local status=s.find_entities_filtered({name='display-panel',area={{spx-0.4,spy-0.4},{spx+0.4,spy+0.4}}})[1]
		if not status then status=s.create_entity({name='display-panel',position={spx,spy},force='player'}) end
		if not status then out.success=false out.error='status panel failed' return end
		status.display_panel_always_show=true status.display_panel_show_in_chart=true
		status.get_wire_connector(defines.wire_connector_id.circuit_red,true).connect_to(comb.get_wire_connector(defines.wire_connector_id.circuit_red,true))
		status.get_or_create_control_behavior().messages={
			{icon={type='virtual',name='signal-check'},text='Success',condition={first_signal={type='virtual',name='signal-check'},comparator='>',constant=0}},
			{icon={type='virtual',name='signal-alert'},text='Failure {failure-message}',condition={first_signal={type='virtual',name='signal-deny'},comparator='>',constant=0}},
			{icon={type='virtual',name='signal-clock'},condition={first_signal={type='virtual',name='signal-everything'},comparator='=',constant=0}}}
		local tx,ty=ox+6,oy-1.5 local has_name=false
		for _,o in pairs(rendering.get_all_objects('')) do
			if o.valid and o.type=='text' and o.surface==s then local t=o.target
				if t and t.position and t.position.x==tx and t.position.y==ty then has_name=true break end end
		end
		if not has_name then rendering.draw_text({text='${id}',surface=s,target={tx,ty},scale=2.5,color={r=0.3,g=0.85,b=1,a=1}}) end
		out.success=true out.wrote=#tiles out.already=already out.trio=(desc~=nil and comb~=nil and status~=nil)`;
	return luaJson(body);
}

// ---- inline meters (fixture-meters.lua logic; the live module require path is unavailable) --------
const AT = `local function at(name,x,y) return s.find_entities_filtered({name=name,area={{x-0.6,y-0.6},{x+0.6,y+0.6}}})[1] end `;

function measureRepinBeacon() {
	const a = anchorsOf("repin-beacon-speed");
	const body = `${OMNI}${AT}
		local beacon=at('beacon',${a.beacon.x},${a.beacon.y})
		local m=at('assembling-machine-2',${a["assembling-machine-2"].x},${a["assembling-machine-2"].y})
		if not beacon or not m then out.success=false out.error='repin entities missing' return end
		local modules=beacon.get_inventory(defines.inventory.beacon_modules)
		out.success=true out.machineSpeed=m.crafting_speed
		out.beaconModulesEmpty=modules~=nil and modules.is_empty()
		out.beaconActive=beacon.active out.machineActive=m.active
		out.allIndestructible=(not beacon.destructible) and (not m.destructible)`;
	return luaJson(body);
}

function buildRepinBeacon() {
	const a = anchorsOf("repin-beacon-speed");
	const bp = a.beacon, mp = a["assembling-machine-2"];
	const body = `${OMNI}
		local force=game.forces['player']
		if force.recipes['iron-gear-wheel'] then force.recipes['iron-gear-wheel'].enabled=true end
		for _,spec in ipairs({{name='beacon',x=${bp.x},y=${bp.y}},{name='assembling-machine-2',x=${mp.x},y=${mp.y}}}) do
			local ex=s.find_entities_filtered({name=spec.name,area={{spec.x-0.4,spec.y-0.4},{spec.x+0.4,spec.y+0.4}}})[1]
			if ex then ex.destroy() end
		end
		local beacon=s.create_entity({name='beacon',position={${bp.x},${bp.y}},force='player'})
		if not beacon then out.success=false out.error='beacon placement failed' return end
		local m=s.create_entity({name='assembling-machine-2',position={${mp.x},${mp.y}},force='player'})
		if not m then out.success=false out.error='am2 placement failed' return end
		m.set_recipe('iron-gear-wheel') m.active=false
		beacon.destructible=false m.destructible=false
		local modules=beacon.get_inventory(defines.inventory.beacon_modules)
		out.success=true out.machineSpeed=m.crafting_speed
		out.beaconModulesEmpty=modules~=nil and modules.is_empty()
		out.beaconActive=beacon.active out.machineActive=m.active
		out.allIndestructible=(not beacon.destructible) and (not m.destructible)`;
	return luaJson(body);
}

// ---- belt corner (ported build_belt_corner_pad / feed_belt_corner / measure_belt_corner) ---------
function buildBeltCorner() {
	const a = anchorsOf("belt-corner-recovery");
	const { x: cx, y: cy } = a["turbo-transport-belt"];
	// 6 belts flowing EAST into a NORTH corner + one north dead-end. Only platform.paused is touched
	// (belt travel gate); the global game.tick_paused is left alone so the owner's session is untouched.
	const body = `${OMNI}
		local was_paused=plat.paused plat.paused=false
		local cx,cy=${cx},${cy}
		local specs={}
		for i=6,1,-1 do specs[#specs+1]={x=cx-i,y=cy,dir=defines.direction.east} end
		specs[#specs+1]={x=cx,y=cy,dir=defines.direction.north}
		specs[#specs+1]={x=cx,y=cy-1,dir=defines.direction.north}
		for _,e in ipairs(s.find_entities_filtered({type='transport-belt',area={{cx-8,cy-4},{cx+4,cy+4}}})) do if e.valid then e.destroy() end end
		local built=0
		for _,spec in ipairs(specs) do
			local e=s.create_entity({name='turbo-transport-belt',position={spec.x,spec.y},direction=spec.dir,force='player'})
			if not e then out.success=false out.error='belt placement failed at ('..spec.x..','..spec.y..')' return end
			e.destructible=false built=built+1
		end
		out.success=true out.built=built out.entry={x=cx-6,y=cy} out.corner={x=cx,y=cy} out.paused_before=was_paused`;
	return luaJson(body);
}
function feedBeltCorner(entry, corner) {
	const body = `${OMNI}
		local entry=s.find_entities_filtered({name='turbo-transport-belt',position={${entry.x},${entry.y}},radius=0.9})[1]
		if not entry then out.success=false out.error='entry belt missing' return end
		local added=0
		for li=1,2 do local line=entry.get_transport_line(li)
			for slot=0,3 do if line.insert_at(0.125+slot*0.25,{name='iron-plate',count=1},1) then added=added+1 end end
		end
		local total,inside=0,0
		for _,b in ipairs(s.find_entities_filtered({type='transport-belt',area={{${corner.x}-8,${corner.y}-4},{${corner.x}+4,${corner.y}+4}}})) do
			for li=1,b.get_max_transport_line_index() do total=total+#b.get_transport_line(li).get_detailed_contents() end
		end
		local c=s.find_entity('turbo-transport-belt',{${corner.x},${corner.y}})
		if c then inside=#c.get_transport_line(1).get_detailed_contents() end
		out.success=true out.added=added out.total=total out.inside=inside`;
	return luaJson(body);
}
function measureBeltCorner() {
	const a = anchorsOf("belt-corner-recovery");
	const { x: cx, y: cy } = a["turbo-transport-belt"];
	const body = `${OMNI}
		local cx,cy=${cx},${cy}
		local area={{cx-8,cy-4},{cx+4,cy+4}}
		local belts=s.find_entities_filtered({type='transport-belt',area=area})
		local total=0
		for _,b in ipairs(belts) do for li=1,b.get_max_transport_line_index() do
			for _,row in ipairs(b.get_transport_line(li).get_detailed_contents()) do total=total+row.stack.count end end end
		local corner=s.find_entity('turbo-transport-belt',{cx,cy})
		local inside=corner and corner.get_transport_line(1) or nil
		local ic=0 if inside then for _,row in ipairs(inside.get_detailed_contents()) do ic=ic+row.stack.count end end
		local overpacked,lanes=0,0
		for _,b in ipairs(belts) do for li=1,b.get_max_transport_line_index() do
			local line=b.get_transport_line(li) local n=#line.get_detailed_contents() lanes=lanes+1
			if n>0 and (n*0.24)>line.line_length then overpacked=overpacked+1 end end end
		out.success=true out.beltCount=#belts out.totalIron=total
		out.cornerShape=corner and corner.belt_shape or nil
		out.cornerX=corner and corner.position.x or nil out.cornerY=corner and corner.position.y or nil
		out.insideItems=ic out.insideLength=inside and inside.line_length or nil
		out.overpacked=overpacked out.lanes=lanes`;
	return luaJson(body);
}

// ---- belt loop (ported build_belt_loop_pad / feed_belt_loop / measure_belt_loop) -----------------
function buildBeltLoop() {
	const a = anchorsOf("belt-5x5-125-unstacked");
	const ap = a["turbo-transport-belt"];
	const belts = buildFiveByFiveLoop({ x: ap.x, y: ap.y });
	const body = `${OMNI}
		local was_paused=plat.paused plat.paused=false
		local belts=helpers.json_to_table('${jlit(belts)}')
		for _,e in ipairs(s.find_entities_filtered({type='transport-belt',area={{${ap.x}-1,${ap.y}-1},{${ap.x}+6,${ap.y}+6}}})) do if e.valid then e.destroy() end end
		local built=0
		for _,d in ipairs(belts) do
			local dir=defines.direction[d.direction]
			if dir==nil then out.success=false out.error='unknown dir '..tostring(d.direction) return end
			local e=s.create_entity({name=d.name,position={d.position.x,d.position.y},direction=dir,force='player'})
			if not e then out.success=false out.error=d.name..' placement failed' return end
			e.destructible=false built=built+1
		end
		out.success=true out.built=built out.paused_before=was_paused`;
	return luaJson(body);
}
function feedBeltLoop(target = 125) {
	const a = anchorsOf("belt-5x5-125-unstacked");
	const ap = a["turbo-transport-belt"];
	const body = `${OMNI}
		local belts=s.find_entities_filtered({type='transport-belt',area={{${ap.x}-1,${ap.y}-1},{${ap.x}+6,${ap.y}+6}}})
		local function count() local seen,t={},0
			for _,b in ipairs(belts) do for li=1,b.get_max_transport_line_index() do
				for _,row in ipairs(b.get_transport_line(li).get_detailed_contents()) do
					if not seen[row.unique_id] then seen[row.unique_id]=true t=t+1 end end end end
			return t end
		local before=count() local added=0
		if before<${target} then for _,b in ipairs(belts) do for li=1,b.get_max_transport_line_index() do
			if before+added>=${target} then break end
			if b.get_transport_line(li).insert_at(0.125,{name='iron-plate',count=1},1) then added=added+1 end end
			if before+added>=${target} then break end end end
		out.success=true out.added=added out.total=before+added`;
	return luaJson(body);
}
function measureBeltLoop() {
	const a = anchorsOf("belt-5x5-125-unstacked");
	const ap = a["turbo-transport-belt"];
	const body = `${OMNI}
		local belts=s.find_entities_filtered({type='transport-belt',area={{${ap.x}-1,${ap.y}-1},{${ap.x}+6,${ap.y}+6}}})
		local function census(sel) local seen,q,mx,ps={},0,0,0
			for _,b in ipairs(belts) do if b.valid then
				local f=sel or 1 local l=sel or b.get_max_transport_line_index()
				for li=f,l do for _,row in ipairs(b.get_transport_line(li).get_detailed_contents()) do
					if not seen[row.unique_id] then seen[row.unique_id]=true q=q+row.stack.count
						mx=math.max(mx,row.stack.count) ps=ps+1 end end end
			end end
			return q,mx,ps end
		local q,mx,ps=census(nil) local q1=select(1,census(1)) local q2=select(1,census(2))
		local item=nil
		for _,b in ipairs(belts) do for li=1,b.get_max_transport_line_index() do
			local row=b.get_transport_line(li).get_detailed_contents()[1] if row then item=row.stack.name break end end
			if item then break end end
		out.success=true out.beltName=belts[1] and belts[1].name or nil out.beltCount=#belts
		out.itemName=item out.quantity=q out.physicalStacks=ps out.maximumStack=mx
		out.lineQuantities={q1,q2}`;
	return luaJson(body);
}
// ---- inline omnibus corpus meters (ported from fixture-meters.lua measure_omnibus_*) -------------
function measureOmnibusAll() {
	const A = id => anchorsOf(id);
	const adv = A("omnibus-adversarial-inventory"), heat = A("omnibus-heat-temperature");
	const mid = A("omnibus-midcraft-progress"), burn = A("omnibus-burner-fuel");
	const eq = A("omnibus-equipment-grid"), cir = A("omnibus-circuit-config");
	const bon = A("omnibus-module-bonus-progress"), flu = A("omnibus-crafting-fluids");
	const ins = A("inserter-held-capacity"), nt = A("no-tick-sync-frozen-pair");
	const body = `${OMNI}${AT}
		local reads={}
		local function safe(id,fn) local ok,r=pcall(fn) if ok then reads[id]=r else reads[id]={error=tostring(r)} end end
		safe('omnibus-adversarial-inventory',function()
			local chest=at('steel-chest',${adv["steel-chest"].x},${adv["steel-chest"].y})
			local inv=chest.get_inventory(defines.inventory.chest) local armor
			for i=1,#inv do local st=inv[i] if st.valid_for_read and st.name=='power-armor-mk2' then armor=st break end end
			local r={} for _,e in ipairs(armor.grid.equipment) do
				if e.name=='battery-mk2-equipment' then r.battEnergy=e.energy r.battQuality=e.quality.name end
				if e.name=='energy-shield-mk2-equipment' then r.shieldValue=e.shield r.shieldMax=e.max_shield r.shieldQuality=e.quality.name end end
			local m=at('assembling-machine-2',${adv["assembling-machine-2"].x},${adv["assembling-machine-2"].y})
			local recipe,quality=m.get_recipe() r.recipe=recipe and recipe.name or nil r.recipeQuality=quality and quality.name or nil
			return r end)
		safe('omnibus-heat-temperature',function() return {temperature=at('heat-pipe',${heat["heat-pipe"].x},${heat["heat-pipe"].y}).temperature} end)
		safe('omnibus-decider-latch',function()
			local d=at('decider-combinator',68,-14)
			local net=d.get_circuit_network(defines.wire_connector_id.combinator_output_red)
			return {signalS=net and net.get_signal({type='virtual',name='signal-S'}) or nil} end)
		safe('omnibus-midcraft-progress',function()
			local m=at('assembling-machine-1',${mid["assembling-machine-1"].x},${mid["assembling-machine-1"].y})
			local inv=m.get_inventory(defines.inventory.assembling_machine_input)
			return {progress=m.crafting_progress,active=m.active,inputPlates=inv and inv.get_item_count('iron-plate') or nil} end)
		safe('omnibus-burner-fuel',function()
			local bi=at('burner-inserter',${burn["burner-inserter"].x},${burn["burner-inserter"].y})
			local fi=bi.get_inventory(defines.inventory.fuel)
			return {coal=fi and fi.get_item_count('coal') or nil,active=bi.active,
				burning=bi.burner and bi.burner.currently_burning and bi.burner.currently_burning.name.name or nil,
				remaining=bi.burner and bi.burner.remaining_burning_fuel or nil} end)
		safe('omnibus-equipment-grid',function()
			local sp=at('spidertron',${eq.spidertron.x},${eq.spidertron.y}) local r={holder='spidertron'}
			for _,e in ipairs(sp.grid.equipment) do if e.name=='battery-mk2-equipment' then r.battEnergy=e.energy r.battMax=e.max_energy end end
			return r end)
		safe('omnibus-circuit-config',function()
			local cc=at('constant-combinator',${cir["constant-combinator"].x},${cir["constant-combinator"].y})
			local b=cc.get_control_behavior() local r={}
			local sec=b.sections and b.sections[1]
			if sec then local f=sec.filters and sec.filters[1] if f then r.constantSignal=f.value and f.value.name or nil r.constantMin=f.min end end
			local lamp=at('small-lamp',${cir["small-lamp"].x},${cir["small-lamp"].y}) local lb=lamp.get_control_behavior()
			if lb then r.lampUseColors=lb.use_colors end return r end)
		safe('omnibus-module-bonus-progress',function()
			local m=at('assembling-machine-2',${bon["assembling-machine-2"].x},${bon["assembling-machine-2"].y})
			local mi=m.get_module_inventory()
			return {bonusProgress=m.bonus_progress,modules=mi and mi.get_item_count('productivity-module') or nil,active=m.active} end)
		safe('omnibus-crafting-fluids',function()
			local r={} local tank=at('storage-tank',${flu["storage-tank"].x},${flu["storage-tank"].y})
			if tank.fluidbox[1] then r.steam=tank.fluidbox[1].amount r.steamTemp=tank.fluidbox[1].temperature end
			local chem=at('chemical-plant',${flu["chemical-plant"].x},${flu["chemical-plant"].y})
			for i=1,#chem.fluidbox do local f=chem.fluidbox[i] if f then if f.name=='water' then r.chemWater=f.amount elseif f.name=='petroleum-gas' then r.chemGas=f.amount end end end
			local fo=at('foundry',${flu.foundry.x},${flu.foundry.y})
			for i=1,#fo.fluidbox do local f=fo.fluidbox[i] if f and f.name=='molten-iron' then r.foundryMolten=f.amount r.foundryTemp=f.temperature end end
			return r end)
		safe('omnibus-ghosts-and-proxies',function()
			local g=s.find_entities_filtered({type='entity-ghost'})
			return {entityGhosts=#g,tileGhosts=#s.find_entities_filtered({type='tile-ghost'}),
				proxies=#s.find_entities_filtered({type='item-request-proxy'}),ghostInner=g[1] and g[1].ghost_name or nil} end)
		safe('omnibus-ground-items',function()
			local t=0 for _,e in pairs(s.find_entities_filtered({type='item-entity'})) do
				local st=e.stack if st and st.valid_for_read and st.name=='iron-plate' then t=t+st.count end end
			return {ironPlate=t} end)
		safe('omnibus-platform-schedule',function()
			local sc=plat.get_schedule() local recs=sc.get_records() local ints=sc.get_interrupts()
			return {records=#recs,interrupts=#ints,interruptName=ints[1] and ints[1].name or nil} end)
		safe('inserter-held-capacity',function()
			local i=at('bulk-inserter',${ins["bulk-inserter"].x},${ins["bulk-inserter"].y}) local h=i.held_stack
			return {heldCount=h.valid_for_read and h.count or 0,heldName=h.valid_for_read and h.name or nil,
				quality=(h.valid_for_read and h.quality) and h.quality.name or nil,active=i.active,destructible=i.destructible,
				forceBulkBonus=game.forces.player.bulk_inserter_capacity_bonus} end)
		safe('no-tick-sync-frozen-pair',function()
			local m=at('assembling-machine-1',${nt["assembling-machine-1"].x},${nt["assembling-machine-1"].y})
			local i=at('inserter',${nt.inserter.x},${nt.inserter.y})
			local input=m.get_inventory(defines.inventory.crafter_input) local recipe=m.get_recipe()
			return {progress=m.crafting_progress,recipe=recipe and recipe.name or nil,inputPlates=input and input.get_item_count('iron-plate') or nil,
				assemblerActive=m.active,inserterActive=i.active,inserterHandEmpty=not i.held_stack.valid_for_read,
				allIndestructible=(not m.destructible) and (not i.destructible)} end)
		out.success=true out.reads=reads`;
	const result = luaJson(body);
	if (result.success === false) throw new Error(`omnibus measure failed: ${result.error}`);
	return result.reads;
}
function setOmnibusPaused(paused) {
	return luaJson(`${OMNI} plat.paused=${paused ? "true" : "false"} out.success=true out.paused=plat.paused==true`);
}

async function main() {
	let phase = "survey";
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith("--phase=")) phase = arg.slice(8);
		else throw new Error(`unknown arg ${arg}`);
	}
	if (phase === "survey") return survey();
	if (phase === "build-beacon") {
		const id = "repin-beacon-speed";
		const stamp = stampCell(id);
		console.log("stamp:", JSON.stringify(stamp));
		if (stamp.success === false) throw new Error(`stamp failed: ${stamp.error}`);
		const built = buildRepinBeacon();
		console.log("build:", JSON.stringify(built));
		if (built.success === false) throw new Error(`build failed: ${built.error}`);
		const measured = measureRepinBeacon();
		console.log("measure:", JSON.stringify(measured));
		return;
	}
	if (phase === "checkpoint") {
		const saveName = "gallery-source-of-truth-2026-07-19";
		const container = "surface-export-host-2";
		const savePath = `/clusterio/data/instances/${GALLERY}/saves/${saveName}.zip`;
		console.log("server_save:", rcon(`/sc game.server_save('${saveName}')`).slice(0, 200));
		// Poll until the zip exists and its size is stable (write complete).
		let prev = -1, stableReads = 0;
		for (let i = 0; i < 60 && stableReads < 3; i += 1) {
			await sleep(1500);
			let size = -1;
			try { size = Number(docker(["exec", container, "sh", "-c", `stat -c %s '${savePath}' 2>/dev/null || echo -1`]).trim()); }
			catch { size = -1; }
			if (size > 0 && size === prev) stableReads += 1; else stableReads = 0;
			prev = size;
		}
		if (prev <= 0) throw new Error(`checkpoint save did not appear at ${savePath}`);
		console.log(JSON.stringify({ saveName, savePath, sizeBytes: prev, stable: stableReads >= 3 }, null, 2));
		return;
	}
	if (phase === "verify") {
		// Inline per-fixture measurement (fixture-meters.lua logic, ported; the IIFE single-source path
		// exceeds the Windows command-line limit and require is unavailable on the live save). Each read
		// is compared in JS against the manifest fingerprint using the same tolerance policy as
		// corpus_gate (exact, except a 1e-9 window on the crafting/bonus progress doubles).
		const reads = { ...measureOmnibusAll(), "repin-beacon-speed": measureRepinBeacon(),
			"belt-corner-recovery": measureBeltCorner(), "belt-5x5-125-unstacked": measureBeltLoop() };
		const tolerant = new Set(["progress", "bonusProgress"]);
		const report = [];
		for (const f of manifest.fixtures) {
			const r = reads[f.id];
			if (r === undefined) { report.push({ id: f.id, status: "not-measured (platform/off-omnibus)" }); continue; }
			if (r && r.error) { report.push({ id: f.id, status: "MEASURE-ERROR", error: r.error }); continue; }
			const drifts = [];
			for (const [k, expected] of Object.entries(f.fingerprint || {})) {
				const actual = r[k];
				let ok;
				if (Array.isArray(expected)) ok = JSON.stringify(actual) === JSON.stringify(expected);
				else if (tolerant.has(k) && typeof actual === "number" && typeof expected === "number") ok = Math.abs(actual - expected) <= 1e-9;
				else ok = actual === expected;
				if (!ok) drifts.push(`${k}=${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
			}
			report.push({ id: f.id, status: drifts.length ? "DRIFT" : "PASS", ...(drifts.length ? { drifts } : {}) });
		}
		console.log(JSON.stringify({ report, reads }, null, 2));
		return;
	}
	if (phase === "census") {
		const body = `
			out.success=true out.platforms={} local totalPlat=0
			for _,p in pairs(game.forces.player.platforms) do if p.valid then totalPlat=totalPlat+1
				out.platforms[#out.platforms+1]={name=p.name,surface=p.surface.name,paused=p.paused==true,entities=#p.surface.find_entities_filtered({})}
			end end
			out.platformCount=totalPlat
			out.surfaces={} for _,s in pairs(game.surfaces) do out.surfaces[#out.surfaces+1]={name=s.name,entities=#s.find_entities_filtered({})} end
			out.surfaceCount=#game.surfaces
			out.tickPaused=game.tick_paused==true
			out.players={} for _,pl in pairs(game.connected_players) do out.players[#out.players+1]={name=pl.name,surface=pl.surface.name} end
			-- leftovers: no stray plugin state
			local function n(t) local c=0 for _ in pairs(t or {}) do c=c+1 end return c end
			out.storage={jobs=n(storage.async_jobs),locks=n(storage.locked_platforms),holds=n(storage.destination_holds)}`;
		console.log(JSON.stringify(luaJson(body), null, 2));
		return;
	}
	if (phase === "latch-repair") {
		// The decider is structurally intact (self-wired, IF signal-S>0 THEN signal-S=1) but active=false,
		// so it emits nothing and the held signal dropped to 0. Activate it, seed signal-S=1 once, let the
		// self-loop grab it (platform unpaused → ticks flow), remove the seed, leave the decider ACTIVE.
		const seed = luaJson(`${OMNI}
			local d=s.find_entities_filtered({name='decider-combinator',area={{68-0.6,-14-0.6},{68+0.6,-14+0.6}}})[1]
			if not d then out.success=false out.error='decider missing' return end
			d.active=true
			-- place a temp seed constant-combinator at the first free tile near the decider
			local seed=nil
			for _,off in ipairs({{0,-2},{0,2},{-2,0},{2,0},{2,-2},{-2,-2},{2,2},{-2,2}}) do
				local pos={d.position.x+off[1],d.position.y+off[2]}
				local ok,e=pcall(function() return s.create_entity({name='constant-combinator',position=pos,force='player'}) end)
				if ok and e and e.valid then seed=e break end
			end
			if not seed then out.success=false out.error='no free tile for temp seed' return end
			local cb=seed.get_or_create_control_behavior()
			local sec=cb.get_section(1) or cb.add_section()
			sec.set_slot(1,{value={type='virtual',name='signal-S',quality='normal',comparator='='},min=1})
			local wired=seed.get_wire_connector(defines.wire_connector_id.circuit_red,true).connect_to(d.get_wire_connector(defines.wire_connector_id.combinator_input_red,true),false)
			out.success=true out.seedPos={x=seed.position.x,y=seed.position.y} out.wired=wired out.deciderActive=d.active`);
		console.log("seed:", JSON.stringify(seed));
		if (seed.success === false) throw new Error(`latch seed: ${seed.error}`);
		if (seed.wired !== true) throw new Error("latch seed wire did not connect");
		await sleep(2500); // let ticks flow so the latch grabs the seed
		const grabbed = luaJson(`${OMNI}
			local d=s.find_entities_filtered({name='decider-combinator',area={{68-0.6,-14-0.6},{68+0.6,-14+0.6}}})[1]
			local net=d.get_circuit_network(defines.wire_connector_id.combinator_output_red)
			out.success=true out.outSignalS=net and net.get_signal({type='virtual',name='signal-S'}) or nil`);
		console.log("after grab (seed present):", JSON.stringify(grabbed));
		// Remove the seed; the self-loop must hold with no external input.
		const remove = luaJson(`${OMNI}
			local seeds=s.find_entities_filtered({name='constant-combinator',area={{${seed.seedPos.x}-0.6,${seed.seedPos.y}-0.6},{${seed.seedPos.x}+0.6,${seed.seedPos.y}+0.6}}})
			local removed=0 for _,e in ipairs(seeds) do if e.valid then e.destroy() removed=removed+1 end end
			out.success=true out.removed=removed`);
		console.log("seed remove:", JSON.stringify(remove));
		await sleep(1800); // prove it holds after seed removal
		const held = luaJson(`${OMNI}
			local d=s.find_entities_filtered({name='decider-combinator',area={{68-0.6,-14-0.6},{68+0.6,-14+0.6}}})[1]
			if not d then out.success=false out.error='decider missing' return end
			d.destructible=false
			local net=d.get_circuit_network(defines.wire_connector_id.combinator_output_red)
			-- confirm no stray seed constant-combinator remains anywhere in the latch pad
			local strays=#s.find_entities_filtered({name='constant-combinator',area={{64,-20},{64+13.5,-20+12}}})
			out.success=true out.outSignalS=net and net.get_signal({type='virtual',name='signal-S'}) or nil
			out.active=d.active out.destructible=d.destructible out.strayConstantsInPad=strays`);
		console.log("held (seed removed):", JSON.stringify(held));
		if (held.outSignalS !== 1) throw new Error(`latch did not hold signal-S=1: ${JSON.stringify(held)}`);
		return;
	}
	if (phase === "latch-inspect") {
		const body = `${OMNI}
			local d=s.find_entities_filtered({name='decider-combinator',area={{68-0.6,-14-0.6},{68+0.6,-14+0.6}}})[1]
			if not d then out.success=false out.error='decider missing' return end
			out.success=true out.active=d.active out.destructible=d.destructible
			out.pos={x=d.position.x,y=d.position.y}
			local outnet=d.get_circuit_network(defines.wire_connector_id.combinator_output_red)
			out.outSignalS=outnet and outnet.get_signal({type='virtual',name='signal-S'}) or nil
			local innet=d.get_circuit_network(defines.wire_connector_id.combinator_input_red)
			out.inSignalS=innet and innet.get_signal({type='virtual',name='signal-S'}) or nil
			-- self-wire: does input_red connect to output_red of the SAME entity?
			local inc=d.get_wire_connector(defines.wire_connector_id.combinator_input_red,false)
			local selfwired=false
			if inc then for _,conn in ipairs(inc.connections) do
				local t=conn.target if t and t.owner==d then selfwired=true end end end
			out.selfWired=selfwired
			local b=d.get_or_create_control_behavior()
			local p=b.parameters
			out.condCount=p.conditions and #p.conditions or 0
			local c1=p.conditions and p.conditions[1]
			if c1 then out.cond1={sig=c1.first_signal and c1.first_signal.name or nil,cmp=c1.comparator,const=c1.constant} end
			local o1=p.outputs and p.outputs[1]
			if o1 then out.out1={sig=o1.signal and o1.signal.name or nil,copy=o1.copy_count_from_input} end`;
		console.log(JSON.stringify(luaJson(body), null, 2));
		return;
	}
	if (phase === "build-belts") {
		// Corner (64,22): 6 east belts -> north corner + dead-end; feed the entry until 2 dry rounds.
		const corner = { id: "belt-corner-recovery" };
		console.log("corner stamp:", JSON.stringify(stampCell(corner.id)));
		const cbuilt = buildBeltCorner();
		console.log("corner build:", JSON.stringify(cbuilt));
		if (cbuilt.success === false) throw new Error(`corner build: ${cbuilt.error}`);
		const pausedBefore = cbuilt.paused_before === true;
		let fed = 0, stable = 0, rounds = 0;
		while (stable < 3 && rounds < 60) {
			rounds += 1;
			const feed = feedBeltCorner(cbuilt.entry, cbuilt.corner);
			if (feed.success === false) throw new Error(`corner feed: ${feed.error}`);
			fed += feed.added;
			if (rounds % 5 === 0 || feed.added === 0) console.log(`corner round ${rounds}: added=${feed.added} total=${feed.total} inside=${feed.inside}`);
			if (feed.added === 0) stable += 1; else stable = 0;
			await sleep(600);
		}
		const cmeasured = measureBeltCorner();
		console.log(`corner measured (fed=${fed} rounds=${rounds}):`, JSON.stringify(cmeasured));
		if (!(cmeasured.overpacked >= 1)) console.log("WARNING: corner not over-packed");

		// Loop (92,22): 16-belt 5x5; feed toward 125, then poll until the split is stable across 3 reads.
		const loop = { id: "belt-5x5-125-unstacked" };
		console.log("loop stamp:", JSON.stringify(stampCell(loop.id)));
		const lbuilt = buildBeltLoop();
		console.log("loop build:", JSON.stringify(lbuilt));
		if (lbuilt.success === false) throw new Error(`loop build: ${lbuilt.error}`);
		let total = 0, dry = 0, lrounds = 0;
		while (total < 125 && dry < 3 && lrounds < 200) {
			lrounds += 1;
			const feed = feedBeltLoop(125);
			if (feed.success === false) throw new Error(`loop feed: ${feed.error}`);
			total = feed.total;
			if (lrounds % 10 === 0 || feed.added === 0) console.log(`loop round ${lrounds}: added=${feed.added} total=${feed.total}`);
			if (feed.added === 0) dry += 1; else dry = 0;
			await sleep(600);
		}
		let last = null, lstable = 0, polls = 0, lmeasured = null;
		while (lstable < 3 && polls < 40) {
			polls += 1;
			lmeasured = measureBeltLoop();
			if (lmeasured.success === false) throw new Error(`loop measure: ${lmeasured.error}`);
			const key = JSON.stringify(lmeasured.lineQuantities);
			if (key === last) lstable += 1; else lstable = 0;
			last = key;
			await sleep(600);
		}
		console.log(`loop measured (total=${total} rounds=${lrounds} stablePolls=${lstable}):`, JSON.stringify(lmeasured));

		// Restore the omnibus pause state the belt feeds cleared (jammed belts stay put once re-paused).
		console.log("restore pause:", JSON.stringify(setOmnibusPaused(pausedBefore)));
		return;
	}
	throw new Error(`phase ${phase} not implemented yet`);
}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
