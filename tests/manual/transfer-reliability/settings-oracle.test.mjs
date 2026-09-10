import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSettings,luaSequence} from './settings-oracle.mjs';
const fixture=()=>({inventoryDestroyed:true,tick:10,identities:{1:'inserter@1,1',2:'constant-combinator@2,1'},uncovered:[],
  entities:[{entity_number:1,name:'inserter',filters:[{index:1,name:'iron-plate'}],wires:[[1,1,2,1]]},
    {entity_number:2,name:'constant-combinator',control_behavior:{is_on:true}}]});
test('settings comparison ignores runtime numbering but preserves references',()=>{
  const a=fixture(),b=fixture();b.identities={7:a.identities[1],8:a.identities[2]};
  b.entities[0].entity_number=7;b.entities[1].entity_number=8;b.entities[0].wires=[[7,1,8,1]];
  assert.equal(compareSettings(a,b).verdict,'PASS');
});
for(const [name,mutate] of [['filter',b=>b.entities[0].filters[0].name='copper-plate'],
  ['wire',b=>b.entities[0].wires=[]],['control behavior',b=>b.entities[1].control_behavior.is_on=false],
  ['missing entity',b=>b.entities.pop()]]) test(`detects altered ${name}`,()=>{
    const a=fixture(),b=fixture();mutate(b);assert.equal(compareSettings(a,b).verdict,'STOP');
  });
test('missing evidence cannot pass',()=>assert.throws(()=>compareSettings(fixture(),{captureError:'failed'})));
test('empty Factorio table is an empty sequence, but missing and sparse evidence fail',()=>{
  assert.deepEqual(luaSequence({}),[]);assert.deepEqual(luaSequence({'2':'b','1':'a'}),['a','b']);
  assert.throws(()=>luaSequence(undefined));assert.throws(()=>luaSequence({'2':'b'}));
});
test('documented arithmetic zero defaults compare equally, changed operands still fail',()=>{
  const a=fixture(),b=fixture();
  a.entities[1].control_behavior={arithmetic_conditions:{operation:'*',second_constant:0}};
  b.entities[1].control_behavior={arithmetic_conditions:{operation:'*',first_constant:0,second_constant:0}};
  assert.equal(compareSettings(a,b).verdict,'PASS');
  b.entities[1].control_behavior.arithmetic_conditions.first_constant=1;
  assert.equal(compareSettings(a,b).verdict,'STOP');
});
