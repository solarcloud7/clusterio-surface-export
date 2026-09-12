import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sample, start, summary, terminal } from "./cases.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { recoveryBrowser } from "./recovery-browser.mjs";

export const contract = {
  requires: ["owned disposable Docker lab", "Factorio 2.1.17", "verified pre-transfer checkpoint"],
  produces: ["both save policies", "physical restored cargo", "fresh identities", "delayed-message observations"],
  "does not": ["mutate the development cluster", "automatically reconstruct missing platforms", "claim universal crash safety"],
};
const find = name => `local p;for _,v in pairs(game.forces.player.platforms) do if v.name==${JSON.stringify(name)} then assert(not p);p=v end end;assert(p,'fixture missing');`;
export const recoveryReady = (lab,host) => lab.until(() => lab.lua(host,
  "return {success=true,ready=storage.source_recovery_ready==true}").result.ready, "save reconciliation",60);
const identity = (lab,name) => lab.lua(1,find(name)+"local uid;for _,v in pairs(remote.call('surface_export','list_platforms','player')) do if v.platform_index==p.index then uid=v.platform_uid end end;assert(uid,'missing identity');return {success=true,index=p.index,uid=uid,epoch=storage.source_recovery_epoch}").result;
const setMode = (lab,mode) => {
  lab.ctl("controller","config","set","surface_export.platform_source_of_truth",mode);
  const config=lab.ctl("controller","config","list");
  assert.ok(config.split(/\r?\n/).some(line=>line.includes("surface_export.platform_source_of_truth") && line.includes(mode)),"controller mode readback missing");
};

export async function savePolicyCase(lab,report,save) {
  report.mode=report.case==="save-policy-game"?"save_game":"plugin_history";
  await recoveryReady(lab,1);await recoveryReady(lab,2);
  setMode(lab,report.mode);
  await lab.checkpoint("manual-policy-start",[1]);await lab.load(1,"manual-policy-start");await recoveryReady(lab,1);
  const name=report.name=`transfer-cleanup-${lab.run}-policy`, other=`${name}-unrelated`;
  report.before=lab.probe(1,"build",name).state;
  report.unrelatedBefore=lab.probe(1,"build",other).state;
  assert.deepEqual(report.before.cargo,expectedCargo);assert.deepEqual(report.unrelatedBefore.cargo,expectedCargo);
  // Save new platform identities through the normal restart reconciliation.
  await lab.checkpoint("manual-policy-created",[1]);await lab.load(1,"manual-policy-created");await recoveryReady(lab,1);
  report.identityBefore=identity(lab,name);
  report.checkpoint=await lab.checkpoint("manual-policy-before",[1]);save();
  lab.lua(1,find(other)+"assert(game.delete_surface(p.surface),'fixture deletion refused');return {success=true}");
  assert.equal(lab.probe(1,"read",other).state.present,false,"local destruction did not occur");
  report.transferId=start(lab,name);report.outcome=await terminal(lab,report.transferId);
  assert.equal(report.outcome.status,"completed");
  report.transferred=sample(lab,name);assert.equal(report.transferred.source.present,false);
  await lab.load(1,"manual-policy-before");await recoveryReady(lab,1);
  report.restored=sample(lab,name);report.unrelatedRestored=lab.probe(1,"read",other).state;
  report.identityAfter=identity(lab,name);
  report.notices=lab.lua(1,"return {success=true,notices=storage.source_recovery_notices,mode=storage.source_recovery_mode}").result;
  save();
  assert.deepEqual(report.restored.source.cargo,expectedCargo);
  assert.deepEqual(report.restored.destination.cargo,expectedCargo);
  assert.deepEqual(report.unrelatedRestored.cargo,expectedCargo);assert.equal(report.unrelatedRestored.usable,true);
  assert.equal(report.restored.source.usable,report.mode==="save_game");
  assert.equal(report.restored.destination.usable,true);
  const notice=report.notices.notices[report.identityAfter.index];
  assert.equal(notice.status,report.mode==="save_game"?"accepted":"protected");
  if(report.mode==="plugin_history") {
    assert.equal(report.identityAfter.uid,report.identityBefore.uid);
    report.browser=await recoveryBrowser(lab,report);save();return;
  }
  assert.notEqual(report.identityAfter.uid,report.identityBefore.uid);
  setMode(lab,"plugin_history");
  report.beforeRestartMode=lab.lua(1,"return {success=true,mode=storage.source_recovery_mode}").result.mode;
  assert.equal(report.beforeRestartMode,"save_game");
  report.browser=await recoveryBrowser(lab,report,{restartRequired:true});save();
  await lab.checkpoint("manual-policy-accepted",[1]);await lab.load(1,"manual-policy-accepted");await recoveryReady(lab,1);
  report.acceptedRestart={identity:identity(lab,name),sample:sample(lab,name)};
  assert.equal(report.acceptedRestart.identity.uid,report.identityAfter.uid);
  assert.equal(report.acceptedRestart.sample.source.usable,true);
  const job=report.transferId.slice(report.transferId.indexOf(":")+1), old=report.identityBefore;
  report.delayed=lab.lua(1,`local d=remote.call('surface_export','delete_platform_for_transfer',${old.index},${JSON.stringify(name)},'player',${JSON.stringify(job)},${JSON.stringify(old.uid)});
    local u,e=remote.call('surface_export','unlock_platform',${old.index},nil,${JSON.stringify(job)});return {success=true,deletion=d,unlock=u,error=e}`).result;
  assert.match(report.delayed.deletion,/^ERROR:/);assert.equal(report.delayed.unlock,false);
  const again=`${name}-again`;
  lab.lua(1,find(name)+`p.name=${JSON.stringify(again)};return {success=true}`);
  report.againId=start(lab,again);assert.notEqual(report.againId,report.transferId);
  report.againOutcome=await terminal(lab,report.againId);assert.equal(report.againOutcome.status,"completed");
  report.again=sample(lab,again);assert.equal(report.again.source.present,false);assert.deepEqual(report.again.destination.cargo,expectedCargo);
  await lab.checkpoint("manual-policy-final");
  for(const host of [1,2]) {await lab.load(host,"manual-policy-final");await recoveryReady(lab,host);}
  report.final=sample(lab,again);assert.deepEqual(report.final.destination.cargo,expectedCargo);
  report.originalHistory=summary(lab,report.transferId);assert.equal(report.originalHistory.status,"completed");save();
}

export async function snapshotRecoveryCase(lab,report,save) {
  report.snapshotRecoveryVersion=2;
  await recoveryReady(lab,1);await recoveryReady(lab,2);
  const name=report.name=`transfer-cleanup-${lab.run}-snapshot`;
  report.before=lab.probe(1,"build",name).state;assert.deepEqual(report.before.cargo,expectedCargo);
  report.checkpoint=await lab.checkpoint("manual-snapshot-before",[2]);
  report.transferId=start(lab,name);report.outcome=await terminal(lab,report.transferId);
  assert.equal(report.outcome.status,"completed");
  await lab.load(2,"manual-snapshot-before");await recoveryReady(lab,2);
  report.rollback=sample(lab,name);report.originalHistory=summary(lab,report.transferId);save();
  assert.equal(report.rollback.source.present,false);assert.equal(report.rollback.destination.present,false);
  assert.equal(report.originalHistory.status,"completed","#315 reproduction must retain original history");
  report.browser=await recoveryBrowser(lab,report,{restoreFailure:true});save();
  const requestId=report.requestId=randomUUID();
  const submit=()=>JSON.parse(lab.ctl("surface-export","restore-snapshot",report.transferId,lab.ids[2],requestId).trim().split(/\r?\n/).at(-1));
  report.recovery=submit();assert.equal(report.recovery.success,true);
  report.duplicate=submit();assert.equal(report.duplicate.operationId,report.recovery.operationId);
  report.recoveryOutcome=await terminal(lab,report.recovery.operationId);
  assert.equal(report.recoveryOutcome.status,"completed");
  report.recovered=sample(lab,name);assert.deepEqual(report.recovered.destination.cargo,expectedCargo);
  assert.equal(report.recovered.source.present,false);assert.equal(report.recovered.destination.usable,true);
  await lab.checkpoint("manual-snapshot-recovered",[2]);await lab.load(2,"manual-snapshot-recovered");await recoveryReady(lab,2);
  report.final=sample(lab,name);assert.deepEqual(report.final.destination.cargo,expectedCargo);
  report.finalHistory=summary(lab,report.transferId);assert.equal(report.finalHistory.status,"completed");save();
  lab.ctl("instance","stop",lab.hosts[2].instance);
  report.offlineBrowser=await recoveryBrowser(lab,report,{offlineInstance:lab.hosts[2].instance});save();
  lab.ctl("instance","start",lab.hosts[2].instance,"--save","manual-snapshot-recovered.zip");
  await recoveryReady(lab,2);report.onlineAgain=sample(lab,name);save();
  assert.deepEqual(report.onlineAgain.destination.cargo,expectedCargo);
}

export async function pendingSavePolicyCase(lab,report,save) {
  setMode(lab,"save_game");
  await lab.checkpoint("manual-pending-policy",[1]);await lab.load(1,"manual-pending-policy");await recoveryReady(lab,1);
  const name=report.name=`transfer-cleanup-${lab.run}-pending-policy`;
  report.before=lab.probe(1,"build",name).state;assert.deepEqual(report.before.cargo,expectedCargo);
  await lab.checkpoint("manual-pending-identity",[1]);await lab.load(1,"manual-pending-identity");await recoveryReady(lab,1);
  report.identityBefore=identity(lab,name);report.checkpoint=await lab.checkpoint("manual-pending-before",[1]);
  lab.writeFault(1,{run:lab.run,enabled:true,name,action:"source"});
  report.transferId=start(lab,name);save();
  report.held=await lab.until(()=>lab.events(1).find(event=>event.kind==="response-held"&&event.name===name),"successful deletion reply withheld",120);
  report.beforeReload=sample(lab,name);assert.equal(report.beforeReload.source.present,false);
  assert.equal(report.beforeReload.destination.held,true);save();
  await lab.load(1,"manual-pending-before");await recoveryReady(lab,1);
  report.protected=sample(lab,name);report.identityAfter=identity(lab,name);
  report.notices=lab.lua(1,"return {success=true,mode=storage.source_recovery_mode,notices=storage.source_recovery_notices,allow=storage.source_recovery_allow_adoption}").result;save();
  assert.equal(report.notices.allow,false);assert.equal(report.protected.source.usable,false);
  assert.equal(report.identityAfter.uid,report.identityBefore.uid);
  assert.deepEqual(report.protected.source.cargo,expectedCargo);assert.deepEqual(report.protected.destination.cargo,expectedCargo);
  lab.writeFault(1,{run:lab.run,enabled:false});
  lab.mutateContainer("kill",lab.controller,["--signal","KILL"]);lab.mutateContainer("start",lab.controller);await lab.ready();
  report.outcome=await terminal(lab,report.transferId);report.final=sample(lab,name);
  report.events={1:lab.events(1),2:lab.events(2)};save();
  assert.equal(report.outcome.status,"completed");assert.equal(report.final.source.present,false);
  assert.equal(report.final.destination.usable,true);assert.deepEqual(report.final.destination.cargo,expectedCargo);
}
