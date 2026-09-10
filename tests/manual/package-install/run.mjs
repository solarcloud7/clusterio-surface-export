import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
import { DockerLab, ROOT, PLUGIN, hash, hashTree } from "../transfer-reliability/docker-lab.mjs";
import { recoveryCase } from "../transfer-reliability/cases.mjs";
import { analyzePackage } from "./oracle.mjs";
import { verifyPackage } from "../../../tools/release/verify-package.mjs";

const arg=process.argv[2];
if(arg==="--analyze") {
  const report=JSON.parse(readFileSync(process.argv[3],"utf8"));
  const result=analyzePackage(report);console.log(JSON.stringify(result,null,2));process.exitCode=result.verdict==="PASS"?0:2;
} else if(arg!=="--run"&&arg!=="--cleanup-proof") {
  console.log("Build first: ./tools/clusterio/build-plugin.ps1 -Target all\nRun: node tests/manual/package-install/run.mjs --run [--artifact-dir <new-directory>]\nCleanup proof: --cleanup-proof\nOffline: --analyze <result.json>");
} else await withWorkflowLock(async()=>{
  const artifactOption=process.argv.indexOf("--artifact-dir");
  const artifactDirectory=artifactOption<0?null:resolve(process.argv[artifactOption+1]||"");
  if(artifactOption>=0) {
    assert.ok(process.argv[artifactOption+1],"--artifact-dir requires a new output directory");
    assert.ok(!existsSync(artifactDirectory),"artifact output already exists; refusing stale release files");
  }
  const commit=execFileSync("git",["rev-parse","HEAD"],{cwd:ROOT,encoding:"utf8"}).trim();
  let tarball;
  const run=`se-manual-${Date.now().toString(36)}-${randomUUID().slice(0,8)}`;
  const directory=join(ROOT,"ci-artifacts",run),installed=join(directory,"installed");mkdirSync(installed,{recursive:true});
  const lab=new DockerLab(run,directory,{packageDirectory:installed});
  const report={schemaVersion:1,release:{schemaVersion:1,commit},case:"lost-source-reply",run,startedAt:new Date().toISOString(),cleanup:{success:false},
    contract:JSON.parse(readFileSync(new URL("../transfer-reliability/contract.json",import.meta.url))),
    hashes:{runner:hash(new URL(import.meta.url)),lab:hash(new URL("../transfer-reliability/docker-lab.mjs",import.meta.url)),
      cases:hash(new URL("../transfer-reliability/cases.mjs",import.meta.url)),oracle:hash(new URL("../transfer-reliability/oracle.mjs",import.meta.url)),
      faultHook:hash(new URL("../transfer-reliability/fault-hook.cjs",import.meta.url)),packageOracle:hash(new URL("./oracle.mjs",import.meta.url)),
      physicalProbe:hash(join(ROOT,"tests/integration/transfer-cleanup/probe.lua"))}};
  const save=()=>writeFileSync(join(directory,"result.json"),JSON.stringify(report,null,2)+"\n");save();
  const interrupt=()=>{lab.cancelled=true;};process.on("SIGINT",interrupt);process.on("SIGTERM",interrupt);
  try {
    console.log(`Package install acceptance: ${run}`);
    const packName=`${run}-npm-pack`;
    const raw=lab.docker(["run","--name",packName,"--label",`surface-export.manual-run=${run}`,"--network","none",
      "--mount",`type=bind,src=${PLUGIN},dst=/package,readonly`,"--mount",`type=bind,src=${directory},dst=/out`,
      "-w","/package","node:24-bookworm-slim","npm","pack","--ignore-scripts","--json","--pack-destination","/out"],{timeout:60_000});
    const [packed]=JSON.parse(raw);assert.equal(packed.name,"@solarcloud7/plugin-surface-export");
    tarball=join(directory,packed.filename);
    report.package={name:packed.name,version:packed.version,integrity:packed.integrity,sha256:hash(tarball),files:packed.files.map(f=>f.path)};save();
    const tag=readFileSync(join(ROOT,".env.example"),"utf8").match(/^CLUSTERIO_IMAGE_TAG=(.+)$/m)[1].trim();
    const image=`ghcr.io/solarcloud7/clusterio-docker-controller:${tag}`,consumer=`${run}-npm-consumer`;
    lab.docker(["run","-d","--name",consumer,"--label",`surface-export.manual-run=${run}`,"--entrypoint","sleep",image,"infinity"]);
    lab.docker(["cp",tarball,`${consumer}:/candidate.tgz`]);
    // Normal tarball installation: no --force, --legacy-peer-deps or ignored install hooks.
    lab.docker(["exec","-w","/clusterio",consumer,"npm","install","--omit=dev","--no-audit","--no-fund","/candidate.tgz"],{timeout:120_000});
    report.packageInstall=JSON.parse(lab.docker(["exec","-w","/clusterio",consumer,"node","-e",`
      const fs=require('fs'),path=require('path'),assert=require('assert/strict');
      const root='/clusterio/node_modules/@solarcloud7/plugin-surface-export',p=require(root+'/package.json');
      assert.equal(p.version,process.argv[1]);
      for(const n of ['controller','ctl','host','lib'])assert.equal(require('@clusterio/'+n+'/package.json').version,'2.0.0-alpha.27');
      assert.equal(require.resolve('@clusterio/lib',{paths:[root]}),require.resolve('@clusterio/lib'));
      const manifest=JSON.parse(fs.readFileSync(root+'/dist/web/manifest.json'));
      for(const value of Object.values(manifest))assert.ok(fs.existsSync(path.join(root,'dist/web',value)),'missing web artifact '+value);
      assert.equal(JSON.parse(fs.readFileSync(root+'/module/module.json')).version,p.version);
      require(root+'/dist/node/index.js');
      console.log(JSON.stringify({success:true,version:p.version,webEntries:Object.keys(manifest),coreVersion:'2.0.0-alpha.27'}));`,packed.version]));
    lab.docker(["cp",`${consumer}:/clusterio/node_modules/@solarcloud7/plugin-surface-export/.`,installed]);
    report.packageInstall.treeHash=hashTree(installed);save();
    console.log("Tarball installed with normal npm peer resolution; checking the packed runtime in Factorio");
    if(arg==="--cleanup-proof") throw new Error("Intentional failure after package installation; verify cleanup.success");
    lab.deadline=Date.now()+600_000;
    report.environment=await lab.setup();save();
    assert.equal(report.environment.stagedHashes.plugin,report.packageInstall.treeHash,"lab runtime differs from installed tarball");
    lab.deadline=Date.now()+600_000;
    await recoveryCase(lab,report,save);
  } catch(error) {report.error=error.stack;report.verdict="HARNESS_ERROR";}
  finally {
    report.cleanup=await lab.cleanup();report.finishedAt=new Date().toISOString();
    process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);
    if(!report.error)try{Object.assign(report,analyzePackage(report));}catch(error){report.error=error.stack;report.verdict="HARNESS_ERROR";}
    if(!report.cleanup.success)report.verdict="HARNESS_ERROR";
    if(report.verdict==="PASS"&&artifactDirectory)try {
      assert.equal(hash(tarball),report.package.sha256,"tarball changed during acceptance");
      mkdirSync(artifactDirectory,{recursive:true});
      copyFileSync(tarball,join(artifactDirectory,"package.tgz"));
      writeFileSync(join(artifactDirectory,"acceptance.json"),JSON.stringify(report,null,2)+"\n");
      verifyPackage(artifactDirectory,{commit,version:report.package.version});
    } catch(error) {report.error=error.stack;report.verdict="HARNESS_ERROR";}
    save();console.log(JSON.stringify({verdict:report.verdict,error:report.error,violations:report.violations,
      cleanup:report.cleanup.success,artifact:join(directory,"result.json")},null,2));
    process.exitCode=report.verdict==="PASS"?0:report.verdict==="STOP"?2:1;
  }
});
