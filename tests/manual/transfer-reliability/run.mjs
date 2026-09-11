import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withWorkflowLock } from "../../../tools/shared/workflow-lock.mjs";
import { DockerLab, ROOT, PLUGIN, hash, validRun } from "./docker-lab.mjs";
import { recoveryCase, performanceCase } from "./cases.mjs";
import { backupRestoreCase } from "./backup-restore.mjs";
import { destinationRollbackCase } from "./destination-rollback.mjs";
import { analyze } from "./oracle.mjs";

const contract=JSON.parse(readFileSync(new URL("./contract.json",import.meta.url)));
const sectionedCodec=process.argv.includes("--sectioned");
const args=process.argv.slice(2).filter(arg=>arg!=="--sectioned");
if(args.length===0||args[0]==="--list"||args[0]==="--help") {
  console.log("Manual Docker acceptance: node tests/manual/transfer-reliability/run.mjs --case <id>\n");
  for(const c of contract.cases) console.log(`${c.id}: ${c.purpose}`);
  console.log("\nAll cases sequentially: --all (continues after STOP, stops on HARNESS_ERROR).\nEach case creates and removes its own Docker cluster. No live-cluster mode.\nOffline: --analyze <result.json>\nAfter runner interruption: --cleanup <run-id>\nCleanup exercise: --case <id> --fail-after-setup\nExit: 0 PASS, 2 STOP (observed violation), 1 HARNESS_ERROR.");
} else if(args[0]==="--all"&&args.length===1) {
  for(const c of contract.cases) {
    const code=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url),"--case",c.id,...(sectionedCodec?["--sectioned"]:[])],{stdio:"inherit"});
      child.on("error",reject);child.on("exit",resolve);
    });
    if(code!==0&&code!==2) {process.exitCode=1;break;}
    if(code===2) process.exitCode=2;
  }
} else if(args[0]==="--cleanup"&&args.length===2&&validRun(args[1])) {
  await withWorkflowLock(async()=>{
    const directory=join(ROOT,"ci-artifacts",args[1]);
    const report=JSON.parse(readFileSync(join(directory,"result.json"),"utf8"));
    if(report.run!==args[1]) throw new Error("Artifact identity mismatch");
    const result=await new DockerLab(args[1],directory).cleanup();
    writeFileSync(join(directory,"cleanup-retry.json"),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));process.exitCode=result.success?0:1;
  });
} else if(args[0]==="--analyze"&&args.length===2) {
  try {const result=analyze(JSON.parse(readFileSync(args[1],"utf8")));console.log(JSON.stringify(result,null,2));process.exitCode=result.verdict==="PASS"?0:2;}
  catch(error){console.error(`HARNESS_ERROR: ${error.message}`);process.exitCode=1;}
} else {
  const failAfterSetup=args.length===3&&args[2]==="--fail-after-setup";
  const failAfterBackup=args.length===3&&args[2]==="--fail-after-backup"&&args[1]==="coordinated-restore";
  const failAfterControl=args.length===3&&args[2]==="--fail-after-control"&&args[1]==="restore-old-destination";
  const chosen=contract.cases.find(c=>args[0]==="--case"&&args[1]===c.id&&(args.length===2||failAfterSetup||failAfterBackup||failAfterControl));
  if(!chosen) throw new Error("Use --list or --case with an exact listed case");
  await withWorkflowLock(async()=>{
    const run=`se-manual-${Date.now().toString(36)}-${randomUUID().slice(0,8)}`;
    const directory=join(ROOT,"ci-artifacts",run);mkdirSync(directory,{recursive:true});
    const report={schemaVersion:1,case:chosen.id,run,contract,sectionedCodec,startedAt:new Date().toISOString(),
      head:execFileSync("git",["rev-parse","HEAD"],{cwd:ROOT,encoding:"utf8"}).trim(),hashes:{},cleanup:{success:false}};
    for(const file of ["run.mjs","docker-lab.mjs","cases.mjs","fault-hook.cjs","age-intent.mjs","performance.lua","oracle.mjs","contract.json","backup-restore.mjs","backup-storage.mjs","destination-rollback.mjs"])
      report.hashes[file]=hash(new URL(file,import.meta.url));
    for(const file of ["dist/node/controller.js","dist/node/instance.js","module/core/import-completion.lua","module/utils/transfer-receipts.lua"])
      report.hashes[`plugin/${file}`]=hash(join(PLUGIN,file));
    report.hashes["physical-probe"]=hash(join(ROOT,"tests/integration/transfer-cleanup/probe.lua"));
    report.hashes["physical-contract"]=hash(join(ROOT,"tests/integration/transfer-cleanup/oracle.mjs"));
    const file=join(directory,"result.json"),save=()=>writeFileSync(file,JSON.stringify(report,null,2)+"\n");save();
    const lab=new DockerLab(run,directory,{sectionedCodec});
    const interrupt=()=>{lab.cancelled=true;};
    process.on("SIGINT",interrupt);process.on("SIGTERM",interrupt);
    try {
      console.log(`Starting disposable Docker run ${run}: ${chosen.id}`);
      report.environment=await lab.setup();save();console.log("Disposable instances ready; executing contract");
      if(failAfterSetup) throw new Error("Intentional harness failure after setup; verify cleanup.success");
      lab.deadline=Date.now()+contract.bounds.caseSeconds*1000;
      if(chosen.id==="performance") await performanceCase(lab,report,save);
      else if(chosen.id==="coordinated-restore") await backupRestoreCase(lab,report,save,{failAfterBackup});
      else if(chosen.id==="restore-old-destination") await destinationRollbackCase(lab,report,save,{failAfterControl});
      else await recoveryCase(lab,report,save);
    } catch(error) {report.error=error.stack;report.verdict="HARNESS_ERROR";}
    finally {
      report.cleanup=await lab.cleanup();report.finishedAt=new Date().toISOString();
      process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);
      if(!report.error) try {Object.assign(report,analyze(report));}catch(error){report.error=error.stack;report.verdict="HARNESS_ERROR";}
      if(!report.cleanup.success) report.verdict="HARNESS_ERROR";
      save();console.log(JSON.stringify({verdict:report.verdict,violations:report.violations,error:report.error,
        cleanup:report.cleanup.success,artifact:file},null,2));
      process.exitCode=report.verdict==="PASS"?0:report.verdict==="STOP"?2:1;
    }
  });
}
