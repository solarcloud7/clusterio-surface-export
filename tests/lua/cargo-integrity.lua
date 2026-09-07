-- Cargo-integrity regressions: production Lua with deterministic fake engine objects.
-- No live game, restoration APIs, event transport, or source deletion is exercised.
local root='docker/seed-data/external_plugins/surface_export/module/'
local cache, logs = {}, {}
local function noop() end
local function count(t)local n=0 for _ in pairs(t or {})do n=n+1 end return n end
local function sum(t)local n=0 for _,v in pairs(t or {})do n=n+v end return n end
local env=setmetatable({storage={surface_export_config={},async_job_results={}},game={tick=100,print=noop},log=function(v)logs[#logs+1]=v end,table_size=count},{__index=_G})
local function loadmod(name)
 if cache[name]then return cache[name]end
 local fn=assert(loadfile(root..name..'.lua','t',env)); local m=fn();cache[name]=m;return m
end
env.require=function(path)
 local name=path:match('^modules/surface_export/(.*)$')
 if not name then return {} end
 return loadmod(name)
end
cache['utils/version-compat']={}
local gu=loadmod('utils/game-utils')
local util={QUALITY_NORMAL='normal',HIGH_TEMP_THRESHOLD=10000,make_quality_key=gu.make_quality_key,make_fluid_temp_key=gu.make_fluid_temp_key,parse_fluid_temp_key=gu.parse_fluid_temp_key,sum_items=sum,sum_fluids=sum}
cache['utils/util']=util
cache['export_scanners/fluid-registry']={}
cache['utils/operation-timing']={start=noop,stop=noop,fail=noop,finish=noop}
local scanner=loadmod('export_scanners/inventory-scanner')
local counter=loadmod('validators/cargo-counter')
local verification=loadmod('validators/verification')
local accumulator=loadmod('export_scanners/source-cargo-integrity')
local validation=loadmod('validators/transfer-validation')
local entity={valid=true,name='steel-chest',type='container',unit_number=1,position={x=0,y=0},fluids_count=0}
local inventory={{valid_for_read=true,prototype={type='item'},name='iron-plate',count=10,quality={name='normal'}}}
inventory.get_contents=function()return {{name='iron-plate',count=inventory[1].count,quality='normal'}}end
inventory.valid=true;inventory.is_empty=function()return false end
entity.get_max_inventory_index=function()return 1 end
entity.get_inventory=function()return inventory end
entity.get_inventory_name=function()return 'chest' end
local surface={valid=true,find_entities_filtered=function(filter)if filter.type=='item-entity'then return {}end return {entity}end}
local function gate(expected)return validation.validate_import(surface,{item_counts=expected,fluid_counts={}},{strict=true})end
-- Control: source code's actual scanner/counter sees inventory quantities.
assert(counter.count_entity_items(entity)['iron-plate']==10)
assert(gate({['iron-plate']=10})==true)
-- Required engine read errors must remain unavailable, even with empty expectations.
entity.get_max_inventory_index=function()error('injected engine read failure')end
logs={};local ok,r=gate({});assert(not ok and r.measurementAvailable==false and r.actualItemCounts==nil and #logs>0)
print('PASS read error + empty expectation: success='..tostring(ok)..' unavailable='..tostring(r.measurementAvailable==false))
assert(gate({['iron-plate']=10})==false)
print('CONTROL read error + known nonzero expectation: rejected')
-- A serializer helper omission must not also hide quantities from the independent counter.
entity.get_max_inventory_index=function()return 1 end
-- Quantity reads preserve quality and deduplicate aliased inventory slots.
local original_contents=inventory.get_contents
inventory.get_contents=function()return {
 {name='iron-plate',count=3,quality='normal'},
 {name='iron-plate',count=7,quality='legendary'},
}end
entity.get_max_inventory_index=function()return 2 end
local quantities=counter.count_entity_items(entity)
assert(quantities['iron-plate']==3 and quantities[gu.make_quality_key('iron-plate','legendary')]==7)
assert(sum(quantities)==10)
inventory.get_contents=original_contents
entity.get_max_inventory_index=function()return 1 end
local line={valid=true,get_contents=function()return {{name='iron-plate',count=4,quality='rare'}}end}
local belt={valid=true,name='transport-belt',type='transport-belt',get_max_transport_line_index=function()return 2 end,
 get_transport_line=function()return line end}
assert(counter.count_entity_items(belt,'belts')[gu.make_quality_key('iron-plate','rare')]==8)
line.get_contents=function()error('injected belt read failure')end
assert(not pcall(counter.count_entity_items,belt,'belts'))
local stack={valid_for_read=true,name='iron-plate',count=2,quality={name='uncommon'}}
assert(counter.count_entity_items({valid=true,name='inserter',type='inserter',held_stack=stack},'held')[gu.make_quality_key('iron-plate','uncommon')]==2)
assert(counter.count_entity_items({valid=true,name='item-on-ground',type='item-entity',stack=stack},'ground')[gu.make_quality_key('iron-plate','uncommon')]==2)
local fluid_entity={valid=true,name='pipe',fluids_count=1,has_fluid_segment=function()return true end,
 get_fluid_segment_id=function()return 42 end,
 get_fluid_segment_fluid=function()return {name='water',amount=12,temperature=15}end}
local fluid_state={counted_segments={}}
assert(sum(counter.count_entity_fluids(fluid_entity,fluid_state))==12)
assert(sum(counter.count_entity_fluids(fluid_entity,fluid_state))==0)
fluid_entity.get_fluid_segment_fluid=function()error('injected fluid read failure')end
assert(not pcall(counter.count_entity_fluids,fluid_entity,{counted_segments={}}))
print('PASS quality, inventory alias, belt, held, ground and shared-fluid quantity reads')
local original=scanner.extract_all_inventories
scanner.extract_all_inventories=function()return {}end
local data={entity_id=1,name=entity.name,type=entity.type,specific_data={inventories=scanner.extract_all_inventories(entity)}}
local acc=accumulator.new({segments={}});accumulator.record(acc,entity,data)
assert(not accumulator.verdict(acc).ok)
assert(not gate(verification.count_all_items({data})))
print('PASS injected shared extractor omission: 10 physical items, source and destination both reject')
scanner.extract_all_inventories=original
-- Physical count read failure in accumulator, with empty serialized record.
entity.get_max_inventory_index=function()error('injected engine read failure')end
acc=accumulator.new({segments={}});accumulator.record(acc,entity,data);assert(not accumulator.verdict(acc).ok)
print('PASS source read error + empty serialized quantity: cargo integrity rejects')
entity.get_max_inventory_index=function()return 1 end
-- Drive actual run_phase2 through expected-count adjustments and actual validator.
-- Stop immediately at store_validation_result to exclude activation and other mocked boundaries.
local stub=setmetatable({},{__index=function()return noop end})
for _,name in ipairs({'import_phases/entity_state_restoration','import_phases/belt_restoration','import_phases/belt_batches','import_phases/active_state_restoration','import_phases/latch_rearm','import_phases/platform_hub_mapping','utils/debug-export','utils/platform-schedule','export_scanners/entity-scanner','core/gateway','utils/phase-profiler','utils/phase-recorder','utils/transaction-history','core/job-results'})do cache[name]=stub end
cache['core/deserializer']={new_item_state_session=function()return {applied=0,declined=0,failed=0}end,release_item_state_session=noop}
local fluid_result={count=0}
cache['import_phases/fluid_restoration']={restore=function()return fluid_result end}
local completion=loadmod('core/import-completion')
local captured
validation.store_validation_result=function(_,result)captured=result;error('REVIEW_BOUNDARY')end
local function run(label,items,fluids,fel,iol,rejected,expected_success,forced_hook)
 inventory[1].count=5
 entity.fluids_count=0
 if fluids then
  entity.fluids_count=1;entity.has_fluid_segment=function()return false end
  entity.get_fluid=function()return {name='water',temperature=15,amount=5}end
 end
 fluid_result={count=0,write_rejected=rejected}
 local job={job_id='probe',transfer_id='review',started_tick=90,metrics={},entity_map={},entities_to_create={},platform_name='review',total_entities=1,target_surface=surface,platform_data={verification={item_counts=items or {['iron-plate']=5},fluid_counts=fluids or {}}},failed_entity_losses=fel,inventory_overflow_losses=iol}
 job.test_forced_entity_failure=forced_hook
 captured=nil
 local good,err=pcall(completion.run_phase2,job)
 assert(not good and tostring(err):find('REVIEW_BOUNDARY',1,true),tostring(err))
 assert(captured and captured.success==expected_success,label)
 print('PASS '..label..': success='..tostring(captured.success)..' expectedItems='..captured.totalExpectedItems..' actualItems='..captured.totalActualItems..' expectedFluids='..captured.totalExpectedFluids..' actualFluids='..captured.totalActualFluids)
end
run('unadjusted item shortage rejects',{['iron-plate']=10},nil,nil,nil,nil,false)
run('failed entity loss rejected',{['iron-plate']=10},nil,{entity_count=1,items={['iron-plate']=5},total_items=5},nil,nil,false)
run('inventory overflow rejected',{['iron-plate']=10},nil,nil,{items={['iron-plate']=5},total=5},nil,false)
run('unadjusted fluid shortage rejects',nil,{['water@15.0C']=10},nil,nil,nil,false)
run('rejected fluid write rejected',nil,{['water@15.0C']=10},nil,nil,{water=5},false)
run('forced hook follows ordinary failure policy',{['iron-plate']=10},nil,{entity_count=1,items={['iron-plate']=5},total_items=5},nil,nil,false,true)
run('failed empty entity rejects',nil,nil,{entity_count=1,items={},total_items=0},nil,nil,false)
print('All cargo-integrity regressions passed; no live state was changed.')


