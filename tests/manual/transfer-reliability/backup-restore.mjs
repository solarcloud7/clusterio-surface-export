import assert from "node:assert/strict";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT, sleep } from "./docker-lab.mjs";
import { start, summary, sample, terminal } from "./cases.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { VOLUME_SUFFIXES } from "./backup-storage.mjs";

const LABEL = "surface-export.manual-run";
export function assertQuiesced(lab) {
  for (const name of [lab.controller, ...Object.values(lab.hosts).map(h => h.container)]) {
    lab.assertOwned("container", name);
    const [info] = JSON.parse(lab.docker(["container", "inspect", name]));
    assert.equal(info.State.Running, false, "storage requires every service stopped");
  }
}
export function volumeAction(lab, action, suffix, expected) {
  assert.ok(VOLUME_SUFFIXES.includes(suffix), "unknown backup volume");
  assertQuiesced(lab);
  const data = `${lab.run}-${suffix}`, backup = `${lab.run}-backup`;
  lab.assertOwned("volume", data); lab.assertOwned("volume", backup);
  const name = `${lab.run}-${action}-${suffix}`;
  const mode = action === "backup" ? ":ro" : "";
  const backupMode = action === "backup" ? "" : ":ro";
  lab.containers.push(name);
  return JSON.parse(lab.docker(["run", "--name", name, "--label", `${LABEL}=${lab.run}`, "--network", "none",
    "--user", "0", "--entrypoint", "node", "-e", `SE_MANUAL_RUN=${lab.run}`,
    "-v", `${data}:/data${mode}`, "-v", `${backup}:/backup${backupMode}`,
    "-v", `${join(ROOT, "tests/manual/transfer-reliability/backup-storage.mjs")}:/backup-storage.mjs:ro`,
    lab.image, "/backup-storage.mjs", action, suffix, ...(expected ? [expected] : [])], {timeout: 60_000}));
}

// Observe only the relevant persisted authority; no tokens or unrelated data are printed.
function diskAuthority(lab, pendingId, completedId) {
  return JSON.parse(lab.docker(["exec", lab.controller, "node", "-e", `
    const fs=require('fs'),path=require('path'),crypto=require('crypto');
    const found={};let visited=0;
    const wanted=['surface_export_pending_transfers.json','surface_export_transaction_audit.jsonl'];
    function walk(root,depth){if(++visited>1000)throw Error('bounded search exceeded');
      for(const e of fs.readdirSync(root,{withFileTypes:true})){
        const p=path.join(root,e.name);
        if(e.isDirectory()&&depth<4)walk(p,depth+1);
        if(e.isFile()&&wanted.includes(e.name)){
          if(found[e.name])throw Error('ambiguous authority file');
          if(fs.statSync(p).size>16777216)throw Error('authority file too large');
          const raw=fs.readFileSync(p,'utf8');
          found[e.name]={sha256:crypto.createHash('sha256').update(raw).digest('hex'),
            pending:e.name===wanted[0]?JSON.parse(raw).filter(r=>r.transferId===process.argv[1]).length:undefined,
            completedRows:e.name===wanted[1]?raw.split('\\n').filter(r=>r.includes(process.argv[2])).length:undefined};
        }
      }}walk('/clusterio/data',0);console.log(JSON.stringify(found));`, pendingId, completedId]));
}

export async function backupRestoreCase(lab, report, save, {failAfterBackup = false} = {}) {
  report.history = {name: `transfer-cleanup-${lab.run}-history`};
  const h = report.history;
  h.before = lab.probe(1, "build", h.name).state;
  assert.deepEqual(h.before.cargo, expectedCargo);
  h.transferId = start(lab, h.name);
  h.outcome = await terminal(lab, h.transferId);
  assert.equal(h.outcome.status, "completed", "history fixture must complete");
  h.samples = [sample(lab, h.name)];
  report.name = `transfer-cleanup-${lab.run}-pending`;
  report.before = lab.probe(1, "build", report.name).state;
  assert.deepEqual(report.before.cargo, expectedCargo);
  lab.writeFault(1, {run: lab.run, enabled: true, name: report.name, action: "source"});
  report.transferId = start(lab, report.name); save();
  report.held = await lab.until(() => lab.events(1).find(e => e.kind === "response-held" && e.name === report.name), "successful deletion reply held", 120);
  report.samples = [sample(lab, report.name)];
  assert.equal(report.samples[0].source.present, false);
  assert.equal(report.samples[0].destination.held, true);
  // Consumed hook remains pending; after restart the real receipt path can reply.
  lab.writeFault(1, {run: lab.run, enabled: false});
  const backupStart = performance.now();
  report.backup = {startedAt: new Date().toISOString(), archives: [], erased: [], restored: []}; save();
  report.checkpoint = await lab.checkpoint("manual-coordinated-backup");
  for (const host of [1, 2]) lab.ctl("instance", "stop", lab.hosts[host].instance);
  report.authority = diskAuthority(lab, report.transferId, h.transferId);
  assert.equal(report.authority["surface_export_pending_transfers.json"]?.pending, 1, "uncertain handoff missing from backup boundary");
  assert.ok(report.authority["surface_export_transaction_audit.jsonl"]?.completedRows > 0, "completed audit missing");
  for (const host of [1, 2]) lab.mutateContainer("stop", lab.hosts[host].container, ["--time", "10"]);
  lab.mutateContainer("stop", lab.controller, ["--time", "10"]);
  assertQuiesced(lab);
  assert.deepEqual([...lab.volumes].sort(), VOLUME_SUFFIXES.map(s => `${lab.run}-${s}`).sort(), "capture must include every lab volume");
  const backup = `${lab.run}-backup`;
  lab.docker(["volume", "create", "--label", `${LABEL}=${lab.run}`, backup]); lab.volumes.push(backup);
  for (const suffix of VOLUME_SUFFIXES) {report.backup.archives.push(volumeAction(lab, "backup", suffix)); save();}
  report.backup.elapsedMs = performance.now() - backupStart; save();
  if (failAfterBackup) throw new Error("Intentional failure after archive creation; verify backup resource cleanup");
  const restoreStart = performance.now();
  report.backup.restoreStartedAt = new Date().toISOString();
  for (const archive of report.backup.archives) {report.backup.erased.push(volumeAction(lab, "erase", archive.suffix, archive.sha256)); save();}
  for (const archive of report.backup.archives) {report.backup.restored.push(volumeAction(lab, "restore", archive.suffix, archive.sha256)); save();}
  lab.mutateContainer("start", lab.controller);
  await lab.until(() => lab.docker(["exec", lab.controller, "curl", "-sf", "http://localhost:8080/"]).length > 0, "restored controller", 120);
  report.restoredAuthority = diskAuthority(lab, report.transferId, h.transferId); save();
  for (const host of [1, 2]) lab.mutateContainer("start", lab.hosts[host].container);
  await lab.ready();
  report.samples.push(sample(lab, report.name)); save();
  report.outcome = await terminal(lab, report.transferId);
  report.samples.push(sample(lab, report.name)); await sleep(500); report.samples.push(sample(lab, report.name));
  h.restoredOutcome = summary(lab, h.transferId); h.samples.push(sample(lab, h.name));
  report.events = {1: lab.events(1), 2: lab.events(2)};
  report.backup.restoreElapsedMs = performance.now() - restoreStart; save();
}
