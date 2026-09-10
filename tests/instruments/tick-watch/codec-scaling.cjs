// Run inside idle host-2; source encoding and destination decoding are isolated
// codec calls on the same engine. This is not a gateway/network/client benchmark.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const {promisify}=require('node:util');
const zlib=require('node:zlib');
const {createHash}=require('node:crypto');
const {Rcon}=require('rcon-client');
const deflate=promisify(zlib.deflate),gzip=promisify(zlib.gzip),gunzip=promisify(zlib.gunzip);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const emit=(event,value)=>console.log(JSON.stringify({event,...value}));
async function run(input) {
  const report={v:1,id:input.id,createdAt:new Date().toISOString(),contract:input.contract,
    hashes:input.hashes,cases:[],verdict:'HARNESS_ERROR'};
  const endpoints=new Map();
  for(const pid of fs.readdirSync('/proc').filter(v=>/^\d+$/.test(v))) {
    let args;try{args=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');}catch{continue;}
    if(!args.includes('--start-server')||!args.includes('--rcon-password'))continue;
    const port=Number(args[args.indexOf('--rcon-port')+1]);
    endpoints.set(port,{host:'127.0.0.1',port,password:args[args.indexOf('--rcon-password')+1],timeout:30000,maxPending:1});
  }
  assert.equal(endpoints.size,1);
  const client=new Rcon([...endpoints.values()][0]);client.on('error',()=>{});
  let connected=false,armed=false,failed;let calls=0;
  const deadline=performance.now()+360000;
  async function send(body,cleanup=false) {
    if(!cleanup)assert.ok(performance.now()<deadline&&++calls<2200,'experiment limit exceeded');
    const command=`/sc local p=helpers.create_profiler();local ok,v=pcall(function() ${body} end);`+
      `rcon.print(helpers.table_to_json(ok and v or {success=false,error=tostring(v)}));p.stop();rcon.print({'','[SE_CODEC_V1]callback\\t',p})`;
    assert.ok(Buffer.byteLength(command)<=100000);
    const start=performance.now(),raw=await client.send(command);
    assert.ok(raw.length<300000,'response bound exceeded');
    const value=JSON.parse(raw.trim().split(/\r?\n/).findLast(line=>line.startsWith('{')));assert.equal(value.success,true,value.error);
    const readings=[...raw.matchAll(/\[SE_CODEC_V1\]([a-z_]+)\tDuration: (\d+(?:\.\d+)?)(ms|s)/g)]
      .map(m=>({stage:m[1],ms:Number(m[2])*(m[3]==='s'?1000:1),raw:m[0]}));
    return {...value,readings,rconElapsedMs:performance.now()-start,requestBytes:Buffer.byteLength(command)};
  }
  async function invoke(action,arg,cleanup=false) {
    const encoded=arg===undefined?'nil':`helpers.json_to_table([==[${JSON.stringify(arg)}]==])`;
    assert.ok(!JSON.stringify(arg)?.includes(']==]'));
    for(let retry=0;retry<10;retry++) {
      const v=await send(`local s=package.loaded.surface_export_codec_scaling_lab;`+
        `if not s and '${action}'=='cleanup' then return {success=true,removed=true} end;`+
        `assert(s);return s.invoke('${action}','${input.id}',${encoded})`,cleanup);
      if(!v.waiting)return v;await sleep(20);
    }
    throw Error('no tick advancement');
  }
  const reading=(v,stage)=>{const r=v.readings.find(r=>r.stage===stage);assert.ok(r&&Number.isFinite(r.ms));return r.ms;};
  try {
    await client.connect();connected=true;armed=true;
    report.setup=await send(`local f=(function() ${input.lua} end)();return f('prepare','${input.id}',helpers.json_to_table([==[${JSON.stringify({export_id:input.exportId,ranges:input.ranges})}]==]))`);
    if(input.cleanupProof)throw Error('intentional codec scaling runner failure');
    report.gzipCompatibility=await invoke('gzip_shape',(await gzip('codec-shape')).toString('base64'));
    for(const scale of [1,2,4]) {
      const result={scale,trials:[]};report.cases.push(result);
      for(let repeat=0;repeat<2;repeat++) {
        const setup=await invoke('begin',{scale});
        const trial={repeat,jsonBytes:setup.jsonBytes,frames:setup.frames,source:[],destination:[]};result.trials.push(trial);
        async function control(){
          const c=await invoke('compress_full');const d=await invoke('decode_full');
          trial.control={compressionMs:reading(c,'factorio_compress'),decodeMs:reading(d,'full_decode'),encodedBytes:c.encodedBytes,exactPayload:d.exactPayload,raw:[c,d]};
        }
        if(repeat===0)await control();
        await invoke('reset_receiver');
        const frames=[],compressed=[];let compressionMs=0,wireBytes=0;
        const loopDelay=monitorEventLoopDelay({resolution:10});loopDelay.enable();
        const start=performance.now();
        for(let seq=1;seq<=setup.frames;seq++) {
          const source=await invoke('emit',seq);assert.equal(source.seq,seq);
          frames.push(source.json);const t=performance.now();
          // Async zlib dispatches to Node's threadpool; one outstanding compressor.
          const compressedFrame=await deflate(source.json);compressionMs+=performance.now()-t;
          const encoded=compressedFrame.toString('base64');compressed.push(encoded);wireBytes+=encoded.length;
          delete source.json;trial.source.push(source);
          const dest=await invoke('consume',encoded);assert.equal(dest.seq,seq);trial.destination.push(dest);
          if(seq%50===0)emit('progress',{scale,repeat,frames:seq,total:setup.frames});
        }
        trial.codecLoopElapsedMs=performance.now()-start;loopDelay.disable();
        trial.nodeEventLoopDelayMaxMs=loopDelay.max/1e6;trial.nodeCompressionAwaitMs=compressionMs;
        trial.encodedBytes=wireBytes;
        trial.verification=await invoke('verify');
        const jsonl=frames.join('\n')+'\n';
        const archiveStart=performance.now();const archive=await gzip(jsonl);
        trial.jsonlGzip={jsonBytes:Buffer.byteLength(jsonl),gzipBytes:archive.length,awaitMs:performance.now()-archiveStart};
        assert.equal((await gunzip(archive)).toString(),jsonl);
        // Concatenated gzip members are an archive option, separate from the wire codec.
        const middle=Math.floor(frames.length/2);
        const member1=await gzip(frames.slice(0,middle).join('\n')+'\n');
        const member2=await gzip(frames.slice(middle).join('\n')+'\n');
        const members=Buffer.concat([member1,member2]);
        assert.equal((await gunzip(members)).toString(),jsonl);
        trial.concatenatedGzip={members:2,bytes:members.length,exactText:true};
        trial.framesSha256=createHash('sha256').update(jsonl).digest('hex');
        trial.maxSourceEncodeMs=Math.max(...trial.source.map(v=>reading(v,'source_encode')));
        trial.maxDestinationDecodeMs=Math.max(...trial.destination.map(v=>reading(v,'destination_decode')));
        trial.maxSourceActionMs=Math.max(...trial.source.map(v=>reading(v,'callback')));
        trial.maxDestinationActionMs=Math.max(...trial.destination.map(v=>reading(v,'callback')));
        if(repeat===1)await control();
        emit('trial',{scale,repeat,fullCompressionMs:trial.control.compressionMs,fullDecodeMs:trial.control.decodeMs,
          maxSourceEncodeMs:trial.maxSourceEncodeMs,maxDestinationDecodeMs:trial.maxDestinationDecodeMs,
          fullEncodedBytes:trial.control.encodedBytes,sectionEncodedBytes:wireBytes,exactPayload:trial.verification.exactPayload});
      }
    }
    report.verdict='PASS';
  }catch(error){failed=error;report.error=error.message;}
  finally {
    if(armed&&connected)try{report.cleanup=await invoke('cleanup',undefined,true);
      report.residue=await send('return {success=true,present=package.loaded.surface_export_codec_scaling_lab~=nil}',true);assert.equal(report.residue.present,false);
    }catch(error){report.cleanupError=error.message;failed=error;report.verdict='HARNESS_ERROR';}
    if(connected)await client.end().catch(()=>{});
    report.calls=calls;report.cleanupProofPassed=input.cleanupProof&&failed?.message==='intentional codec scaling runner failure'&&!report.cleanupError;
    emit('report',{report});if(failed&&!report.cleanupProofPassed)process.exitCode=1;
  }
}
module.exports={run};
