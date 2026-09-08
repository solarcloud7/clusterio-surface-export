import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { lua, preflightState, assertLeaseClean } from "../../lab-gallery/batch-lifecycle.mjs";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";

const read = name => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const paired = process.argv.includes("--paired");
const fidelity = process.argv.includes("--fidelity");
const reverseRebuild = process.argv.includes("--reverse-rebuild");
const sameLane = process.argv.includes("--same-lane");
const dense = process.argv.includes("--dense");
const importGroups = process.argv.includes("--import-groups");
const junctions = process.argv.includes("--junctions");
const artifact = junctions ? "ci-artifacts/belt-import-junctions-result.json" : importGroups ? "ci-artifacts/belt-import-groups-result.json" : dense ? "ci-artifacts/belt-remove-dense-result.json" : sameLane ? "ci-artifacts/belt-remove-same-lane-result.json" : reverseRebuild ? "ci-artifacts/belt-remove-inverse-result.json" : fidelity ? "ci-artifacts/belt-remove-fidelity-result.json" : paired ? "ci-artifacts/belt-remove-paired-result.json" : "ci-artifacts/belt-remove-result.json";
const values = value => Object.values(value || {});
const sum = value => values(value).reduce((a, b) => a + b, 0);
const boundary = process.argv.includes("--boundary");
if (paired && !process.argv.includes("--analyze")) assert.ok(boundary, "--paired requires --boundary");
if (fidelity && !process.argv.includes("--analyze")) assert.ok(paired && boundary, "--fidelity requires --paired --boundary");
if (reverseRebuild && !process.argv.includes("--analyze")) assert.ok(fidelity,"--reverse-rebuild requires --fidelity");
if (sameLane && !process.argv.includes("--analyze")) assert.ok(fidelity && !reverseRebuild, "--same-lane requires --fidelity without --reverse-rebuild");
if (dense && !process.argv.includes("--analyze")) {
 assert.ok(sameLane, "--dense requires --same-lane");
 assert.equal(JSON.parse(fs.readFileSync("ci-artifacts/belt-remove-same-lane-result.json", "utf8")).status, "PASS");
}
if (importGroups && !process.argv.includes("--analyze")) {
 assert.ok(sameLane && dense, "--import-groups requires dense same-lane mode");
 assert.equal(JSON.parse(fs.readFileSync("ci-artifacts/belt-remove-dense-result.json", "utf8")).status, "PASS");
}
if (junctions && !process.argv.includes("--analyze")) {
 assert.ok(importGroups, "--junctions requires --import-groups");
 assert.equal(JSON.parse(fs.readFileSync("ci-artifacts/belt-import-groups-result.json", "utf8")).status, "PASS");
}
function diagnose(run) {
 // Analyze retained evidence only. Never turn an arbitrary Lua exception into a candidate verdict.
 if(!run.raw?.error?.includes("captured position outside destination line"))return;
 const restore=values(run.raw.steps).find(s=>s.phase==="restore");if(!restore?.before)return;
 const definitions=JSON.parse(read("remove-fixture.json")).cases[run.case];if(!definitions)return;
 const destination=new Map(values(restore.before.nativeCounts).map(r=>[`${r.belt}:${r.line}`,r.length]));
 const removals=values(run.raw.steps).filter(s=>s.phase==="remove");const mismatches=[];
 for(const [pi,payload] of values(run.raw.payloads).entries()){
  // Decode the immutable stored wire representation, not groups mutated by the restorer.
  const groups=JSON.parse(inflateSync(Buffer.from(payload.encoded,"base64")).toString("utf8"));
  const source=new Map(values(removals[pi]?.candidate?.nativeCounts).map(r=>[`${r.belt}:${r.line}`,r.length]));
  for(const group of values(groups))for(const [i,slot] of values(group.slots).entries()){
   const positions=values(group.item_source_positions);const id=definitions[positions[i*3]-1]?.id;
   const line=positions[i*3+1],position=positions[i*3+2]/256;
   const sourceLength=source.get(`${id}:${line}`),destinationLength=destination.get(`${id}:${line}`);
   if(Number.isFinite(sourceLength)&&Number.isFinite(destinationLength)&&position>=0&&position<=sourceLength&&position>destinationLength){
    mismatches.push({belt:id,line,position,sourceLength,destinationLength,item:slot.n,quality:slot.q,count:slot.ct});
   }
  }
 }
 if(mismatches.length)return {status:"STOP",reason:"Captured coordinates valid during dismantling do not fit rebuilt topology",mismatches};
}
function summary(run) {
 const removals = values(run.raw.steps).filter(s => s.phase === "remove");
 const diagnosis=diagnose(run);
 return { case: run.case, order: run.reverse ? "against flow / reverse traversal" : "with flow / forward traversal",
  recovery: run.recover, paired: run.paired, control: run.control, status: diagnosis?.status||run.raw.status,
  rawStatus: diagnosis ? run.raw.status : undefined, reason: diagnosis?.reason||run.raw.reason, error: run.raw.error,
  coordinateMismatches: diagnosis?.mismatches,
  removals: removals.length, ticks: removals.map(s => s.tick), expected: sum(run.raw.expected),
  remaining: run.raw.final ? sum(run.raw.final.totals) : undefined, captured: run.raw.final ? values(run.raw.journal).filter(e => !e.restored)
   .flatMap(e => values(e.rows)).reduce((n, r) => n + r.count, 0) : undefined, handlerRestored: run.raw.handlerRestored };
}
function analyze(result) {
 const runs=result.runs.filter(r=>typeof r.reverse==="boolean"&&r.raw?.steps);
 const errors=runs.filter(r=>r.raw.status==="HARNESS_ERROR");
 const diagnosed=result.status==="HARNESS_ERROR"&&!result.cleanupError&&errors.length>0&&errors.every(r=>diagnose(r));
 for (const run of runs) console.log(JSON.stringify(summary(run)));
 console.log(JSON.stringify({status:diagnosed?"STOP":result.status, rawStatus:diagnosed?result.status:undefined,
  hash:result.hash, calls:result.calls, cleanup:result.cleanup, error:result.error}));
}

if (process.argv.includes("--analyze")) analyze(JSON.parse(fs.readFileSync(artifact, "utf8")));
else {
 const source = read("remove-probe.lua"), fixtureText = read("remove-fixture.json"), fixture = JSON.parse(fixtureText);
 const schema = JSON.parse(fs.readFileSync("ci-artifacts/belt-boundary-api.json", "utf8"));
 assert.equal(schema.application_version, fixture.engine);
 const manifest = {
  LuaGameScript: ["create_surface", "delete_surface", "surfaces", "tick", "tick_paused", "connected_players"],
  LuaSurface: ["valid", "create_entity", "find_entity", "find_entities_filtered", "set_tiles", "request_to_generate_chunks", "force_generate_chunk_requests"],
  LuaEntity: ["valid", "name", "type", "direction", "position", "unit_number", "destroy", "stack", "get_transport_line", "get_max_transport_line_index", "belt_neighbours", "underground_belt_neighbour"],
  LuaTransportLine: ["valid", "get_detailed_contents", "get_item_count", "insert_at_back", "line_length", "line_equals", "force_insert_at", "clear"],
  LuaItemStack: ["valid_for_read", "name", "count", "quality"], LuaQualityPrototype: ["name"],
  LuaBootstrap: ["active_mods", "get_event_handler", "on_event"], LuaHelpers: ["json_to_table", "table_to_json", "create_profiler"], LuaProfiler: ["stop"],
 };
 const member = (name, field) => {
  for(let c=schema.classes.find(c=>c.name===name); c; c=schema.classes.find(p=>p.name===c.parent)) {
   const m=[...c.methods,...c.attributes].find(m=>m.name===field); if(m) return m;
  }
  assert.fail(`Missing API ${name}.${field}`);
 };
 for(const [name, fields] of Object.entries(manifest)) for(const field of fields) member(name, field);
 assert.equal(member("LuaEntity", "destroy").return_values[0].type, "boolean");
 assert.equal(member("LuaTransportLine", "force_insert_at").return_values.length, 0);
 assert.equal(member("LuaBootstrap", "get_event_handler").return_values[0].optional, true);
 assert.equal(member("LuaEntity", "stack").read_type, "LuaItemStack");
 const detail=schema.concepts.find(c=>c.name==="DetailedItemOnLine");
 assert.deepEqual(detail.type.parameters.map(p=>[p.name,p.type]).sort(),[["position","float"],["stack","LuaItemStack"],["unique_id","uint32"]]);
 const modules={};
 if(fidelity){
  const prior=JSON.parse(fs.readFileSync("ci-artifacts/belt-remove-paired-result.json","utf8"));
  assert.equal(prior.status,"PASS","paired candidate must pass first");
  if(reverseRebuild || sameLane){
   const priorFidelity=JSON.parse(fs.readFileSync("ci-artifacts/belt-remove-fidelity-result.json","utf8"));
   assert.ok(priorFidelity.runs.some(r=>diagnose(r)?.mismatches.length),"original geometry mismatch must be witnessed first");
  }
  for(const [cls,fields] of Object.entries({LuaHelpers:["encode_string","decode_string"],LuaGameScript:["create_inventory"],
   LuaInventory:["valid","destroy"],LuaItemStack:["health","ammo","durability","is_blueprint","set_blueprint_entities","get_blueprint_entities","label","export_stack","import_stack"]})){
   manifest[cls]=[...new Set([...(manifest[cls]||[]),...fields])];for(const field of fields)member(cls,field);
  }
  const bundle=path=>{
   if(modules[path])return;assert.ok(path.startsWith("modules/surface_export/"));
   const text=fs.readFileSync(`docker/seed-data/external_plugins/surface_export/module/${path.slice(23)}.lua`,"utf8").replaceAll("\r\n","\n");
   modules[path]=text;for(const [,dep] of text.matchAll(/require\("([^"]+)"\)/g))bundle(dep);
  };
  bundle("modules/surface_export/import_phases/belt_restoration");
  if(importGroups){
   const path="modules/surface_export/import_phases/belt_batches";bundle(path);
   const anchor="    for _, component in ipairs(ordered) do";
   const packed="    for i, group in ipairs(groups) do\n        local component = { indices = { i }, cost = math.max(#group.slots, #group.members, 1) }";
   if(!modules[path].includes(packed)) {
    assert.equal(modules[path].split(anchor).length,2);
    modules[path]=modules[path].replace(anchor,packed);
   }
  }
  if(sameLane){
   assert.equal(JSON.parse(fs.readFileSync("ci-artifacts/belt-remove-inverse-result.json","utf8")).status,"PASS");
   const path="modules/surface_export/import_phases/belt_restoration";
   const guard="assert(k >= 0 and k / 256 <= line.line_length, 'captured position outside destination line')";
   const clamped="assert(type(k) == 'number' and k == k and math.abs(k) < math.huge, 'invalid captured position')\n        k = math.max(0, math.min(k, line.line_length * 256))";
   if(!modules[path].includes(clamped)) {
    assert.equal(modules[path].split(guard).length,2,"candidate must replace exactly one position guard");
    modules[path]=modules[path].replace(guard,clamped);
   }
  }
 }
 const modulesJson=JSON.stringify(modules);assert.ok(Buffer.byteLength(modulesJson)<1024*1024,"module bundle bound");
 const compressed=deflateSync(modulesJson).toString("base64");
 const compressedProbe=deflateSync(source).toString("base64");
 const moduleHashes=Object.fromEntries(Object.entries(modules).map(([k,v])=>[k,createHash("sha256").update(v).digest("hex")]));
 const hash=createHash("sha256").update(source+fixtureText+read("remove-contract.md")+read("run-remove.mjs")+modulesJson).digest("hex");
 if(process.argv.includes("--prepare")) console.log(JSON.stringify({hash,engine:fixture.engine,sourceBytes:Buffer.byteLength(source),moduleBytes:Buffer.byteLength(modulesJson),moduleHashes,manifest}));
 else await withWorkflowLock(async () => {
  fs.mkdirSync("ci-artifacts",{recursive:true});
  const checkBody="local names={} for n in pairs(game.surfaces) do if type(n)=='string' and (n:find('belt-remove-',1,true)==1 or n:find('belt-capture-',1,true)==1) then names[#names+1]=n end end return {names=names,storageAbsent=storage.__belt_remove_experiment==nil and storage.__belt_capture_experiment==nil,hookAbsent=_G.__belt_remove_hook==nil,handler=tostring(script.get_event_handler(defines.events.on_tick)),paused=game.tick_paused}";
  const before={};
  for(const host of [1,2]) {
   assertLeaseClean(host,preflightState(host),"before remove experiment");
   before[host]=lua(host,checkBody);assert.equal(values(before[host].names).length,0);
   assert.equal(before[host].storageAbsent,true);assert.equal(before[host].hookAbsent,true);
  }
  const started=Date.now(), token=`remove-${started}`;
 const result={hash,token,engine:fixture.engine,manifest,boundary,paired,fidelity,reverseRebuild,sameLane,dense,importGroups,junctions,moduleHashes,status:"RUNNING",calls:0,runs:[],before,
   notTested:["production transfer", "producer/consumer locking", "durable journal or crash recovery",
    fidelity ? "item properties outside executed fixture arms; later arms are untested if the ladder stops" : "non-default item state",
    "spoilage", "equipment grids/nested inventories", "wiring/settings", "simultaneous original positions", "performance improvement"]};
  const save=()=>{const text=JSON.stringify(result,null,2);assert.ok(Buffer.byteLength(text)<8*1024*1024);fs.writeFileSync(artifact,text);};
  let ownedName, bundleOwned=false, arm={case:"smoke",reverse:false,recover:false,paired};
  const call=(mode,rescue=false)=>{
   if(!rescue){assert.ok(result.calls<(fidelity?120:fixture.maxCalls),"probe call bound");assert.ok(Date.now()-started<(fidelity?180000:fixture.maxRuntimeMs),"runtime bound");}
   result.calls++;
   const replacements={__FIXTURE__:fixtureText,__TOKEN__:token,__NAME__:ownedName,__MODE__:mode,__CASE__:arm.case,
    __REVERSE__:String(arm.reverse),__RECOVER__:String(arm.recover),__BOUNDARY__:String(boundary),__PAIRED__:String(arm.paired),
    __FIDELITY__:String(fidelity),__REVERSE_REBUILD__:String(reverseRebuild),__SAME_LANE__:String(sameLane),__DENSE__:String(dense),__IMPORT_GROUPS__:String(importGroups)};
   const code=`local b=assert(storage.__belt_remove_bundle);assert(b.token=='${token}');local code=b.probe;local substitutions=helpers.json_to_table([=[${JSON.stringify(replacements)}]=]);for key,value in pairs(substitutions) do code=code:gsub(key,function() return value end) end;return assert(load('return function()\\n'..code..'\\nend','belt-remove-probe'))()()`;
   assert.ok(Buffer.byteLength(code)<16*1024,"command bound");
   const out=lua(2,code);assert.ok(Buffer.byteLength(JSON.stringify(out))<(fidelity?1024*1024:256*1024),"response bound");return out;
  };
  const checked=(mode)=>{const out=call(mode);assert.notEqual(out.status,"HARNESS_ERROR",out.error);assert.ok(!out.error,out.error);return out;};
  const clean=()=>{
   const out=call("cleanup",true);assert.equal(out.storageAbsent,true);assert.equal(out.hookAbsent,true);
   assert.equal(out.handler,before[2].handler);assert.equal(out.paused,false);
   const independent=lua(2,checkBody);assert.deepEqual(independent,before[2]);ownedName=null;return independent;
  };
  const poll=()=>{
   for(let n=0;n<8;n++){const raw=call("read");if(raw.status!=="RUNNING")return raw;}
   assert.fail("tick runner did not finish in bounded reads");
  };
  try {
   {
    const claim=lua(2,`assert(not storage.__belt_remove_bundle,'foreign module bundle');storage.__belt_remove_bundle={token='${token}',json='',probe=''};return {ok=true}`);
    assert.equal(claim.ok,true,claim.error);bundleOwned=true;result.calls++;
    for(let i=0;i<compressed.length;i+=10000){
     const out=lua(2,`local s=storage.__belt_remove_bundle;assert(s.token=='${token}');s.json=s.json..'${compressed.slice(i,i+10000)}';return {ok=true}`);
     assert.equal(out.ok,true,out.error);result.calls++;
    }
    const decoded=lua(2,`local s=storage.__belt_remove_bundle;assert(s.token=='${token}');s.json=assert(helpers.decode_string(s.json));return {bytes=#s.json}`);
    assert.equal(decoded.bytes,Buffer.byteLength(modulesJson));result.calls++;
    for(let i=0;i<compressedProbe.length;i+=10000){
     const out=lua(2,`local s=storage.__belt_remove_bundle;assert(s.token=='${token}');s.probe=s.probe..'${compressedProbe.slice(i,i+10000)}';return {ok=true}`);
     assert.equal(out.ok,true,out.error);result.calls++;
    }
    const probe=lua(2,`local s=storage.__belt_remove_bundle;assert(s.token=='${token}');s.probe=assert(helpers.decode_string(s.probe));return {bytes=#s.probe}`);
    assert.equal(probe.bytes,Buffer.byteLength(source));result.calls++;
   }
   ownedName=`belt-remove-${started}-inject`;
   const injected=call("inject");assert.equal(injected.status,"HARNESS_ERROR");assert.match(injected.error,/injected construction failure/);
   result.runs.push({case:"construction-cleanup",raw:injected,clean:clean()});save();
   ownedName=`belt-remove-${started}-callback`;
   result.mods=checked("setup").mods;checked("tick-failure");
   const tickFailure=poll();assert.equal(tickFailure.status,"HARNESS_ERROR",tickFailure.error);assert.match(tickFailure.error,/injected callback failure/);
   assert.equal(tickFailure.handlerRestored,true);
   result.runs.push({case:"callback-cleanup",raw:tickFailure,clean:clean()});save();
   ownedName=`belt-remove-${started}-smoke`;assert.deepEqual(checked("setup").mods,result.mods);
   const smoke=checked("smoke");assert.equal(values(smoke.shape).length,5);assert.equal(values(smoke.physical.rows).length,0);
   result.runs.push({case:"shape-smoke",raw:smoke,clean:clean()});save();
   if(paired && !fidelity){
    arm={case:"underground",reverse:true,recover:false,paired:false};ownedName=`belt-remove-${started}-control`;
    assert.deepEqual(checked("setup").mods,result.mods);checked("start");
    const control={...arm,control:true,raw:poll()};result.runs.push(control);save();
    assert.equal(control.raw.status,"STOP",control.raw.error);
    const last=values(control.raw.steps).at(-1);
    assert.equal(last.selected,"C");assert.equal(last.before.totals["copper-plate/normal"],1);
    assert.equal(last.after.totals["copper-plate/normal"],undefined);
    assert.equal(sum(last.captured)+sum(last.after.totals),3);
    control.clean=clean();control.summary=summary(control);save();console.log(JSON.stringify(control.summary));
   }
   const pairs=junctions ? [{case:"side-loading",recover:false},{case:"splitter-branches",recover:false}] : fidelity ? [{case:"straight",recover:false},{case:"loop",recover:false},{case:"splitter",recover:false},{case:"paired-chain",recover:false}]
    : paired ? [{case:"underground",recover:false},{case:"underground",recover:true},{case:"paired-chain",recover:false}]
    : [{case:"straight",recover:false},{case:"loop",recover:false},{case:"loop",recover:true},
     {case:"splitter",recover:false},{case:"underground",recover:false}];
   for(const pair of pairs){
    let stopped=false;
    for(const reverse of [false,true]){
     arm={...pair,reverse,paired};ownedName=`belt-remove-${started}-${result.runs.length}`;
     assert.deepEqual(checked("setup").mods,result.mods);
     const run={...arm};result.runs.push(run);run.shape=checked("smoke").shape;checked("start");
     run.raw=poll();save();
     assert.notEqual(run.raw.status,"HARNESS_ERROR",run.raw.error);
     assert.ok(["PASS","STOP"].includes(run.raw.status));assert.equal(run.raw.handlerRestored,true);
     const ticks=values(run.raw.steps).map(step=>step.tick);
     for(let n=1;n<ticks.length;n++)assert.equal(ticks[n]-ticks[n-1],1,"callbacks did not run on consecutive ticks");
     run.clean=clean();run.summary=summary(run);save();console.log(JSON.stringify(run.summary));
     if(run.raw.status==="STOP"){stopped=true;if(paired)break;}
    }
    if(stopped){result.status="STOP";break;}
   }
   if(result.status==="RUNNING")result.status="PASS";
  }catch(error){result.status="HARNESS_ERROR";result.error=error.message;throw error;}
  finally{
   try{
    if(ownedName)clean();
    if(bundleOwned){
     const cleanBundle=lua(2,`local s=storage.__belt_remove_bundle;assert(s and s.token=='${token}');storage.__belt_remove_bundle=nil;return {absent=storage.__belt_remove_bundle==nil}`);
     assert.equal(cleanBundle.absent,true);bundleOwned=false;
     const absent=lua(2,"return {absent=storage.__belt_remove_bundle==nil}");assert.equal(absent.absent,true);result.bundleAbsent=true;
    }
    result.cleanup={};
    for(const host of [1,2]){
     const state=preflightState(host);assertLeaseClean(host,state,"after remove experiment");
     const labs=lua(host,checkBody);assert.deepEqual(labs,before[host]);result.cleanup[host]={...state,...labs};
    }
   }catch(error){result.status="HARNESS_ERROR";result.cleanupError=error.message;throw error;}
   finally{result.elapsedMs=Date.now()-started;save();}
  }
  analyze(result);
 });
}
