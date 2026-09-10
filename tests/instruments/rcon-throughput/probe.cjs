// Executed on stdin inside host-1. Credentials stay inside the container.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { Rcon } = require('rcon-client');
const comparison = process.argv.includes('--compare-100k-10k');
const chunkSizes = comparison ? [100000, 10000] : [1000, 10000, 100000];
const report = { version: 1, startedAt: new Date().toISOString(), cases: [],
  contract: { totalPayloadBytesPerCase: 100000, chunkSizes,
    commandTimeoutMs: 30000, experimentDeadlineMs: 180000, maxMeasuredCommands: 5 + chunkSizes.reduce((n,size)=>n+100000/size,0),
    betweenCasesMs: comparison ? 10000 : 3000,
    route: 'persistent localhost RCON; bypasses controller and host RCON queue',
    luaWork: 'string length only; profiler excludes compilation, scheduling and reply formatting',
    mutations: 'player notices only; no persistent Lua state, jobs, surfaces or cargo changes',
    clientMeasurement: 'user observation only; no FPS trace', repeatCount: 1 } };
const emit = (event, data) => console.log(JSON.stringify({ event, ...data }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stateBody = `local names={};for _,p in pairs(game.connected_players) do names[#names+1]=p.name end;table.sort(names);rcon.print(helpers.table_to_json{engine=script.active_mods.base,mods=script.active_mods,tick=game.tick,players=names,paused=game.tick_paused,jobs=table_size(storage.async_jobs or {}),locks=table_size(storage.locked_platforms or {}),holds=table_size(storage.destination_holds or {})})`;
function checkState(s) {
  assert.equal(s.engine,'2.1.17'); assert.equal(s.paused,false);
  assert.deepEqual(s.players,['solarcloud7']);
  for(const k of ['jobs','locks','holds']) assert.equal(s[k],0,`${k} active`);
}
async function main() {
  // Clusterio can generate these at startup, leaving instance.json values null.
  const endpoints = new Map();
  for(const pid of fs.readdirSync('/proc').filter(n=>/^\d+$/.test(n))) {
    let args; try { args=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0'); } catch { continue; }
    if(!args.includes('--start-server') || !args.includes('--rcon-password')) continue;
    const port=Number(args[args.indexOf('--rcon-port')+1]);
    endpoints.set(port,{host:'127.0.0.1',port,password:args[args.indexOf('--rcon-password')+1],timeout:30000,maxPending:1});
  }
  assert.equal(endpoints.size,1,'expected exactly one Factorio RCON endpoint');
  const settings=JSON.parse(fs.readFileSync('/clusterio/data/instances/clusterio-host-1-instance-1/server-settings.json'));
  report.segmentSettings=Object.fromEntries(Object.entries(settings).filter(([k])=>!k.startsWith('_')&&/segment/.test(k)));
  const client = new Rcon([...endpoints.values()][0]);
  client.on('error',()=>{}); // Send/connect promises carry the failure into the report.
  let connected=false;
  const deadline=performance.now()+report.contract.experimentDeadlineMs;
  async function send(command) {
    assert.ok(performance.now()<deadline,'experiment deadline exceeded');
    assert.ok(Buffer.byteLength(command)<101000,'command budget exceeded');
    const start=performance.now(); const raw=await client.send(command); const elapsedMs=performance.now()-start;
    assert.ok(raw.length<10000,'unexpected response size'); return {raw,elapsedMs,commandBytes:Buffer.byteLength(command)};
  }
  const state=async()=>JSON.parse((await send('/sc '+stateBody)).raw.trim());
  const notice=async text=>send(`/sc local p=assert(game.get_player('solarcloud7'));assert(p.connected);p.print('${text}');rcon.print('OK')`);
  async function sample(payload,sequence) {
    const command=`/sc local p=helpers.create_profiler();local d=[[${payload}]];local n=#d;p.stop();rcon.print({"","[SE_RCON_PROBE_V1]",helpers.table_to_json{bytes=n,tick=game.tick,sequence=${sequence}},"|",p})`;
    const result=await send(command);
    const match=result.raw.trim().match(/^\[SE_RCON_PROBE_V1\](\{.*\})\|Duration: ([\d.]+)(ms|s)$/);
    assert.ok(match,'unexpected profiler response');
    const meta=JSON.parse(match[1]); assert.equal(meta.bytes,payload.length); assert.equal(meta.sequence,sequence);
    return {...result,...meta,luaExecutionMs:Number(match[2])*(match[3]==='s'?1000:1)};
  }
  try {
    await client.connect(); connected=true; report.before=await state(); checkState(report.before);
    // Deterministic, non-repeating-looking ASCII: avoids testing a highly compressible string of A's.
    const payload=Array.from({length:1563},(_,i)=>createHash('sha256').update(`surface-export-rcon-${i}`).digest('hex')).join('').slice(0,100000);
    report.payloadSha256=createHash('sha256').update(payload).digest('hex');
    report.baseline=[]; for(let i=0;i<5;i++) report.baseline.push(await sample('shape-smoke',i));
    await notice('RCON test ready. Please do not start transfers during the comparison.');
    for(const chunkSize of report.contract.chunkSizes) {
      checkState(await state());
      await notice(`RCON ${chunkSize/1000}k chunks in 3 seconds - watch FPS and UPS.`); await sleep(3000);
      await notice(`NOW RCON ${chunkSize/1000}k chunks`);
      const result={chunkSize,samples:[],startedAt:new Date().toISOString()}; report.cases.push(result);
      const start=performance.now();
      for(let pos=0;pos<payload.length;pos+=chunkSize) result.samples.push(await sample(payload.slice(pos,pos+chunkSize),pos/chunkSize));
      result.elapsedMs=performance.now()-start; result.completedAt=new Date().toISOString();
      result.payloadBytes=result.samples.reduce((n,s)=>n+s.bytes,0); assert.equal(result.payloadBytes,100000);
      result.commandBytes=result.samples.reduce((n,s)=>n+s.commandBytes,0);
      result.maxAcknowledgementMs=Math.max(...result.samples.map(s=>s.elapsedMs));
      result.maxLuaExecutionMs=Math.max(...result.samples.map(s=>s.luaExecutionMs));
      result.firstTick=result.samples[0].tick; result.lastTick=result.samples.at(-1).tick;
      await notice(`COMPLETE RCON ${chunkSize/1000}k chunks - ${(result.elapsedMs/1000).toFixed(2)} seconds`);
      emit('case-complete',{chunkSize,elapsedMs:result.elapsedMs,maxAcknowledgementMs:result.maxAcknowledgementMs,maxLuaExecutionMs:result.maxLuaExecutionMs});
      await sleep(report.contract.betweenCasesMs);
    }
    report.after=await state(); checkState(report.after); report.verdict='PASS';
  } catch(error) { report.verdict='HARNESS_ERROR'; report.error=error.message; }
  finally {
    if(connected) { try { await notice('RCON comparison finished. No test platforms or persistent test state were created.'); } catch {} }
    try { await client.end(); } catch {}
    report.cleanup={persistentLuaStateCreated:false,connectionClosed:true};
    emit('report',{report}); if(report.verdict!=='PASS')process.exitCode=1;
  }
}
main().catch(error=>{emit('report',{report:{...report,verdict:'HARNESS_ERROR',error:error.message}});process.exitCode=1;});
