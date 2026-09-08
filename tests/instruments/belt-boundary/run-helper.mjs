import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { lua, preflightState, assertLeaseClean } from "../../lab-gallery/batch-lifecycle.mjs";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
const installed=process.argv.includes("--installed");
const profile=process.argv.includes("--profile");
const batched=process.argv.includes("--batched");
const connected=process.argv.includes("--connected");
if(connected)assert.ok(installed&&batched,"connected replay requires --installed --batched");
const artifact=connected?"ci-artifacts/belt-helper-connected-result.json":batched?"ci-artifacts/belt-helper-batched-result.json":profile?"ci-artifacts/belt-helper-profile-result.json":installed?"ci-artifacts/belt-helper-installed-result.json":"ci-artifacts/belt-helper-result.json";
const read=name=>readFileSync(new URL(name,import.meta.url),"utf8");
const array=v=>Object.values(v||{});
const hash=v=>createHash("sha256").update(v).digest("hex");
const summarize=r=>console.log(JSON.stringify({fixture:r.fixture,arm:r.arm,status:r.result.status,
  placed:r.result.placed,unplaced:r.result.unplaced,anomalies:r.result.anomalies,
  exact:r.result.exact,stats:r.result.stats,cause:r.result.cause,error:r.result.error,clean:r.result.clean}));
if(process.argv.includes("--analyze")) {
  JSON.parse(readFileSync(artifact)).runs.forEach(summarize);
} else await withWorkflowLock(async()=>{
  const helper="modules/surface_export/import_phases/belt_restoration";
  const modules={};
  function bundle(path) {
    if(modules[path])return;
    assert.ok(path.startsWith("modules/surface_export/"));
    const source=readFileSync(`docker/seed-data/external_plugins/surface_export/module/${path.slice(23)}.lua`,"utf8").replaceAll("\r\n","\n");
    modules[path]=source;
    for(const [,dep]of source.matchAll(/require\("([^"]+)"\)/g))bundle(dep);
  }
  bundle(helper);
  if(batched)bundle("modules/surface_export/import_phases/belt_batches");
  const baseline=installed?readFileSync("ci-artifacts/belt-helper-baseline.lua","utf8").replaceAll("\r\n","\n"):modules[helper];
  function once(source,from,to) {
    assert.equal(source.split(from).length,2,`patch anchor changed: ${from.slice(0,70)}`);
    return source.replace(from,to);
  }
  if(connected) {
    const key="modules/surface_export/import_phases/belt_batches";
    const packed="    for i, group in ipairs(groups) do\n        local component = { indices = { i }, cost = math.max(#group.slots, #group.members, 1) }";
    if(!modules[key].includes(packed))modules[key]=once(modules[key],"    for _, component in ipairs(ordered) do",packed);
  }
  let candidate=once(baseline,
    "if not VersionCompat.belt_insert_at(line, k / 256, stack_def, count) then return false end",
    "assert(k >= 0 and k / 256 <= line.line_length, 'captured position outside destination line')\n        line.force_insert_at(k / 256, stack_def, count)");
  candidate=once(candidate,"            if not line.can_insert_at(k / 256) then return nil end\n","");
  const start=candidate.indexOf("                    local skmin =");
  const end=candidate.indexOf("\n                end\n            end\n            if not done then",start);
  assert.ok(start>0&&end>start);
  candidate=candidate.slice(0,start)+`                    local sline = se.get_transport_line(slot.src.li)
                    done = try_insert(sline, se, slot.src.li, slot.src.k, slot, wanted_key) == true`+candidate.slice(end);
  const pendingStart=candidate.indexOf("    for _, entry in ipairs(pending) do");
  const pendingEnd=candidate.indexOf("    local physical_delta = {}",pendingStart);
  assert.ok(pendingStart>0&&pendingEnd>pendingStart);
  candidate=candidate.slice(0,pendingStart)+`    for _, entry in ipairs(pending) do
        unplaced = unplaced + entry.slot.ct
        unplaced_list[#unplaced_list + 1] = entry.slot
    end
`+candidate.slice(pendingEnd);
  if(installed)candidate=modules[helper];
  if(profile) {
    assert.ok(installed,"profiling requires the installed helper");
    candidate=once(candidate,'    local side_before = {}',`    local profile = helpers.create_profiler()
    local function measure(stage)
        profile.stop()
        log({"", "[BELT_PROFILE] ", label, " ", stage, " ", profile})
        profile = helpers.create_profiler()
    end
    local side_before = {}`);
    candidate=once(candidate,'    local expected_by_side = {}','    measure("before-census")\n    local expected_by_side = {}');
    candidate=once(candidate,'    local physical_delta = {}','    measure("placement")\n    local physical_delta = {}');
    candidate=once(candidate,'    local dbg = storage.surface_export_config','    measure("after-census")\n    local dbg = storage.surface_export_config');
    candidate=once(candidate,'    return placed, unplaced, anomalies, physical_delta, state_stats','    measure("diagnostics")\n    return placed, unplaced, anomalies, physical_delta, state_stats');
  }
  // Keep the proposed helper reviewable, separate from the deployed production file.
  writeFileSync(installed?"ci-artifacts/belt-helper-installed-candidate.lua":"ci-artifacts/belt-helper-candidate.lua",candidate);
  const boundary=JSON.parse(read("fixture.json"));
  const blackbox=JSON.parse(readFileSync("ci-artifacts/recurrent-failure-blackbox.json"));
  assert.equal(blackbox.transfer_id,"836570928:099_lab-transfer-fixture-v1");
  assert.equal(blackbox.engine_version,"2.1.17");
  const payload=blackbox.replay_payload;
  const ids=new Set(payload.belt_side_groups.flatMap(g=>g.members.map(m=>m.id)));
  const full={entities:payload.entities.filter(e=>ids.has(e.entity_id)).map(e=>({
    id:e.entity_id,name:e.name,position:e.position,direction:e.direction,quality:e.quality,
    belt_to_ground_type:e.specific_data?.belt_to_ground_type,
  })),groups:payload.belt_side_groups.map(g=>({...g,slots:array(g.slots)}))};
  assert.equal(full.entities.length,ids.size);
  assert.ok(full.groups.reduce((n,g)=>n+g.slots.length,0)<=6000,"slot budget exceeded");
  assert.ok(full.entities.every(e=>/belt|splitter/.test(e.name)),"unsupported fixture type");
  const stateful={stateful:true,entities:[
    [{name:"pistol",health:.25},{name:"pistol",health:.75}],
    [{name:"submachine-gun",health:.375}], [{name:"firearm-magazine",ammo:3}],
    [{name:"repair-pack",durability:77}], [{name:"blueprint"}], [{name:"bioflux",spoil:.35}],
    [{name:"iron-plate",quality:"legendary"}],
  ].map((stacks,i)=>({id:i+1,name:"turbo-transport-belt",position:{x:i*3+.5,y:.5},direction:0,stacks})),groups:[]};
  const input={helper,modules,baseline,candidate,fixtures:{boundary,full,stateful}};
  const source=read("helper-probe.lua"),serialized=JSON.stringify(input);
  const compressed=deflateSync(serialized).toString("base64");
  assert.ok(serialized.length<1024*1024);
  const schema=JSON.parse(readFileSync("ci-artifacts/belt-boundary-api.json"));
  assert.equal(schema.application_version,"2.1.17");
  for(const [cls,members]of Object.entries({LuaHelpers:["decode_string","create_profiler"],LuaTransportLine:["force_insert_at","clear","get_detailed_contents","line_length","valid"],
    LuaEntity:["get_max_transport_line_index","get_transport_line"],
    LuaItemStack:["health","ammo","durability","is_blueprint","set_blueprint_entities","get_blueprint_entities","label","spoil_percent"]})) {
    const c=schema.classes.find(c=>c.name===cls);
    const inherited=[];
    for(let current=c;current;current=schema.classes.find(c=>c.name===current.parent))inherited.push(...current.methods,...current.attributes);
    for(const member of members)assert.ok(inherited.some(m=>m.name===member),`${cls}.${member}`);
  }
  const token=`helper-${Date.now()}`;
  const results={hash:hash(serialized+source+read("run-helper.mjs")),engine:"2.1.17",moduleHashes:Object.fromEntries(Object.entries(modules).map(([k,v])=>[k,hash(v)])),candidateHash:hash(candidate),runs:[]};
  if(process.argv.includes("--prepare")) {
    console.log(JSON.stringify({hash:results.hash,bytes:serialized.length,compressedBytes:compressed.length,modules:Object.keys(modules).length,
      fullEntities:full.entities.length,fullGroups:full.groups.length,fullSlots:full.groups.reduce((n,g)=>n+g.slots.length,0)}));
    return;
  }
  for(const host of [1,2])assertLeaseClean(host,preflightState(host),"before helper experiment");
  const claim=lua(2,`assert(not storage.__belt_helper_experiment,'experiment storage already exists');for n in pairs(game.surfaces) do assert(type(n)~='string' or not n:find('belt-helper-',1,true),'leftover experiment surface') end storage.__belt_helper_experiment={token='${token}',input=''} return {ok=true}`);
  assert.equal(claim.ok,true,claim.error);
  try {
    for(let i=0;i<compressed.length;i+=10000) {
      const r=lua(2,`local s=storage.__belt_helper_experiment;assert(s.token=='${token}');s.input=s.input..'${compressed.slice(i,i+10000)}' return {ok=true}`);
      assert.equal(r.ok,true,r.error);
    }
    const decoded=lua(2,`local s=storage.__belt_helper_experiment;assert(s.token=='${token}');s.input=assert(helpers.decode_string(s.input),'bundle decode failed');return {bytes=#s.input}`);
    assert.equal(decoded.bytes,Buffer.byteLength(serialized));
    const arms=batched?[['boundary','cleanup'],['full','batched']]:profile?[['boundary','cleanup'],['full','force']]:[['boundary','cleanup'],['boundary','baseline'],['boundary','force'],['boundary','force'],['boundary','force'],['stateful','force'],['full','force']];
    for(const [fixture,arm]of arms) {
      const name=`belt-helper-${token}-${results.runs.length}`;
      const code=mode=>source.replaceAll("__TOKEN__",token).replaceAll("__NAME__",name).replaceAll("__MODE__",mode).replaceAll("__ARM__",arm).replaceAll("__FIXTURE__",fixture);
      let result;
      try {
        if(arm!=="cleanup") {const r=lua(2,code("setup"));assert.equal(r.prepared,true,r.error);}
        result=lua(2,code(arm));
        if(arm==="batched") {
          const steps=[];
          for(let i=0;i<32;i++) {
            steps.push(result);
            if(!result.pending)break;
            result=lua(2,code(arm));
          }
          assert.ok(!result.pending,"batch callback budget exceeded");
          result={...result,steps};
        }
        assert.ok(Buffer.byteLength(JSON.stringify(result))<(connected?64:8)*1024*1024,"result budget exceeded");
      } finally {
        const clean=lua(2,`local s=game.surfaces['${name}'];if s then game.delete_surface(s) end return {absent=s==nil}`);
        if(result)result.clean=clean.absent;
        assert.equal(clean.absent,true,"probe leaked a surface; rescue deletion requested");
      }
      results.runs.push({fixture,arm,result});
      writeFileSync(artifact,JSON.stringify(results,null,2));
      assert.notEqual(result.status,"HARNESS_ERROR",result.error);
      if(arm==="cleanup"){summarize(results.runs.at(-1));continue;}
      if(arm!=="batched")assert.equal(result.startTick,result.endTick);
      if(arm==="baseline") {
        assert.equal(result.anomalies,2,"real helper must reproduce the two structural anomalies");
        result.status="EXPECTED_FAILURE";
      } else {
        const expected=array(result.groups).flatMap((g,gi)=>array(g.slots).map((s,i)=>({group:gi+1,id:g.item_source_positions[i*3],line:g.item_source_positions[i*3+1],k:g.item_source_positions[i*3+2],n:s.n,q:s.q||"normal",ct:s.ct})));
        const keys=rows=>array(rows).map(r=>JSON.stringify([r.group,r.id,r.line,r.k,r.n,r.q,r.ct])).sort();
        result.exact=JSON.stringify(keys(result.rows))===JSON.stringify(keys(expected));
        if(arm==="batched"&&connected) {
          const totals=(rows,grouped=false)=>{
            const out={};for(const r of array(rows)) {
              const key=JSON.stringify([...(grouped?[r.group]:[]),r.n,r.q]);out[key]=(out[key]||0)+r.ct;
            }return out;
          };
          const completed=new Set();
          for(const step of result.steps) {
            assert.equal(step.anomalies,0);assert.equal(step.unplaced,0);
            const indices=array(step.plan.batches[step.completed-1].indices);
            const before=totals(step.before,true),after=totals(step.rows,true),delta={};
            for(const key of new Set([...Object.keys(before),...Object.keys(after)])) {
              const value=(after[key]||0)-(before[key]||0);if(value)delta[key]=value;
            }
            assert.deepEqual(delta,totals(expected.filter(row=>indices.includes(row.group)),true),
              "each batch must land on its captured groups");
            for(const index of indices){assert.ok(!completed.has(index));completed.add(index);}
            assert.deepEqual(totals(step.rows),totals(expected.filter(row=>completed.has(row.group))),
              "whole fixture cargo must equal all completed writes");
          }
          for(let i=1;i<result.steps.length;i++)assert.ok(result.steps[i].startTick>result.steps[i-1].endTick);
          assert.equal(completed.size,array(result.groups).length);assert.ok(result.steps.length>1);
          result.groupPlacementVerified=true;
        } else if(arm==="batched") {
          const plan=result.plan;
          const groupBatch=new Map(plan.batches.flatMap((b,i)=>b.indices.map(gi=>[gi,i])));
          const totals=rows=>{
            const out={};for(const r of array(rows)) {const key=JSON.stringify([groupBatch.get(r.group),r.n,r.q]);out[key]=(out[key]||0)+r.ct;}
            return out;
          };
          assert.ok(plan.batches.length>1);
          for(const step of result.steps) {
            assert.equal(step.anomalies,0);assert.equal(step.unplaced,0);
            const completed=step.completed;
            assert.deepEqual(totals(step.rows),totals(expected.filter(r=>groupBatch.get(r.group)<completed)),"completed networks must retain all cargo across callbacks");
            const currentRows=step.rows.filter(r=>groupBatch.get(r.group)===completed-1);
            assert.deepEqual(keys(currentRows),keys(expected.filter(r=>groupBatch.get(r.group)===completed-1)),"newly restored network positions must match exactly");
          }
          for(let i=1;i<result.steps.length;i++)assert.ok(result.steps[i].startTick>result.steps[i-1].endTick,"must yield across simulation ticks");
          // Final positions may advance within completed networks; each network was checked
          // exactly when inserted, and whole-network cargo is independently checked on every callback.
          result.networksExact=true;
        }
        if(fixture==="stateful")assert.deepEqual(result.rows,result.before,"physical item state changed");
        if((!result.exact&&!result.networksExact&&!result.groupPlacementVerified)||result.unplaced!==0||result.anomalies!==0||Object.entries(result.stats).some(([k,v])=>k!=="applied"&&v!==0)) {
          result.status="STOP";result.cause="physical tuples or existing structural/state gate did not match";
        }
      }
      writeFileSync(artifact,JSON.stringify(results,null,2));summarize(results.runs.at(-1));
      if(result.status==="STOP")break;
    }
  } finally {
    const clean=lua(2,`assert(storage.__belt_helper_experiment.token=='${token}');storage.__belt_helper_experiment=nil;return {clean=storage.__belt_helper_experiment==nil}`);
    assert.equal(clean.clean,true);
    results.storageClean=true;
    results.postflight={};
    for(const host of [1,2]) {const s=preflightState(host);assertLeaseClean(host,s,"after helper experiment");results.postflight[host]=s;}
    writeFileSync(artifact,JSON.stringify(results,null,2));
  }
});
