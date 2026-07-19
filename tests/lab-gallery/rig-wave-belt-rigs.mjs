#!/usr/bin/env node
// Rig-wave belt-rig builder (A1-A3 of the 2026-07-19 wave) — RECONSTRUCTIONS.
//
// The original hand-built belt fixtures lived on the dev design world lab-omnibus-platform-v1 /
// lab-belt-r10-probe, which is NOT in the current golden corpus and was not recoverable from any
// available zip (host-1 saves, git, gallery-source candidates v3-v9; the level.dat platform names are
// double-compressed so a plaintext scan is inconclusive; the belt-lab NOTEBOOK records the coverage
// rack was pruned in the 2026-07-17 save consolidation). These rigs are therefore RECONSTRUCTED to the
// CLASS described in the BELT-R11/R12/R13 NOTEBOOK entries, built fresh on the LIVE gallery via RCON,
// and their measured censuses are recorded honestly — they are not the original saturated state.
//
//   node tests/lab-gallery/rig-wave-belt-rigs.mjs [--only=A1,A2,A3]
//
// Each rig: create a nauvis space platform (starter pack), lay foundation, place a turbo-tier entity
// set (the topological variety the runners assert), saturate each carrying belt line directly via
// insert_at_back (deterministic; independent of belt flow / loader power), then FREEZE (plat.paused +
// destructible=false on all; active=false on non-belt-graph — belt-class transport/underground/splitter
// REJECT active writes per BELT-R13, skipped-and-logged). The owner's live session is untouched (all
// scope is platform-local). Idempotent: refuses if the rig platform name already exists.

import { execFileSync } from "node:child_process";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const GALLERY = "surface-export-lab-gallery";

const COPPER = "copper-plate";
const IRON = "iron-plate";

function docker(args, timeout = 120_000) {
	return execFileSync("docker", args, {
		encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024,
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
	catch (error) { throw new Error(`unparseable Lua JSON (${error.message}): ${last.slice(0, 400)}`); }
}

// --- rig specs -------------------------------------------------------------------------------------
// dir: N=0 E=4 S=8 W=12 (Factorio 2.0). belt entities carry a `fill` item to saturate their lines.
// e = turbo-transport-belt, u = turbo-underground-belt (with ut input/output), sp = turbo-splitter,
// ld = turbo-loader (lt input/output), ic = infinity-chest (holds `fill` for authenticity).

function beltRow(x0, x1, y, fill) {
	const row = [];
	for (let x = x0; x <= x1; x += 1) row.push({ k: "e", x: x + 0.5, y: y + 0.5, dir: 4, fill });
	return row;
}

const A1 = {
	name: "lab-rig-green-omnibus-v1",
	foundation: { x1: -3, x2: 20, y1: -2, y2: 6 },
	// Copper main lane (y=1) with an underground pair; iron main lane (y=3); one unfiltered splitter;
	// two sideloads (S-facing belts into the copper lane's side). Saturated via insert_at (below).
	// (Chest-fed loaders from the original design world are omitted — a 1x2 loader's placement is
	// fragile on a hand-built rig and it was only a feed mechanism; insert_at saturation replaces it.)
	entities: [
		...beltRow(0, 7, 1, COPPER),                                  // copper belts x0..7
		{ k: "u", x: 9.5, y: 1.5, dir: 4, ut: "input", fill: COPPER },
		{ k: "u", x: 12.5, y: 1.5, dir: 4, ut: "output", fill: COPPER },
		...beltRow(13, 14, 1, COPPER),                                // copper belts x13..14
		...beltRow(0, 13, 3, IRON),                                   // iron belts x0..13
		{ k: "sp", x: 16.0, y: 2.0, dir: 4, fill: IRON },             // unfiltered splitter (covers y1,y2)
		{ k: "e", x: 4.5, y: 0.5, dir: 8, fill: IRON },               // sideload into copper lane (iron)
		{ k: "e", x: 10.5, y: 0.5, dir: 8, fill: COPPER },            // sideload into copper lane (copper)
	],
};

const A2 = {
	name: "lab-rig-filtered-splitter-v1",
	foundation: { x1: -3, x2: 14, y1: -2, y2: 6 },
	// A filtered turbo-splitter (filter=copper-plate, output-priority=left) with a mixed feed and two
	// PURE post-filter fed lanes: left output = pure copper (the filtered stream), right output = iron.
	// Purity is by construction (each lane's own item), matching the runtime filter routing; splitter
	// filter/priority are SET on the entity. (Chest-fed loaders omitted — see A1 note.)
	entities: [
		{ k: "e", x: 0.5, y: 1.5, dir: 4, fill: COPPER, fill2: IRON }, // mixed feed (lane1 Cu / lane2 Fe)
		{ k: "e", x: 1.5, y: 1.5, dir: 4, fill: COPPER, fill2: IRON },
		{ k: "e", x: 2.5, y: 1.5, dir: 4, fill: COPPER, fill2: IRON },
		{ k: "sp", x: 4.0, y: 2.0, dir: 4, filter: COPPER, outpri: "left" }, // covers y1 (left) + y2 (right)
		...beltRow(5, 8, 1, COPPER),                                  // LEFT output — pure copper
		...beltRow(5, 8, 2, IRON),                                    // RIGHT output — pure iron
	],
};

const A3 = {
	name: "lab-rig-probe-strip-v1",
	foundation: { x1: -3, x2: 9, y1: -2, y2: 4 },
	// Feeder-free 6-belt probe strip: six east turbo belts, dead-end, NO source, left EMPTY (the strip
	// is seeded by a probe at measure time — R13 paused-belt-physics instrument).
	entities: [
		{ k: "e", x: 0.5, y: 0.5, dir: 4 },
		{ k: "e", x: 1.5, y: 0.5, dir: 4 },
		{ k: "e", x: 2.5, y: 0.5, dir: 4 },
		{ k: "e", x: 3.5, y: 0.5, dir: 4 },
		{ k: "e", x: 4.5, y: 0.5, dir: 4 },
		{ k: "e", x: 5.5, y: 0.5, dir: 4 },
	],
};

const PROTO = { e: "turbo-transport-belt", u: "turbo-underground-belt", sp: "turbo-splitter",
	ld: "turbo-loader", ic: "infinity-chest" };

function buildBody(spec) {
	const ents = JSON.stringify(spec.entities.map(e => ({ ...e, name: PROTO[e.k] })));
	const f = spec.foundation;
	return `
		for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${spec.name}' then
			out.success=false out.error='rig ${spec.name} already exists' return end end
		local plat=game.forces.player.create_space_platform{name='${spec.name}',planet='nauvis',starter_pack='space-platform-starter-pack'}
		if not plat then out.success=false out.error='create_space_platform nil' return end
		plat.apply_starter_pack()
		local s=plat.surface
		local tiles={}
		for x=${f.x1},${f.x2} do for y=${f.y1},${f.y2} do
			tiles[#tiles+1]={name='space-platform-foundation',position={x=x,y=y}} end end
		s.set_tiles(tiles)
		local spec=helpers.json_to_table('${ents.replace(/'/g, "\\'")}')
		local created=0 local failed={}
		for _,d in ipairs(spec) do
			local args={name=d.name,position={x=d.x,y=d.y},force='player'}
			if d.dir~=nil then args.direction=d.dir end
			if d.ut then args.type=d.ut end
			if d.lt then args.type=d.lt end
			local ok,e=pcall(function() return s.create_entity(args) end)
			if ok and e and e.valid then
				created=created+1
				if d.filter then pcall(function() e.splitter_filter={name=d.filter} end) end
				if d.outpri then pcall(function() e.splitter_output_priority=d.outpri end) end
				if d.k=='ic' and d.fill then pcall(function()
					e.infinity_container_filters={{index=1,name=d.fill,count=1000,mode='at-least'}}
					e.remove_unfiltered_items=true end) end
				-- Saturate each lane via insert_at stepping (insert_at_back only fills the back slot).
				-- lane 1 gets d.fill, lane 2 gets d.fill2 or d.fill (per-lane item lets a feed belt be mixed).
				local belt_kind={e=true,u=true,sp=true,ld=true}
				if d.fill and belt_kind[d.k] then pcall(function()
					for li=1,e.get_max_transport_line_index() do
						local item=(li==2 and d.fill2) or d.fill
						local line=e.get_transport_line(li)
						local L=line.line_length
						local pos=0
						while pos<L do line.insert_at(pos,{name=item,count=1}) pos=pos+0.25 end
					end
				end) end
			else
				failed[#failed+1]={name=d.name,x=d.x,y=d.y,err=tostring(e)}
			end
		end
		out.created=created out.failed=failed out.success=true`;
}

function freezeBody(name) {
	return `
		local plat for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${name}' then plat=p end end
		if not plat then out.success=false out.error='platform ${name} missing' return end
		plat.paused=true
		local s=plat.surface
		local belt_reject={['transport-belt']=true,['underground-belt']=true,['splitter']=true}
		local active_set=0 local active_skip=0 local active_reject=0 local destr=0
		local ents=s.find_entities_filtered{}
		for _,e in ipairs(ents) do if e.valid then
			pcall(function() e.destructible=false end)
			if e.destructible==false then destr=destr+1 end
			if belt_reject[e.type] then active_skip=active_skip+1
			else pcall(function() e.active=false end)
				if e.active==false then active_set=active_set+1 else active_reject=active_reject+1 end end
		end end
		out.total_entities=#ents out.active_set=active_set out.active_skipped=active_skip
		out.active_rejected=active_reject out.destructible_set=destr out.paused=plat.paused==true out.success=true`;
}

function censusBody(name) {
	return `
		local plat for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${name}' then plat=p end end
		if not plat then out.success=false out.error='platform ${name} missing' return end
		local s=plat.surface
		local belts=s.find_entities_filtered{type={'transport-belt','underground-belt','splitter','loader','loader-1x1'}}
		out.belt_connectables=#belts
		local by_type={}
		for _,e in ipairs(belts) do by_type[e.type]=(by_type[e.type] or 0)+1 end
		out.by_type=by_type
		local seen={} local copper=0 local iron=0 local total=0 local lines=0
		for _,e in ipairs(belts) do for li=1,e.get_max_transport_line_index() do
			lines=lines+1
			for _,it in ipairs(e.get_transport_line(li).get_detailed_contents()) do
				local id=tostring(it.unique_id)
				if not seen[id] then seen[id]=true total=total+it.stack.count
					if it.stack.name=='copper-plate' then copper=copper+it.stack.count
					elseif it.stack.name=='iron-plate' then iron=iron+it.stack.count end end
			end
		end end
		out.belt_lines=lines out.copper=copper out.iron=iron out.belt_item_total=total
		out.total_entities=#s.find_entities_filtered{}
		local sp=s.find_entities_filtered{type='splitter'}[1]
		if sp then out.splitter_filter=sp.splitter_filter and sp.splitter_filter.name or nil
			out.splitter_outpri=sp.splitter_output_priority end
		out.paused=plat.paused==true out.success=true`;
}

async function main() {
	let only = null;
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith("--only=")) only = new Set(arg.slice(7).split(","));
		else throw new Error(`unknown arg ${arg}`);
	}
	const specs = { A1, A2, A3 };
	const summary = { started: new Date().toISOString(), rigs: [] };
	for (const [id, spec] of Object.entries(specs)) {
		if (only && !only.has(id)) continue;
		const rig = { id, name: spec.name };
		rig.build = luaJson(buildBody(spec));
		if (!rig.build.success) { rig.error = rig.build.error; summary.rigs.push(rig); continue; }
		rig.freeze = luaJson(freezeBody(spec.name));
		rig.census = luaJson(censusBody(spec.name));
		summary.rigs.push(rig);
	}
	summary.leftovers = luaJson(`local function n(t) local c=0 for _ in pairs(t or {}) do c=c+1 end return c end
		out.jobs=n(storage.async_jobs) out.locks=n(storage.locked_platforms) out.holds=n(storage.destination_holds)
		out.paused=game.tick_paused==true out.success=true`, 60_000);
	summary.finished = new Date().toISOString();
	console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
