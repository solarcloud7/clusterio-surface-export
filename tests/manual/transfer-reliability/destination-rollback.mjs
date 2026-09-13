import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { sleep } from "./docker-lab.mjs";
import { sample, start, summary, terminal } from "./cases.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { destinationRollbackBounds } from "./oracle.mjs";

export const contract = { requires: ["owned disposable Docker lab", "Factorio 2.1.17"],
  produces: ["latest-save control", "destination-only rollback observations", "checkpoint hashes and generation markers"],
  "does not": ["restore source or controller", "repair lost cargo", "prove off-host backup availability"] };
const markerKey="surface_export_manual_checkpoint";
const marker=(lab)=>lab.lua(2,`return {success=true,marker=storage.${markerKey}}`).result.marker;

async function checkpoint(lab,generation) {
  const name=`manual-destination-${generation}`, value={run:lab.run,generation};
  lab.lua(2,`storage.${markerKey}={run=${JSON.stringify(lab.run)},generation=${JSON.stringify(generation)}};return {success=true}`);
  assert.deepEqual(marker(lab),value,"checkpoint marker write failed");
  const hashes=await lab.checkpoint(name,[2]);
  return {host:2,name,sha256:hashes[2],marker:value};
}

export async function loadDestinationCheckpoint(lab,checkpoint) {
  assert.equal(checkpoint.host,2,"only destination may be restored");
  lab.assertOwned("container",lab.hosts[2].container);
  const sha256=lab.checkpointHash(2,checkpoint.name);
  assert.equal(sha256,checkpoint.sha256,"checkpoint changed before loading");
  await lab.load(2,checkpoint.name);
  const loadedMarker=marker(lab);
  assert.deepEqual(loadedMarker,checkpoint.marker,"wrong checkpoint generation loaded");
  return {host:2,name:checkpoint.name,sha256,marker:loadedMarker};
}

export function assertCompletedControl(report,snapshot,outcome) {
  assert.equal(outcome?.transferId,report.transferId,"control operation identity mismatch");
  assert.equal(outcome.status,"completed","control transfer did not complete");
  assert.equal(snapshot.source.present,false,"control source was not deleted");
  assert.equal(snapshot.destination.usable,true,"control destination is not usable");
  assert.deepEqual(snapshot.destination.cargo,expectedCargo,"control physical cargo mismatch");
}

export async function destinationRollbackCase(lab,report,save,{failAfterControl=false,now=()=>performance.now(),delay=sleep}={}) {
  const bounds=destinationRollbackBounds(report.contract);
  report.name=`transfer-cleanup-${lab.run}-restore-old-destination`;
  report.mutationOccurred=true;
  report.before=lab.probe(1,"build",report.name).state;
  assert.deepEqual(report.before.cargo,expectedCargo,"physical fixture differs from literal contract");
  report.initial=sample(lab,report.name);
  assert.equal(report.initial.destination.present,false,"destination fixture already exists");
  report.checkpoints={before:await checkpoint(lab,"before")};save();
  report.transferId=start(lab,report.name);save();
  report.outcome=await terminal(lab,report.transferId);
  report.transferred=sample(lab,report.name);save();
  assertCompletedControl(report,report.transferred,report.outcome);
  report.checkpoints.after=await checkpoint(lab,"after");save();
  report.control={load:await loadDestinationCheckpoint(lab,report.checkpoints.after)};
  report.control.reconciliationReady=await lab.until(()=>lab.lua(2,
    "return {success=true,ready=storage.source_recovery_ready==true}").result.ready,"control startup reconciliation",60);
  report.control.sample=sample(lab,report.name);
  report.control.outcome=summary(lab,report.transferId);save();
  assertCompletedControl(report,report.control.sample,report.control.outcome);
  console.log("Latest destination save control: exact cargo and completed history retained");
  if(failAfterControl) throw new Error("Intentional harness failure after destination control reload; verify cleanup.success");
  report.rollback={load:await loadDestinationCheckpoint(lab,report.checkpoints.before),samples:[]};save();
  const started=now();
  const observe=()=>{
    const physical=sample(lab,report.name),outcome=summary(lab,report.transferId);
    report.rollback.samples.push({...physical,outcome,offsetMs:now()-started});save();
  };
  observe();
  while(report.rollback.samples.at(-1).offsetMs<bounds.observationMs) {
    assert.ok(report.rollback.samples.length<bounds.maximumSamples,"observation sample limit exceeded");
    await delay(Math.min(bounds.intervalMs,bounds.observationMs-report.rollback.samples.at(-1).offsetMs));
    observe();
  }
  report.rollback.observedMs=now()-started;
  report.events={1:lab.events(1),2:lab.events(2)};
  report.notTested=["Restoration from the retained post-transfer checkpoint", "Cached payload recovery", "Off-host backups", "Missing or mixed external journals"];
  save();
}
