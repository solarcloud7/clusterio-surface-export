const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shipPhaseFor, groupEdgeShips } = require('../dist/node/shared/transfer-status');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const motion={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../web/gateway/transfer-motion.ts'),'utf8'),
 {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:motion,require:name=>
 name==='./ship-motion'?{}:require('../dist/node/shared/transfer-status')});

test('unresolved recovery never claims a return or arrival', () => {
 for (const status of ['error', 'failed', 'cleanup_failed']) {
  const summary = { status, timingPendingRecovery: true, sourceRestored: true };
  const phase = shipPhaseFor(summary);
  assert.ok(phase, 'recovery must remain visible');
  assert.equal(phase.terminal, false);
  assert.equal(phase.distance, .5);
  assert.equal(phase.holding, true);
  assert.doesNotMatch(groupEdgeShips([summary], () => false).markers[0].label, /returned|arrived|timed out/);
 }
});
test('recovery remains visible after reload and gets a fresh linger window when resolved',()=>{
 const pending={transferId:'recover',status:'error',timingPendingRecovery:true,operationType:'transfer',sourceInstanceId:1,targetInstanceId:2};
 assert.equal(motion.shipsInFlight([pending],100000).length,1);
 motion.noteTerminalSeen('recover',1);motion.noteLiveSeen('recover');
 assert.equal(motion.shipExpiryMs(pending,100000),null);
 const done={...pending,status:'completed',timingPendingRecovery:false};
 assert.equal(motion.shipExpiryMs(done,100000),110000);
 motion.noteTerminalSeen('recover',100000);
 assert.equal(motion.shipsInFlight([done],110001).length,0);
});

test('only confirmed source recovery claims a return; historical errors remain neutral', () => {
 assert.equal(shipPhaseFor({status:'failed',sourceRestored:true}).distance,0);
 assert.match(shipPhaseFor({status:'failed',sourceRestored:true}).label,/returned/);
 for(const status of ['failed','error','cleanup_failed']) {
  assert.doesNotMatch(shipPhaseFor(status).label,/returned|arrived|timed out/);
  assert.equal(shipPhaseFor(status).distance,.5);
 }
 assert.equal(shipPhaseFor('completed').distance,1);
});
