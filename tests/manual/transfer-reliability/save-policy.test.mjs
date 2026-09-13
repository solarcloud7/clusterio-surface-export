import test from "node:test";
import assert from "node:assert/strict";
import { analyze } from "./oracle.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

test("retained native recovery observations still satisfy the independent physical oracle",()=>{
  for(const name of ["save-policy-game","save-policy-history","save-policy-pending","snapshot-recovery","snapshot-recovery-sectional","snapshot-offline-recovery"]) {
    const report=JSON.parse(gunzipSync(readFileSync(new URL(`./evidence/${name}-2.1.17.json.gz`,import.meta.url))));
    assert.equal(analyze(report).verdict,"PASS");
    const destination=report.final?.destination || report.restored.destination;
    destination.cargo.entities.pop();
    assert.throws(()=>analyze(report),"retained evidence passed after physical cargo mutation");
  }
});

test("native require and expired-snapshot failures remain failures",()=>{
  for(const name of ["save-policy-require-failure","snapshot-retention-failure"]) {
    const report=JSON.parse(gunzipSync(readFileSync(new URL(`./evidence/${name}-2.1.17.json.gz`,import.meta.url))));
    assert.equal(report.verdict,"HARNESS_ERROR");assert.throws(()=>analyze(report));
  }
});

const copy=()=>({present:true,usable:true,cargo:structuredClone(expectedCargo)});
const pair=()=>({source:{present:false},destination:copy()});
function policy(accepted=true) {
  return {schemaVersion:1,case:accepted?"save-policy-game":"save-policy-history",cleanup:{success:true},
    before:copy(),outcome:{status:"completed"},browser:{dialog:true,errors:[],warnings:true,restartRequired:accepted},
    restored:{source:{...copy(),usable:accepted},destination:copy()},unrelatedRestored:copy(),
    notices:{mode:accepted?"save_game":"plugin_history",notices:{3:{status:accepted?"accepted":"protected"}}},
    identityBefore:{uid:"before:3"},identityAfter:{index:3,uid:accepted?"after:3":"before:3"},
    beforeRestartMode:"save_game",acceptedRestart:{identity:{uid:"after:3"},sample:{source:copy()}},
    delayed:{deletion:"ERROR: stale identity",unlock:false},transferId:"1:old",againId:"1:new",
    againOutcome:{status:"completed"},final:pair(),originalHistory:{status:"completed"}};
}
function snapshot() {
  return {schemaVersion:1,case:"snapshot-recovery",cleanup:{success:true},before:copy(),outcome:{status:"completed"},
    browser:{dialog:true,errors:[]},rollback:{source:{present:false},destination:{present:false}},
    transferId:"1:old",originalHistory:{status:"completed"},recovery:{success:true,operationId:"restore:new"},
    duplicate:{operationId:"restore:new"},recoveryOutcome:{status:"completed"},recovered:pair(),final:pair(),finalHistory:{status:"completed"}};
}
test("policy oracle distinguishes intentional restored copies from protected copies",()=>{
  for(const accepted of [true,false]) assert.equal(analyze(policy(accepted)).verdict,"PASS");
});
test("policy oracle rejects missing warnings, changed cargo, stale identities and delayed authority",()=>{
  for(const mutate of [r=>r.browser.warnings=false,r=>r.browser.restartRequired=false,
    r=>r.restored.source.cargo.entities.pop(),r=>r.restored.destination.cargo.entities.pop(),
    r=>r.identityAfter.uid=r.identityBefore.uid,r=>r.acceptedRestart.identity.uid="wrong",
    r=>r.delayed.unlock=true,r=>r.delayed.deletion="OK",r=>r.againId=r.transferId,
    r=>r.unrelatedRestored.usable=false,r=>r.final.destination.cargo.entities.pop(),r=>r.cleanup.success=false]) {
    const report=policy();mutate(report);assert.throws(()=>analyze(report));
  }
  const protectedReport=policy(false);protectedReport.restored.source.usable=true;
  assert.throws(()=>analyze(protectedReport));
});
test("snapshot recovery requires original failure and separately validated recovery evidence",()=>{
  assert.equal(analyze(snapshot()).verdict,"PASS");
  for(const mutate of [r=>r.rollback.destination.present=true,r=>r.originalHistory.status="recovered",
    r=>r.recovery.operationId=r.transferId,r=>r.duplicate.operationId="other",r=>r.recoveryOutcome.status="failed",
    r=>r.recovered.destination.cargo.entities.pop(),r=>r.final.destination.usable=false,
    r=>delete r.browser,r=>r.finalHistory.status="failed"]) {
    const report=snapshot();mutate(report);assert.throws(()=>analyze(report));
  }
});

test("offline recovery evidence cannot claim an absent copy or an available destination",()=>{
  const report=snapshot();report.snapshotRecoveryVersion=2;
  report.offlineBrowser={offlineUnverified:true,offlineDestinationDisabled:true,errors:[]};report.onlineAgain=pair();
  assert.equal(analyze(report).verdict,"PASS");
  for(const mutate of [r=>r.offlineBrowser.offlineUnverified=false,r=>r.offlineBrowser.offlineDestinationDisabled=false,
    r=>r.onlineAgain.destination.cargo.entities.pop()]) {
    const changed=structuredClone(report);mutate(changed);assert.throws(()=>analyze(changed));
  }
});


test("ownership review acceptance rejects missing unlock, replay and browser proof",()=>{
  const restored=policy();Object.assign(restored,{ownershipReviewVersion:1,manualLocked:{source:{...copy(),usable:false}},
    manualUnlocked:{source:copy()},standalone:{physical:{source:copy()}}});
  restored.browser.acknowledgementPersisted=true;
  assert.equal(analyze(restored).verdict,"PASS");
  for(const mutate of [r=>r.manualUnlocked.source.usable=false,r=>r.standalone.physical.source.cargo.entities.pop(),
    r=>r.browser.acknowledgementPersisted=false,r=>delete r.manualLocked]) {
    const changed=structuredClone(restored);mutate(changed);assert.throws(()=>analyze(changed));
  }
  const recovered=snapshot();Object.assign(recovered,{ownershipReviewVersion:1,
    afterReplay:{source:{present:false},destination:{present:false}},survivor:copy()});
  Object.assign(recovered.browser,{noSnapshotDownload:true,
    restoreFailures:{preAdmissionRetryEnabled:true,uncertainResubmissionDisabled:true}});
  assert.equal(analyze(recovered).verdict,"PASS");
  for(const mutate of [r=>r.afterReplay.source.present=true,r=>r.afterReplay.destination.present=true,
    r=>r.survivor.cargo.entities.pop(),r=>r.browser.noSnapshotDownload=false,
    r=>r.browser.restoreFailures.preAdmissionRetryEnabled=false,r=>r.browser.restoreFailures.uncertainResubmissionDisabled=false]) {
    const changed=structuredClone(recovered);mutate(changed);assert.throws(()=>analyze(changed));
  }
});


test("lost export reply oracle requires source cleanup and no initial destination import",()=>{
  const report={schemaVersion:1,case:"lost-export-reply",cleanup:{success:true},before:copy(),
    held:{action:"export",success:true},outcome:{status:"failed"},resolved:{source:copy(),destination:{present:false}},
    eventsBeforeRetry:[],transferId:"request:old",retryId:"1:new",retryOutcome:{status:"completed"},final:pair()};
  assert.equal(analyze(report).verdict,"PASS");
  for(const mutate of [r=>r.resolved.source.usable=false,r=>r.resolved.destination.present=true,
    r=>r.eventsBeforeRetry.push({kind:"call",action:"import"}),r=>r.retryId=r.transferId,
    r=>r.final.destination.cargo.entities.pop(),r=>r.cleanup.success=false]) {
    const changed=structuredClone(report);mutate(changed);assert.throws(()=>analyze(changed));
  }
});


test("native accepted-copy unlock failures stay failed and the corrected run passes",()=>{
  const read=name=>JSON.parse(gunzipSync(readFileSync(new URL(`./evidence/${name}-2.1.17.json.gz`,import.meta.url))));
  for(const name of ["save-policy-unlock-before","save-policy-unlock-require"]) {
    const report=read(name);assert.equal(report.manualUnlocked.source.usable,false);
    assert.equal(report.cleanup.success,true);assert.throws(()=>analyze(report));
  }
  const report=read("save-policy-unlock-fixed");assert.equal(analyze(report).verdict,"PASS");
  report.manualUnlocked.source.usable=false;assert.throws(()=>analyze(report));
});
