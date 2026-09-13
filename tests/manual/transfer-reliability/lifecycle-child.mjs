import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {runLab} from './lifecycle.mjs';
const source=readFileSync(process.argv[2] || new URL('./upload-status.mjs',import.meta.url),'utf8');
process.argv=['node','probe','ci-artifacts/dist'];
class SetupProbe {
 async setup() {
  console.log('READY');
  while(!this.cancelled)await new Promise(resolve=>setTimeout(resolve,10));
  throw Error('Manual lab interrupted');
 }
 async cleanup(){console.log('CLEANUP');return {success:true};}
}
const context={assert,join,resolve,process,console,runLab,DockerLab:SetupProbe,ROOT:'/repo',PLUGIN:'/repo/plugin',
 mkdirSync(){},cpSync(){},hashTree:()=>'',randomUUID:()=> '12345678',withWorkflowLock:fn=>fn(),
 writeFileSync(_path,data){const report=JSON.parse(data);if(report.finishedAt)console.log('EVIDENCE '+JSON.stringify(report));}};
await vm.runInNewContext(`(async()=>{${source.replace(/^import .*?;\r?\n/gm,'')}\n})()`,context);
