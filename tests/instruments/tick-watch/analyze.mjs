import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function milliseconds(raw) {
  const match = raw.match(/^Duration: (\d+(?:\.\d+)?)(ms|s)$/);
  assert.ok(match,`Unavailable profiler reading: ${raw}`);
  const value=Number(match[1])*(match[2]==='s'?1000:1);
  assert.ok(Number.isFinite(value)); return value;
}
export function analyze(raw) {
  const lines=raw.trim().split(/\r?\n/); const header=JSON.parse(lines.shift());
  assert.equal(header.v,1); assert.equal(header.engine,'2.1.17');
  assert.equal(header.truncated,false,'recorder truncated; full interval unavailable');
  const rows=lines.map(line=>{
    const fields=line.split('\t');assert.equal(fields.length,4);
    return {...JSON.parse(fields[0]),offsetMs:milliseconds(fields[1]),callbackMs:milliseconds(fields[2]),overheadMs:milliseconds(fields[3])};
  });
  assert.equal(rows.length,header.rows); assert.ok(rows.length>1,'insufficient samples');
  const gaps=[];
  for(let i=0;i<rows.length;i++) {
    const row=rows[i];assert.equal(row.success,true);assert.equal(row.speed,1,'non-default game speed');
    if(i) {assert.equal(row.tick,rows[i-1].tick+1,'missing, duplicated or reset tick');
      const gap=row.offsetMs-rows[i-1].offsetMs; assert.ok(gap>=0,'clock moved backwards');gaps.push(gap);}
  }
  const elapsedMs=rows.at(-1).offsetMs-rows[0].offsetMs;assert.ok(elapsedMs>0);
  // Every rolling interval of 60 actual tick transitions. Its elapsed length is measured.
  const windows=rows.slice(60).map((row,i)=>({endTick:row.tick,elapsedMs:row.offsetMs-rows[i].offsetMs,ups:60000/(row.offsetMs-rows[i].offsetMs)}));
  const sorted=[...gaps].sort((a,b)=>a-b);
  return {id:header.id,rows:rows.length,firstTick:rows[0].tick,lastTick:rows.at(-1).tick,elapsedMs,
    averageUps:(rows.length-1)*1000/elapsedMs,
    minRolling60TickUps:windows.length?Math.min(...windows.map(w=>w.ups)):null,
    maxUpdateGapMs:Math.max(...gaps),p99UpdateGapMs:sorted[Math.ceil(sorted.length*.99)-1],
    gapsOver33ms:gaps.filter(n=>n>33).length,gapsOver50ms:gaps.filter(n=>n>50).length,
    maxSchedulerCallbackMs:Math.max(...rows.map(r=>r.callbackMs)),
    measuredRecorderOverheadTotalMs:rows.reduce((n,r)=>n+r.overheadMs,0),
    maxMeasuredRecorderOverheadMs:Math.max(...rows.map(r=>r.overheadMs)),
    windows,rowsRaw:rows};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {windows,rowsRaw,...summary}=analyze(readFileSync(process.argv[2],'utf8'));console.log(summary);
}
