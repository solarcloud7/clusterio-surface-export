import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { VOLUME_SUFFIXES } from "./backup-storage.mjs";

export function performanceCargo(extra) {
  assert.ok(extra===0 || extra===512,"fixed fixture size required");
  const cargo=structuredClone(expectedCargo);
  for(let n=0;n<extra;n++) {
    const key=`steel-chest@${16+(n%32)*2+.5},${Math.floor(n/32)*2+.5}`;
    cargo.entities.push(key);cargo.inventories[`${key}:1`]={"iron-plate/rare":170,"copper-plate/normal":230};
  }
  cargo.entities.sort();return cargo;
}

export function evaluateCopies(before, samples, minimumSamples=2) {
  assert.ok(before?.present && before.usable, "missing initial usable source");
  assert.ok(samples.length>=minimumSamples,"required physical observations missing");
  const violations=new Set();
  for(const sample of samples) {
    let present=0,usable=0;
    for(const key of ["source","destination"]) {
      const s=sample[key];
      assert.equal(typeof s?.present,"boolean","missing observation is not absence");
      assert.ok(Number.isInteger(s.tick),"missing local tick");
      if(!s.present) continue;
      present++;
      for(const v of [s.platformHidden,s.surfaceHidden,s.locked,s.held,s.canary?.active,s.canary?.disabled])
        assert.equal(typeof v,"boolean","missing physical usability evidence");
      const isUsable=!s.platformHidden&&!s.surfaceHidden&&!s.locked&&!s.held&&s.canary.active&&!s.canary.disabled;
      assert.equal(s.usable,isUsable,"derived usability mismatch");
      if(isUsable) usable++;
      if(!isDeepStrictEqual(s.cargo,before.cargo)) violations.add("physical cargo changed");
    }
    if(!present) violations.add("no recoverable copy");
    if(usable>1) violations.add("two usable copies");
  }
  return {verdict:violations.size?"STOP":"PASS",violations:[...violations]};
}
export function analyze(report) {
  assert.equal(report.schemaVersion,1);
  assert.ok(!report.error,"report contains a harness failure");
  if(report.case==="save-policy-pending") {
    assert.equal(report.cleanup?.success,true);assert.deepEqual(report.before?.cargo,expectedCargo);
    assert.equal(report.beforeReload?.source.present,false);assert.equal(report.beforeReload?.destination.held,true);
    assert.equal(report.held?.id,report.transferId.slice(report.transferId.indexOf(":")+1));
    assert.equal(report.held.success,true);assert.equal(report.notices?.mode,"save_game");assert.equal(report.notices.allow,false);
    assert.equal(report.protected?.source.usable,false);assert.equal(report.identityBefore.uid,report.identityAfter.uid);
    assert.deepEqual(report.protected.source.cargo,expectedCargo);assert.deepEqual(report.protected.destination.cargo,expectedCargo);
    assert.equal(report.outcome?.status,"completed");assert.equal(report.final?.source.present,false);
    assert.equal(report.final?.destination.usable,true);assert.deepEqual(report.final.destination.cargo,expectedCargo);
    assert.equal(report.events?.[2]?.filter(event=>event.kind==="call"&&event.action==="import"&&event.id===report.transferId).length,1);
    return {verdict:"PASS",reason:"Save game mode retained pending ownership; normal recovery preserved cargo"};
  }
  if(["save-policy-game","save-policy-history","snapshot-recovery"].includes(report.case)) return analyzeSavePolicy(report);
  assert.ok(["coordinated-restore","performance","lost-source-reply","lost-destination-reply","aged-recovery-intent","crash-source-before-save","restore-old-source","restore-old-destination"].includes(report.case),"unknown acceptance case");
  assert.equal(report.cleanup?.success,true,"Docker cleanup unproven");
  if(report.case==="coordinated-restore") return analyzeBackup(report);
  if(report.case==="restore-old-destination") return analyzeDestinationRollback(report);
  if(report.case==="performance") {
    for(const m of report.measurements||[]) {
      assert.deepEqual(m.before?.cargo,performanceCargo(m.extraEntities),"invalid performance fixture");
      if(m.after) {
        const result=evaluateCopies(m.before,[m.after],1);
        if(result.verdict==="STOP") return result;
        if(m.outcome?.status!=="completed"||m.after.source.present||!m.after.destination.usable)
          return {verdict:"STOP",violations:["performance transfer did not complete with one usable destination"]};
      }
    }
    assert.equal(report.measurements?.length,18,"complete 2-size x 3-mode x 3-repeat matrix required");
    const identities=new Set();
    for(const m of report.measurements) {
      assert.ok([0,1,2].includes(m.repeat)&&["off","normal","debug"].includes(m.mode));
      identities.add(`${m.repeat}/${m.extraEntities}/${m.mode}`);
      assert.deepEqual(m.before.cargo,performanceCargo(m.extraEntities));
      assert.deepEqual(m.after.destination.cargo,m.before.cargo,"physical performance cargo mismatch");
      assert.equal(m.after.source.present,false);assert.equal(m.after.destination.usable,true);
      assert.equal(m.outcome.status,"completed");assert.equal(m.truncated,false);
      for(const host of [1,2]) {
        assert.ok(m.records.some(r=>r.host===host&&r.boundary==="scheduler"),"missing scheduler measurement");
        assert.ok(m.records.some(r=>r.host===host&&r.boundary===(host===1?"export_setup":"import_setup")),"missing setup measurement");
      }
      for(const r of m.records) {
        assert.ok(Number.isFinite(r.ms)&&r.ms>=0&&typeof r.raw==="string","missing measured profiler reading");
        const reading=/^\s*(?:Duration:\s*)?(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(ms|s|us|µs|ns)\s*$/i.exec(r.raw);
        assert.ok(reading,"invalid raw profiler units");
        assert.equal(r.ms,Number(reading[1])*({ms:1,s:1000,us:.001,"µs":.001,ns:.000001}[reading[2].toLowerCase()]),"raw profiler value disagrees with milliseconds");
        assert.ok(Number.isInteger(r.startTick)&&r.startTick===r.endTick,"callback crossed ticks");
        assert.equal(r.success,true);
      }
    }
    assert.equal(identities.size,18,"duplicate performance sample");
    return {verdict:"PASS",reason:"Measurement matrix and physical parity verified; no frame-budget claim"};
  }
  assert.deepEqual(report.before.cargo,expectedCargo,"fixture must match independent literal contract");
  if(report.case!=="restore-old-source") {
    assert.equal(report.held?.success,true,"real action was not accepted before withholding reply");
    assert.ok(report.held.id.includes(report.name),"fault identity mismatch");
  }
  const imports=report.events[2].filter(e=>e.kind==="call"&&e.action==="import"&&e.id===report.transferId);
  assert.equal(imports.length,1,"must observe exactly one production import request");
  const result=evaluateCopies(report.before,report.samples);
  if(result.verdict==="STOP") return result;
  const crashLiveness=report.case==="crash-source-before-save"&&report.contract?.schemaVersion>=2;
  if(crashLiveness) {
    const last=report.samples.at(-1);
    if(report.outcome?.status!=="completed"||last.source.present||!last.destination.usable)
      return {verdict:"STOP",violations:["source crash recovery did not complete with one usable destination"]};
    assert.ok(report.events[1].filter(e=>e.kind==="call"&&e.action==="source"&&e.id.includes(report.name)).length>=2,
      "source crash recovery did not retry the real deletion");
  }
  if(report.case==="aged-recovery-intent") {
    assert.equal(report.agedIntent?.transferId,report.transferId,"wrong aged recovery intent");
    assert.equal(report.agedIntent.changedField,"startedAt");
    assert.equal(report.agedIntent.observedAt-report.agedIntent.after,24*60*60*1000,"one-day age injection required");
  }
  if(report.case.startsWith("lost-")||report.case==="aged-recovery-intent") {
    const last=report.samples.at(-1);
    assert.ok(report.outcome?.status,"recovery outcome unavailable");
    if(report.outcome.status!=="completed") return {...result,verdict:"STOP",violations:["recovery did not complete within the observation window"]};
    assert.equal(last.source.present,false); assert.equal(last.destination.usable,true);
    const action=report.case==="lost-destination-reply"?"destination":"source";
    const host=action==="source"?1:2;
    assert.ok(report.events[host].filter(e=>e.kind==="call"&&e.action===action&&e.id.includes(report.name)
      &&(action!=="destination"||e.gate==="go_live")).length>=2,"real recovery retry not observed");
  }
  return {...result,reason:crashLiveness ? "Source crash recovered with exact cargo and one usable destination"
    : report.case==="crash-source-before-save"
    ? "Sampled safety invariant preserved; inspect outcome separately for recovery liveness"
    : report.case==="restore-old-source" ? "Sampled safety invariant survived older source restore"
      : "Lost reply recovered with exact cargo and one usable destination"};
}

export function analyzeSavePolicy(report) {
  assert.equal(report.cleanup?.success,true,"Docker cleanup unproven");
  assert.equal(report.browser?.dialog,true,"snapshot dialog unverified");
  assert.deepEqual(report.browser?.errors,[],"browser errors or missing evidence");
  assert.deepEqual(report.before?.cargo,expectedCargo,"invalid physical fixture");
  assert.equal(report.outcome?.status,"completed");
  if(report.case==="snapshot-recovery") {
    assert.equal(report.rollback?.source.present,false);assert.equal(report.rollback?.destination.present,false);
    assert.equal(report.originalHistory?.status,"completed");
    assert.equal(report.recovery?.success,true);
    assert.notEqual(report.recovery.operationId,report.transferId);
    assert.equal(report.duplicate?.operationId,report.recovery.operationId);
    assert.equal(report.recoveryOutcome?.status,"completed");
    assert.equal(report.recovered?.source.present,false);assert.equal(report.recovered?.destination.usable,true);
    assert.deepEqual(report.recovered.destination.cargo,expectedCargo);
    assert.deepEqual(report.final?.destination.cargo,expectedCargo);assert.equal(report.final?.destination.usable,true);
    assert.equal(report.finalHistory?.status,"completed");
    if(report.snapshotRecoveryVersion>=2) {
      assert.equal(report.offlineBrowser?.offlineUnverified,true);
      assert.equal(report.offlineBrowser.offlineDestinationDisabled,true);
      assert.deepEqual(report.offlineBrowser.errors,[]);
      assert.deepEqual(report.onlineAgain?.destination.cargo,expectedCargo);
      assert.equal(report.onlineAgain.destination.usable,true);
    }
    return {verdict:"PASS",reason:"Manual snapshot import restored physical cargo; original rollback remains a separately observed failure"};
  }
  assert.deepEqual(report.restored?.source.cargo,expectedCargo);assert.deepEqual(report.restored?.destination.cargo,expectedCargo);
  assert.deepEqual(report.unrelatedRestored?.cargo,expectedCargo);assert.equal(report.unrelatedRestored?.usable,true);
  assert.equal(report.restored.destination.usable,true);
  const accepted=report.case==="save-policy-game";
  assert.equal(report.browser.warnings,true,"restored-source warning unverified");
  assert.equal(report.restored.source.usable,accepted);
  assert.equal(report.notices?.mode,accepted?"save_game":"plugin_history");
  assert.equal(report.notices?.notices[report.identityAfter?.index]?.status,accepted?"accepted":"protected");
  if(accepted) {
    assert.equal(report.browser.restartRequired,true,"restart requirement unverified");
    assert.notEqual(report.identityAfter.uid,report.identityBefore.uid);
    assert.equal(report.beforeRestartMode,"save_game");
    assert.equal(report.acceptedRestart?.identity.uid,report.identityAfter.uid);
    assert.equal(report.acceptedRestart?.sample.source.usable,true);
    assert.match(report.delayed?.deletion,/^ERROR:/);assert.equal(report.delayed?.unlock,false);
    assert.notEqual(report.againId,report.transferId);assert.equal(report.againOutcome?.status,"completed");
    assert.equal(report.final?.source.present,false);assert.equal(report.final?.destination.usable,true);
    assert.deepEqual(report.final.destination.cargo,expectedCargo);assert.equal(report.originalHistory?.status,"completed");
  } else assert.equal(report.identityAfter.uid,report.identityBefore.uid);
  return {verdict:"PASS",reason:"Checkpoint cargo and configured restoration policy verified"};
}
export function destinationRollbackBounds(contract) {
  assert.equal(contract?.schemaVersion,4,"destination rollback contract missing");
  const matches=contract.cases?.filter(c=>c.id==="restore-old-destination");
  assert.equal(matches?.length,1,"destination rollback bounds missing or duplicated");
  const bounds=matches[0];
  assert.ok([bounds.observationMs,bounds.intervalMs,bounds.maximumSamples]
    .every(value=>Number.isSafeInteger(value)&&value>0)
    && bounds.intervalMs<=bounds.observationMs
    && bounds.maximumSamples>=Math.ceil(bounds.observationMs/bounds.intervalMs)+1,
  "invalid destination rollback bounds");
  return bounds;
}

export function analyzeDestinationRollback(report) {
  const bounds=destinationRollbackBounds(report.contract);
  assert.deepEqual(report.before?.cargo,expectedCargo,"invalid destination rollback fixture");
  assert.equal(evaluateCopies(report.before,[report.initial],1).verdict,"PASS","initial physical observation changed");
  assert.equal(report.initial.source.usable,true,"initial source not usable");
  assert.equal(report.initial.destination?.present,false,"old checkpoint must precede destination creation");
  for(const [generation,key] of [["before","before"],["after","after"]]) {
    const checkpoint=report.checkpoints?.[key];
    assert.equal(checkpoint?.host,2,"destination checkpoint required");
    assert.equal(checkpoint.name,`manual-destination-${generation}`,"wrong checkpoint name");
    assert.match(checkpoint.sha256,/^[a-f0-9]{64}$/,"checkpoint digest missing");
    assert.deepEqual(checkpoint.marker,{run:report.run,generation},"checkpoint generation identity mismatch");
  }
  assert.notEqual(report.checkpoints.before.sha256,report.checkpoints.after.sha256,"distinct save generations required");
  assert.deepEqual(report.control?.load,report.checkpoints.after,"control did not load the completed checkpoint");
  assert.equal(report.control.reconciliationReady,true,"control startup reconciliation unavailable");
  assert.deepEqual(report.rollback?.load,report.checkpoints.before,"rollback did not load the earlier checkpoint");
  for(const [snapshot,outcome] of [[report.transferred,report.outcome],[report.control.sample,report.control.outcome]]) {
    assert.equal(evaluateCopies(report.before,[snapshot],1).verdict,"PASS","physical control failed");
    assert.equal(snapshot.source.present,false,"control source not deleted");
    assert.equal(snapshot.destination.usable,true,"control destination not usable");
    assert.equal(outcome?.transferId,report.transferId,"control operation identity mismatch");
    assert.equal(outcome.status,"completed","control transfer incomplete");
  }
  const samples=report.rollback.samples;
  assert.ok(Array.isArray(samples)&&samples.length>=2&&samples.length<=bounds.maximumSamples,"bounded rollback observations required");
  let previous=-1;
  for(const s of samples) {
    assert.ok(Number.isFinite(s.offsetMs)&&s.offsetMs>=0&&s.offsetMs>previous,"invalid observation clock");
    previous=s.offsetMs;
    assert.equal(s.outcome?.transferId,report.transferId,"observed history missing or for another operation");
    assert.equal(typeof s.outcome.status,"string","history outcome unavailable");
  }
  assert.ok(previous>=bounds.observationMs,"full recovery observation window required");
  assert.ok(Number.isFinite(report.rollback.observedMs)&&report.rollback.observedMs>=previous,"observation duration missing");
  assert.ok(Array.isArray(report.events?.[1])&&Array.isArray(report.events?.[2]),"request observations unavailable");
  const imports=report.events[2].filter(e=>e.kind==="call"&&e.action==="import"&&e.id===report.transferId);
  assert.ok(imports.length>0,"production import was not observed");
  const physical=evaluateCopies(report.before,samples);
  const violations=physical.violations.map(v=>v==="no recoverable copy"?"no physical platform copy in either running world":v);
  if(imports.length!==1) violations.push("more than one import request for the canonical transfer");
  const last=samples.at(-1);
  if(last.source.present||!last.destination.usable) violations.push("normal recovery did not leave one usable destination within the observation window");
  return {verdict:violations.length?"STOP":"PASS",violations,
    observation:{missingPhysicalCopy:samples.some(s=>!s.source.present&&!s.destination.present),
      finalSourcePresent:last.source.present,finalDestinationPresent:last.destination.present,
      finalDestinationUsable:last.destination.usable===true,
      finalHistoryStatus:last.outcome.status,importRequests:imports.length,observationMs:report.rollback.observedMs},
    reason:"Physical world observations and historical operation status are separate; backup and cached-payload recovery was not attempted"};
}

export function analyzeBackup(report) {
  const b=report.backup;
  for(const phase of ["archives","erased","restored"]) {
    assert.deepEqual(b?.[phase]?.map(r=>r.suffix).sort(),[...VOLUME_SUFFIXES].sort(),"complete unique volume set required");
  }
  for(const archive of b.archives) {
    assert.match(archive.sha256,/^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(archive.bytes)&&archive.bytes>0&&archive.bytes<=2*1024**3);
    assert.equal(archive.compared,true,"backup must match stopped data");
    const erased=b.erased.find(r=>r.suffix===archive.suffix),restored=b.restored.find(r=>r.suffix===archive.suffix);
    assert.equal(erased.empty,true,"data loss not exercised");
    assert.ok(Number.isInteger(erased.erasedEntries)&&erased.erasedEntries>=0);
    if(["controller-data","host-1-data","host-2-data","tokens"].includes(archive.suffix))
      assert.ok(erased.erasedEntries>0,"critical volume was empty before loss");
    assert.equal(restored.sha256,archive.sha256,"restore used another backup generation");
    assert.equal(restored.compared,true,"restored bytes not compared");
  }
  for(const key of ["elapsedMs","restoreElapsedMs"]) assert.ok(Number.isFinite(b[key])&&b[key]>0,"missing measured duration");
  for(const host of [1,2]) assert.match(report.checkpoint?.[host]||"",/^[a-f0-9]{64}$/,"checkpoint hash missing");
  for(const evidence of [report.authority,report.restoredAuthority]) {
    assert.equal(evidence?.["surface_export_pending_transfers.json"]?.pending,1,"pending intent not retained");
    assert.ok(evidence?.["surface_export_transaction_audit.jsonl"]?.completedRows>0,"historical audit missing");
  }
  assert.deepEqual(report.before?.cargo,expectedCargo,"invalid pending fixture");
  assert.deepEqual(report.history?.before?.cargo,expectedCargo,"invalid history fixture");
  assert.equal(report.held?.success,true);assert.ok(report.held.id.includes(report.name),"wrong withheld reply");
  assert.equal(report.samples?.[0]?.source.present,false,"deletion not observed before backup");
  assert.equal(report.samples?.[0]?.destination.held,true,"uncertain destination not held");
  const pending=evaluateCopies(report.before,report.samples);
  const history=evaluateCopies(report.history.before,report.history.samples);
  const violations=[...pending.violations,...history.violations];
  for(const operation of [{transferId:report.transferId,samples:report.samples,outcome:report.outcome},
    {transferId:report.history.transferId,samples:report.history.samples,outcome:report.history.restoredOutcome}]) {
    const last=operation.samples.at(-1);
    if(operation.outcome?.status!=="completed"||operation.outcome.transferId!==operation.transferId||last.source.present||!last.destination.usable)
      violations.push("restored operation did not retain one usable destination and completed history");
    if(report.events?.[2]?.filter(e=>e.kind==="call"&&e.action==="import"&&e.id===operation.transferId).length!==1)
      violations.push("restored operation did not retain exactly one import request");
  }
  assert.ok(report.events?.[1]?.filter(e=>e.kind==="call"&&e.action==="source"&&e.id.includes(report.name)).length>=2,"normal recovery retry missing");
  return {verdict:violations.length?"STOP":"PASS",violations:[...new Set(violations)],
    reason:"Quiesced volume restore: exact sampled cargo, normal recovery, one import and retained history"};
}
