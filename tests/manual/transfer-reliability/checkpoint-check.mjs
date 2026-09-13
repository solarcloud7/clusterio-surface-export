import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ROOT } from "./docker-lab.mjs";

export const contract = {
  requires: ["pinned host image", "Docker"],
  produces: ["checkpoint digest verification", "permanent size rejection", "incomplete ZIP retry"],
  "does not": ["start Factorio", "transfer platforms", "verify saved world cargo"]
};

export async function checkpointCheck(lab, report, save) {
  const container=lab.hosts[2].container;
  const tag=readFileSync(join(ROOT,".env.example"),"utf8").match(/^CLUSTERIO_IMAGE_TAG=(.+)$/m)?.[1].trim();
  assert.match(tag || "",/^2\.0\.0-alpha\.\d+[.-]r\d+$/,"pinned host image required");
  const image=`ghcr.io/solarcloud7/clusterio-docker-host:${tag}`;
  lab.docker(["run","-d","--name",container,"--label",`surface-export.manual-run=${lab.run}`,
    "--network","none","--entrypoint","/bin/sleep",image,"infinity"]);
  lab.containers.push(container);lab.assertOwned("container",container);
  report.environment={image,imageId:JSON.parse(lab.docker(["container","inspect",container]))[0].Image};save();
  const path=`/clusterio/data/instances/${lab.hosts[2].instance}/saves`;
  const exec=code=>lab.docker(["exec",container,"node","-e",code]);
  report.expected=JSON.parse(exec(`const fs=require('fs'),zip=require('jszip'),crypto=require('crypto'),p=${JSON.stringify(path)};
    fs.mkdirSync(p,{recursive:true});const z=new zip();z.file('probe.txt','checkpoint content');
    z.generateAsync({type:'nodebuffer'}).then(b=>{fs.writeFileSync(p+'/manual-valid.zip',b);
      fs.writeFileSync(p+'/manual-pending.zip','incomplete');
      const fd=fs.openSync(p+'/manual-oversized.zip','w');fs.ftruncateSync(fd,268435457);fs.closeSync(fd);
      console.log(JSON.stringify({sha256:crypto.createHash('sha256').update(b).digest('hex')}));});`)).sha256;
  report.valid=lab.checkpointHash(2,"manual-valid");assert.equal(report.valid,report.expected);save();
  let attempts=0;const started=performance.now();
  await assert.rejects(lab.until(()=>{attempts++;return lab.checkpointHash(2,"manual-oversized");},"oversized checkpoint",60),error=>{
    report.oversized={message:error.message,retryable:error.retryable,attempts,elapsedMs:performance.now()-started};
    assert.equal(error.retryable,false);assert.match(error.message,/checkpoint exceeds 256 MiB/);return true;
  });
  assert.equal(attempts,1);save();attempts=0;
  report.retried=await lab.until(()=>{
    attempts++;
    if(attempts===2)exec(`require('fs').copyFileSync(${JSON.stringify(path+'/manual-valid.zip')},${JSON.stringify(path+'/manual-pending.zip')})`);
    return lab.checkpointHash(2,"manual-pending");
  },"completed checkpoint",10);
  assert.equal(attempts,2);assert.equal(report.retried,report.expected);report.attempts=attempts;save();
}
