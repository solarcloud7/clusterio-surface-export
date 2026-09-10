import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';

export function luaSequence(value) {
  assert.ok(value && typeof value==='object','missing Lua sequence');
  if(Array.isArray(value))return value;
  const keys=Object.keys(value).sort((a,b)=>Number(a)-Number(b));
  keys.forEach((key,index)=>assert.equal(key,String(index+1),'invalid or sparse Lua sequence'));
  return keys.map(key=>value[key]);
}
const sequence=luaSequence;
export function canonicalSettings(observation) {
  assert.equal(observation.inventoryDestroyed,true,'observer inventory cleanup missing');
  assert.ok(!observation.captureError,observation.captureError);
  const identities=observation.identities;
  assert.ok(identities && Number.isInteger(observation.tick),'missing settings observation');
  const resolve=id=>{const key=identities[String(id)];assert.ok(key,`unresolved entity reference ${id}`);return key;};
  function normalize(value,key) {
    // Factorio 2.1.17 ArithmeticCombinatorBlueprintControlBehavior uses
    // ArithmeticCombinatorParameters: omitted constants default to zero.
    // Preserve raw readings; only normalize defaults for operands without signals.
    if(key==='arithmetic_conditions') {
      value={...value};
      if(value.first_signal===undefined && value.first_constant===undefined)value.first_constant=0;
      if(value.second_signal===undefined && value.second_constant===undefined)value.second_constant=0;
    }
    if(key==='entity_id') return resolve(value);
    if(key==='neighbours') return sequence(value).map(resolve).sort();
    if(key==='wires') return sequence(value).map(wire=>{
      assert.ok(Array.isArray(wire)&&wire.length===4,'unexpected blueprint wire tuple');
      const ends=[[resolve(wire[0]),wire[1]],[resolve(wire[2]),wire[3]]];
      return ends.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if(Array.isArray(value)) return value.map(v=>normalize(v));
    if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k],k)]));
    return value;
  }
  const result={};
  for(const entity of sequence(observation.entities)) {
    const key=resolve(entity.entity_number);assert.ok(!result[key],'ambiguous physical entity identity');
    const {entity_number,...settings}=entity;
    result[key]=normalize(settings);
  }
  return result;
}
export function compareSettings(before,after) {
  const expected=canonicalSettings(before),actual=canonicalSettings(after),differences=[];
  for(const key of [...new Set([...Object.keys(expected),...Object.keys(actual)])].sort()) {
    if(!expected[key]||!actual[key]) {differences.push({entity:key,field:'presence',expected:!!expected[key],actual:!!actual[key]});continue;}
    for(const field of new Set([...Object.keys(expected[key]),...Object.keys(actual[key])])) {
      if(!isDeepStrictEqual(expected[key][field],actual[key][field])) differences.push({entity:key,field,expected:expected[key][field],actual:actual[key][field]});
    }
  }
  return {verdict:differences.length?'STOP':'PASS',checkedEntities:Object.keys(expected).length,differences,
    uncovered:{before:sequence(before.uncovered),after:sequence(after.uncovered)}};
}
