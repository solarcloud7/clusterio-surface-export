import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ROOT } from "../transfer-reliability/docker-lab.mjs";
import { PRODUCTION_VOLUME_SUFFIXES } from "../transfer-reliability/backup-storage.mjs";
import { sample, start, summary, terminal } from "../transfer-reliability/cases.mjs";
import { expectedCargo } from "../../integration/transfer-cleanup/oracle.mjs";
import { readConfigList } from "../../../tools/tests/clusterio-cli.mjs";

export const contract = { requires: ["owned disposable production profile", "resolved Compose volume list", "quiesced services"],
  produces: ["all-volume archives", "fresh-volume restore", "physical cargo and authenticated browser checks"],
  "does not": ["erase original deployment volumes", "backup the development cluster", "prove historical upgrades"] };
const label = "surface-export.manual-run";
const digest = value => createHash("sha256").update(value).digest("hex");
function settingsBrowser(lab) {
  const output=execFileSync(process.execPath,[join(ROOT,"tests/integration/settings/run-tests.mjs")],{
    cwd:ROOT,env:{...process.env,SE_WEB_URL:lab.url,SE_SETTINGS_URL:lab.url,SE_SETTINGS_CONTROLLER:lab.controller},
    encoding:"utf8",timeout:90000,maxBuffer:1024*1024,
  });
  assert.match(output,/PASS: grouped settings/);
  return {success:true,output:output.trim()};
}

export function restoreConfiguration(config, run) {
  assert.match(run, /^se-manual-[a-z0-9-]{8,60}$/);
  assert.deepEqual(Object.keys(config.volumes).sort(), [...PRODUCTION_VOLUME_SUFFIXES].sort(), "resolved deployment has an unhandled volume");
  const next=structuredClone(config);
  next.name=`${run}-restored`;
  for(const [key,value] of Object.entries(next.volumes)) {
    value.name=`${run}-restored-${key}`;delete value.external;
    value.labels={[label]:run};
  }
  for(const [key,service] of Object.entries(next.services)) service.container_name=`${run}-restored-${key}`;
  // The old services stay stopped; both generations use the existing owned lab network.
  next.networks.default={name:config.networks.default.name,external:true};
  return next;
}

export async function restoreProduction(lab,report,save) {

  const {browserAcceptance}=await import("../consumer-install/browser.mjs");
  lab.deadline=Date.now()+1200000;
  const original=structuredClone(lab.config), next=restoreConfiguration(original,lab.run);
  const originalServices=Object.values(original.services).map(s=>s.container_name);
  const backup=`${lab.run}-production-backup`, result=report.restoration={archives:[],restored:[],sourceVolumes:{},targetVolumes:{}};
  result.composeSha256=digest(JSON.stringify(original));
  result.initialSettingsBrowser=settingsBrowser(lab);save();
  const policyField="surface_export.platform_source_of_truth";
  result.policyBefore=readConfigList(lab.ctl("controller","config","list"),[policyField])[policyField];
  const tokenHash=()=>digest(lab.docker(["exec",lab.controller,"cat",lab.controlConfig]));
  result.authenticationBefore=tokenHash();
  result.autoStart={};
  for(const host of [1,2]) {
    const instance=lab.hosts[host].instance;
    result.autoStart[host]=readConfigList(lab.ctl("instance","config","list",instance),["instance.auto_start"])["instance.auto_start"];
    assert.equal(typeof result.autoStart[host],"boolean");
    lab.ctl("instance","config","set",instance,"instance.auto_start","false");
    assert.equal(readConfigList(lab.ctl("instance","config","list",instance),["instance.auto_start"])["instance.auto_start"],false);
  }
  result.marker={run:lab.run,checkpoint:"manual-production-backup"};
  for(const host of [1,2]) lab.lua(host,`storage.manual_production_restore={run=${JSON.stringify(lab.run)},checkpoint='manual-production-backup'};return {success=true}`);
  result.checkpoint=await lab.checkpoint("manual-production-backup");
  for(const host of [1,2]) lab.ctl("instance","stop",lab.hosts[host].instance);
  for(const name of originalServices) lab.assertOwned("container",name);
  lab.docker(["compose","-f",lab.composeFile,"stop"],{timeout:180000});
  for(const name of originalServices) assert.equal(lab.docker(["inspect",name,"--format","{{.State.Running}}"]).trim(),"false");
  lab.docker(["volume","create","--label",`${label}=${lab.run}`,backup]);
  const action=(verb,key,volume,sha="")=>{
    lab.assertOwned("volume",volume);lab.assertOwned("volume",backup);
    return JSON.parse(lab.docker(["run","--name",`${lab.run}-production-${verb}-${key}`,"--label",`${label}=${lab.run}`,
      "--network","none","--user","0","--entrypoint","node","-e",`SE_MANUAL_RUN=${lab.run}`,
      "-v",`${volume}:/data${verb==="backup"?":ro":""}`,"-v",`${backup}:/backup${verb==="restore"?":ro":""}`,
      "-v",`${join(ROOT,"tests/manual/transfer-reliability/backup-storage.mjs")}:/storage.mjs:ro`,
      report.runtime.images.controller,"/storage.mjs",verb,key,sha,"production"],{timeout:60000}));
  };
  for(const key of PRODUCTION_VOLUME_SUFFIXES) {
    const source=original.volumes[key].name,target=next.volumes[key].name;
    assert.notEqual(source,target);result.sourceVolumes[key]=source;result.targetVolumes[key]=target;
    const archive=action("backup",key,source);result.archives.push(archive);save();
    lab.docker(["volume","create","--label",`${label}=${lab.run}`,target]);
    result.restored.push(action("restore",key,target,archive.sha256));save();
  }
  const file=join(lab.directory,"restored-compose.json");writeFileSync(file,JSON.stringify(next,null,2));
  lab.config=next;lab.composeFile=file;lab.controller=next.services.controller.container_name;
  for(const host of [1,2]) lab.hosts[host].container=next.services[`host-${host}`].container_name;
  // Explicit project name prevents Compose from replacing the stopped source generation.
  lab.docker(["compose","-p",`${lab.run}-restored`,"-f",file,"up","-d","--wait","--wait-timeout","180"],{timeout:210000});
  for(const name of originalServices) assert.equal(lab.docker(["inspect",name,"--format","{{.State.Running}}"]).trim(),"false");
  lab.url=`http://${lab.docker(["port",lab.controller,"8080/tcp"]).trim()}`;
  result.loadedCheckpoints={};
  for(const host of [1,2]) {
    // The pinned image's boot guard can restart an existing instance despite auto_start=false.
    // Wait for it, then explicitly select the checkpoint instead of accepting its chosen world.zip.
    await lab.until(()=>lab.docker(["logs","--tail","300",lab.hosts[host].container]).includes("boot-race guard: complete"),"restored host boot guard",120);
    await lab.ready();
    await lab.load(host,"manual-production-backup");
    result.loadedCheckpoints[host]=lab.lua(host,"return {success=true,marker=storage.manual_production_restore}").result.marker;
    assert.deepEqual(result.loadedCheckpoints[host],result.marker,"restored instance loaded another save generation");save();
  }
  await lab.ready();
  for(const host of [1,2]) {
    lab.ctl("instance","config","set",lab.hosts[host].instance,"instance.auto_start",String(result.autoStart[host]));
    assert.equal(readConfigList(lab.ctl("instance","config","list",lab.hosts[host].instance),["instance.auto_start"])["instance.auto_start"],result.autoStart[host]);
  }
  for(const host of [1,2]) await lab.until(()=>lab.lua(host,"return {success=true,ready=storage.source_recovery_ready==true}").result.ready,"restored save reconciliation",60);
  result.authenticationAfter=tokenHash();assert.equal(result.authenticationAfter,result.authenticationBefore);
  result.physical=sample(lab,report.normal.name);assert.equal(result.physical.source.present,false);
  assert.deepEqual(result.physical.destination.cargo,expectedCargo);assert.equal(result.physical.destination.usable,true);
  result.history=summary(lab,report.normal.transferId);assert.equal(result.history.status,"completed");
  result.localSettings={controller:lab.localSettings("controller",lab.controller),host1:lab.localSettings("host",lab.hosts[1].container),host2:lab.localSettings("host",lab.hosts[2].container)};
  const controllerFields=[...Object.keys(report.controllerSettings),policyField];
  const restoredController=readConfigList(lab.ctl("controller","config","list"),controllerFields);
  result.policyAfter=restoredController[policyField];assert.equal(result.policyAfter,result.policyBefore);
  delete restoredController[policyField];result.controllerSettings=restoredController;
  assert.deepEqual(result.controllerSettings,report.controllerSettings);
  result.instanceSettings={};
  for(const host of [1,2]) {
    const name=lab.hosts[host].instance;
    result.instanceSettings[name]=readConfigList(lab.ctl("instance","config","list",name),Object.keys(report.settings[name]));
    assert.deepEqual(result.instanceSettings[name],report.settings[name]);
  }
  const another=`transfer-cleanup-${lab.run}-restored-deployment`;
  result.before=lab.probe(1,"build",another).state;assert.deepEqual(result.before.cargo,expectedCargo);
  result.transferId=start(lab,another);result.outcome=await terminal(lab,result.transferId);assert.equal(result.outcome.status,"completed");
  result.after=sample(lab,another);assert.equal(result.after.source.present,false);assert.deepEqual(result.after.destination.cargo,expectedCargo);
  const browserReport={recovery:{name:another}};await browserAcceptance(lab,browserReport);result.browser=browserReport.browser;save();
  result.settingsBrowser=settingsBrowser(lab);save();
}
