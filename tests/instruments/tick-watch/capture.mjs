import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lua, docker, sleep } from '../../lab-gallery/batch-lifecycle.mjs';
import { analyze } from './analyze.mjs';

// Host-1 and its locally connected Steam client. No readings share a clock.
export async function capture(work) {
  const id=`tickwatch-${Date.now().toString(36)}`;
  const code=readFileSync(new URL('./probe.lua',import.meta.url),'utf8');
  const invoke=action=>{
    const r=lua(1,`local p=(function() ${code} end)();return p('${action}','${id}',7200)`);
    assert.equal(r.success,true,r.error);return r;
  };
  const report={id,startedAt:new Date().toISOString(),instrumentSha256:createHash('sha256').update(code).digest('hex'),
    interpretation:'Local tick-entry intervals include simulation work, waiting, scheduling and sleep; not exclusive CPU time. FPS unmeasured.'};
  let armed=false, failure;
  try { armed=true;report.arm=invoke('arm');report.work=await work(); }
  catch(error){failure=error;report.error=error.message;}
  finally {
    if(armed) {
      try {
        report.finish=invoke('finish');
        report.residue=invoke('status');assert.equal(report.residue.present,false);
        const file=report.finish.file;assert.equal(file,`surface-export-tests/${id}.tsv`);
        const server=docker(['exec','surface-export-host-1','cat',`/clusterio/data/instances/clusterio-host-1-instance-1/script-output/${file}`]);
        writeFileSync(`ci-artifacts/${id}-server.tsv`,server);report.server=analyze(server);
        const clientFile=join(process.env.APPDATA,'Factorio','script-output',file);
        for(let attempt=0;attempt<5;attempt++) {
          try {
            const client=readFileSync(clientFile,'utf8');writeFileSync(`ci-artifacts/${id}-client.tsv`,client);report.client=analyze(client);
            const prefix=join(process.env.APPDATA,'Factorio','script-output','surface-export-tests',id);
            report.clientClockCheck={filesystemElapsedMs:statSync(prefix+'-total.txt').mtimeMs-statSync(prefix+'-start.txt').mtimeMs,
              profilerTotalRaw:readFileSync(prefix+'-total.txt','utf8'),limitations:'UTC file timestamps include formatting and file output overhead; corroboration only, not a replacement monotonic clock.'};
            break;
          }
          catch(error){if(attempt===4)report.clientUnavailable=error.message;else await sleep(1000);}
        }
      } catch(error){report.cleanupError=error.message;failure=error;}
    }
    report.verdict=failure?'HARNESS_ERROR':'PASS';
    writeFileSync(`ci-artifacts/${id}.json`,JSON.stringify(report,null,2));
    console.log({artifact:`ci-artifacts/${id}.json`,verdict:report.verdict,
      server:compact(report.server),client:compact(report.client),clientClockCheck:report.clientClockCheck,clientUnavailable:report.clientUnavailable,cleanupError:report.cleanupError});
  }
  if(failure)throw failure;return report;
}
function compact(value){if(!value)return undefined;const {rowsRaw,windows,...summary}=value;return summary;}
