#!/usr/bin/env node
// fluid-lab R14 — fusion write-rejection conditions matrix (2.0.77)
//
// Mandate: the blanket law "fusion-reactor output fluidboxes reject writes" (Pitfall #21) is
// contradicted by a live scratch probe (fresh unconnected reactor accepts insert_fluid(plasma)).
// R11's write_rejected subtractions were real transfer measurements. So rejection is CONDITIONAL,
// conditions unmapped. This rung measures insert_fluid AND fluidbox[i]= write + readback for the
// fusion-reactor plasma OUTPUT box (box 2) and the fusion-generator plasma INPUT box (box 1) across
// a one-variable-per-cell condition matrix, and reports the CONDITION under which writes reject (or
// the honest finding that they never reject at the pin -> version drift from the R11 era).
//
// SCRATCH ONLY: builds a disposable prefixed space platform on host-1 (clusterio-host-1-instance-1),
// leaving the owner's live gallery loop 100% untouched. Every scratch entity/platform is destroyed
// and zero-leftover asserted. NEVER mutates owner state.
//
// Cite this rung as "fluid-lab R14" (belt-lab owns BELT-R14 — different lab, different anchor).
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const controller = "surface-export-controller";
const config = "/clusterio/tokens/config-control.json";
const scratch = "clusterio-host-1-instance-1"; // scratch venue; owner gallery is read-only elsewhere
const prefix = "fluid-lab-r14-";
const notebook = "tests/fluid-lab/NOTEBOOK.md";

const resetOnly = process.argv.includes("--reset");
const noNotebook = process.argv.includes("--no-notebook");

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function lastLine(v) { return String(v).split(/\r?\n/).map(x => x.trim()).filter(Boolean).at(-1) || ""; }
function rcon(instance, command) {
	return execFileSync("docker", [
		"exec", controller, "npx", "clusterioctl", "--config", config, "--log-level", "error",
		"instance", "send-rcon", instance, command,
	], { encoding: "utf8", timeout: 180000 }).trim();
}
function lua(instance, body) {
	const wrapped = `local ok,result=pcall(function() ${body} end);` +
		`if ok then rcon.print(helpers.table_to_json(result)) ` +
		`else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const result = JSON.parse(lastLine(rcon(instance, `/sc ${wrapped}`)));
	if (result.success === false) throw new Error(`${instance}: ${result.error}`);
	return result;
}

function cleanup() {
	return lua(scratch, `for _,s in pairs(game.surfaces) do local p=s.platform ` +
		`if string.find(s.name,'${prefix}',1,true)==1 or (p and p.valid and string.find(p.name,'${prefix}',1,true)==1) ` +
		`then game.delete_surface(s) end end ` +
		`storage.fluid_lab=nil;game.tick_paused=false;return {success=true}`);
}
function zero() {
	return lua(scratch, `local function n(t)local c=0 for _ in pairs(t or {})do c=c+1 end return c end ` +
		`local surfaces=0;for _,s in pairs(game.surfaces)do local p=s.platform ` +
		`if string.find(s.name,'${prefix}',1,true)==1 or (p and p.valid and string.find(p.name,'${prefix}',1,true)==1) ` +
		`then surfaces=surfaces+1 end end ` +
		`return {success=true,surfaces=surfaces,storage=storage.fluid_lab~=nil,game_paused=game.tick_paused==true,` +
		`holds=n(storage.destination_holds),locks=n(storage.locked_platforms),jobs=n(storage.async_jobs)}`);
}
function cleanAll() {
	cleanup();
	sleep(300);
	const s = zero();
	s.ok = s.surfaces === 0 && !s.storage && !s.game_paused && s.holds === 0 && s.locks === 0 && s.jobs === 0;
	return s;
}

// Shared lua prelude: helpers reused by every cell. Placed inside each /sc body via ${PRELUDE}.
const PRELUDE = `
local function boxinfo(e,i)
  local proto=e.prototype.fluidbox_prototypes and e.prototype.fluidbox_prototypes[i] or nil
  local cats={}
  if proto and proto.pipe_connections then for _,c in pairs(proto.pipe_connections) do
    local v=c.connection_category
    if type(v)=='string' then cats[v]=true else for _,cc in pairs(v or {}) do cats[cc]=true end end
  end end
  local cl={} for k in pairs(cats) do cl[#cl+1]=k end table.sort(cl)
  return {production_type=proto and proto.production_type or nil,categories=cl}
end
-- byte-faithful inline replica of FluidOwnership.effective_segment_contents (module require is
-- unavailable from /sc): the ONE shared buffer-class accessor.
local function eff(fb,i)
  local c=fb.get_fluid_segment_contents(i)
  if c and next(c)==nil then
    local b=fb[i]
    if b and b.name and b.amount and b.amount>0 then return {[b.name]=b.amount} end
  end
  return c
end
local function wtest(e,box,path)
  pcall(function() e.clear_fluid_inside() end)
  local before=e.fluidbox[box]
  local res={path=path,box=box,active=e.active,production_type=boxinfo(e,box).production_type,
    categories=boxinfo(e,box).categories,
    before=before and {name=before.name,amount=before.amount} or nil}
  if path=='fluidbox' then
    local ok,err=pcall(function() e.fluidbox[box]={name='fusion-plasma',amount=10,temperature=1000000} end)
    res.ok=ok; res.err=(not ok) and tostring(err) or nil
  else
    local ok,ins=pcall(function() return e.insert_fluid{name='fusion-plasma',amount=10,temperature=1000000} end)
    res.ok=ok; res.err=(not ok) and tostring(ins) or nil; res.inserted=ok and ins or nil
  end
  local after=e.fluidbox[box]
  res.readback=after and {name=after.name,amount=after.amount,temp=after.temperature} or nil
  res.seg_id=e.fluidbox.get_fluid_segment_id(box)
  res.seg_contents=res.seg_id and e.fluidbox.get_fluid_segment_contents(box) or nil
  res.accepted=(after~=nil and after.amount~=nil and after.amount>=9.5) or false
  res.tick=game.tick
  return res
end
`;

function findPlatform() {
	return lua(scratch, `for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and string.find(p.name,'${prefix}',1,true)==1 then return {success=true,name=p.name,index=p.index} end end ` +
		`return {success=true,name=nil}`);
}

// exec 1: build the platform + the SETTLED reactor/generator (aged across executions), store unit numbers.
function setupAndSeedSettled() {
	return lua(scratch, `${PRELUDE}
local force=game.forces.player
local name='${prefix}'..game.tick
local p=force.create_space_platform{name=name,planet='nauvis',starter_pack='space-platform-starter-pack'}
p.apply_starter_pack()
local sch=p.get_schedule();sch.add_record({station='Nauvis',wait_conditions={{type='time',ticks=7200,compare_type='or'}}})
local tiles={};for x=-14,14 do for y=-14,14 do tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end end
p.surface.set_tiles(tiles)
for _,e in pairs(p.surface.find_entities_filtered({}))do if e.name~='space-platform-hub' then e.destroy() end end
-- settled targets: created NOW, written in a LATER execution (aged-target discipline, belt-lab).
local sr=p.surface.create_entity{name='fusion-reactor',position={-9,9},force=force}
local sg=p.surface.create_entity{name='fusion-generator',position={9,9},force=force}
if not sr or not sg then error('settled placement failed') end
storage.fluid_lab={settled_reactor=sr.unit_number,settled_generator=sg.unit_number,platform=name}
return {success=true,name=name,index=p.index,settled_reactor=sr.unit_number,settled_generator=sg.unit_number,tick=game.tick}
`);
}

// exec 2: the full matrix — fresh(active/inactive) reactor-output + generator-input, connected
// attempt, import-path replica, and the settled writes on the aged entities from exec 1.
function runMatrix(name) {
	return lua(scratch, `${PRELUDE}
local force=game.forces.player
local p=nil for _,v in pairs(force.platforms) do if v.valid and v.name=='${name}' then p=v end end
if not p then error('platform missing') end
local surf=p.surface
local out={tick_start=game.tick,cells={}}

-- box layout control
do
  local r=surf.create_entity{name='fusion-reactor',position={0,0},force=force}
  local g=surf.create_entity{name='fusion-generator',position={9,0},force=force}
  out.box_layout={reactor={boxinfo(r,1),boxinfo(r,2)},generator={boxinfo(g,1),boxinfo(g,2)}}
  r.destroy();g.destroy()
end

-- helper: run both write paths for one condition on a freshly-placed entity of ename at box ebox.
local function cell(label,ename,ebox,active)
  for _,path in ipairs({'fluidbox','insert_fluid'}) do
    local e=surf.create_entity{name=ename,position={0,0},force=force}
    if not e then error('place failed '..ename) end
    if active==false then e.active=false end
    local r=wtest(e,ebox,path)
    r.label=label
    out.cells[#out.cells+1]=r
    e.destroy()
  end
end

-- (1) control: fresh reactor output, active=true (replicates today's live probe)
cell('reactor_output/fresh_active','fusion-reactor',2,true)
-- (2) fresh reactor output, active=false
cell('reactor_output/fresh_inactive','fusion-reactor',2,false)
-- control: fresh generator input (an INPUT box — lore says inputs accept)
cell('generator_input/fresh_active','fusion-generator',1,true)
cell('generator_input/fresh_inactive','fusion-generator',1,false)

-- (3) connected: place a plasma-seeded infinity-pipe at each 4-adjacent side of the reactor output
-- half, then test whether the reactor output box shares that segment; if it does, write-reject test.
do
  local r=surf.create_entity{name='fusion-reactor',position={0,0},force=force}
  local base=r.fluidbox.get_fluid_segment_id(2)
  local shared=nil
  local tried={}
  for _,off in ipairs({{0,-4},{0,4},{-4,0},{4,0},{3,3},{-3,3},{3,-3},{-3,-3}}) do
    local pos={r.position.x+off[1],r.position.y+off[2]}
    if surf.can_place_entity{name='infinity-pipe',position=pos,force=force} then
      local ip=surf.create_entity{name='infinity-pipe',position=pos,force=force}
      if ip then
        pcall(function() ip.fluidbox[1]={name='fusion-plasma',amount=100,temperature=1000000} end)
        local ips=ip.fluidbox.get_fluid_segment_id(1)
        local rseg=r.fluidbox.get_fluid_segment_id(2)
        tried[#tried+1]={off=off,infinity_pipe_seg=ips,reactor_out_seg=rseg,shares=(ips~=nil and ips==rseg)}
        if ips~=nil and ips==rseg then shared=r end
        ip.destroy()
      end
    end
  end
  out.connected={base_reactor_out_seg=base,attempts=tried,constructible=(shared~=nil)}
  if shared then
    out.connected.write=wtest(shared,2,'fluidbox')
  end
  r.destroy()
end

-- (4) import-path replica: run FluidRestoration's write+verify+retry (module lines 124-178) inline,
-- byte-faithfully, on a fresh reactor output segment; record whether the rejection path fires.
do
  local r=surf.create_entity{name='fusion-reactor',position={0,0},force=force}
  pcall(function() r.clear_fluid_inside() end)
  local idx,fluid,final_amount,avg_temp=2,'fusion-plasma',10,1000000
  local rec={target='fusion-reactor',box=idx}
  local ok,err=pcall(function() r.fluidbox[idx]={name=fluid,amount=final_amount,temperature=avg_temp} end)
  rec.fluidbox_write_ok=ok; rec.fluidbox_write_err=(not ok) and tostring(err) or nil
  if ok then
    local actual_contents=eff(r.fluidbox,idx)
    local actual_amount=actual_contents and actual_contents[fluid] or 0
    rec.verify_actual_amount=actual_amount
    if actual_amount < final_amount-0.5 then
      rec.retry_fired=true
      local rok,rins=pcall(function() return r.insert_fluid{name=fluid,amount=final_amount,temperature=avg_temp} end)
      rec.retry_ok=rok; rec.retry_inserted=rok and rins or nil
      rec.classified=(rok and rins and rins>0.5) and 'recovered_via_insert_fluid' or 'write_rejected'
    else
      rec.retry_fired=false
      rec.classified='accepted_first_write'
    end
  end
  rec.final_readback=r.fluidbox[idx] and {name=r.fluidbox[idx].name,amount=r.fluidbox[idx].amount} or nil
  out.import_path=rec
  r.destroy()
end

-- (5) settled: write to the aged reactor/generator created in the PRIOR execution.
do
  local ids=storage.fluid_lab or {}
  local sr,sg=nil,nil
  for _,e in pairs(surf.find_entities_filtered({}))do
    if e.unit_number==ids.settled_reactor then sr=e end
    if e.unit_number==ids.settled_generator then sg=e end
  end
  if sr then
    local a=wtest(sr,2,'fluidbox'); a.label='reactor_output/settled'; a.unit=sr.unit_number; out.cells[#out.cells+1]=a
    local b=wtest(sr,2,'insert_fluid'); b.label='reactor_output/settled'; b.unit=sr.unit_number; out.cells[#out.cells+1]=b
  else out.settled_reactor_missing=true end
  if sg then
    local c=wtest(sg,1,'fluidbox'); c.label='generator_input/settled'; c.unit=sg.unit_number; out.cells[#out.cells+1]=c
    local d=wtest(sg,1,'insert_fluid'); d.label='generator_input/settled'; d.unit=sg.unit_number; out.cells[#out.cells+1]=d
  else out.settled_generator_missing=true end
end

out.tick_end=game.tick
return out
`);
}

function summarize(matrix) {
	// Reject == not accepted after write. Group by label.
	const rows = [];
	for (const c of matrix.cells) {
		rows.push({
			cell: c.label,
			path: c.path,
			box_production_type: c.production_type,
			categories: (c.categories || []).join("+"),
			active: c.active,
			write_ok: c.ok,
			write_err: c.err || null,
			inserted: c.inserted ?? null,
			readback_amount: c.readback ? c.readback.amount : 0,
			seg_id: c.seg_id ?? null,
			accepted: c.accepted,
			tick: c.tick,
		});
	}
	const anyReject = rows.some(r => !r.accepted);
	return { rows, any_write_rejected: anyReject };
}

function main() {
	const out = {
		script: "tests/fluid-lab/run-r14-fusion-write-matrix.mjs",
		rung: "fluid-lab R14",
		started: new Date().toISOString(),
		prediction: "Fusion plasma writes (both fluidbox[i]= and insert_fluid) ACCEPT on fresh/inactive/" +
			"settled reactor-output and generator-input boxes at 2.0.77; the blanket Pitfall #21 " +
			"'reactor output rejects writes' does not reproduce under any cheaply-constructible scratch " +
			"condition, meaning R11's write_rejected was a topology/capacity artifact of the live " +
			"transfer segment, not a categorical output-box rejection.",
		errors: [],
	};
	try {
		out.initial_reset = cleanAll();
		if (!out.initial_reset.ok) throw new Error("initial cleanup failed");
		out.setup = setupAndSeedSettled();
		sleep(1500); // let real ticks elapse so the settled targets are genuinely aged
		out.matrix = runMatrix(out.setup.name);
		out.box_layout = out.matrix.box_layout;
		out.connected = out.matrix.connected;
		out.import_path = out.matrix.import_path;
		out.summary = summarize(out.matrix);
	} catch (e) {
		out.errors.push(e.stack || e.message);
	} finally {
		out.final_reset = cleanAll();
		out.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly) appendFileSync(notebook,
			`\n\n## ${out.finished} - fluid-lab R14 fusion write-rejection conditions matrix\n\n` +
			`Prediction stated before execution. Scratch-only on host-1; owner gallery loop untouched. ` +
			`Cite as "fluid-lab R14" (distinct from belt-lab BELT-R14).\n\n` +
			"```json\n" + JSON.stringify(out, null, 2) + "\n```\n");
		console.log(JSON.stringify(out, null, 2));
		if (out.errors.length || !out.final_reset.ok) process.exitCode = 1;
	}
}

if (resetOnly) {
	const r = cleanAll();
	console.log(JSON.stringify(r, null, 2));
	if (!r.ok) process.exitCode = 1;
} else {
	main();
}
