const {test}=require("node:test");
const assert=require("node:assert/strict");
const {JobObserver}=require("../dist/node/lib/job-observer.js");

test("job observations distinguish queue, waits, no progress and new process epochs",()=>{
 let now=0;
 const observer=new JobObserver(()=>{},()=>now);
 const job={state:"queued",epoch:"first",phase:"entities",work:{entities:0},observedTick:1};
 assert.equal(observer.observe("operation",job,30000).message,"Waiting in Lua queue");
 now=60000;
 assert.equal(observer.observe("operation",job,30000).message,"Waiting in Lua queue");
 job.state="running"; job.observedTick=10000;
 assert.equal(observer.observe("operation",job,30000).message,"No progress observed");
 job.work.entities=1;
 assert.equal(observer.observe("operation",job,30000).message,"Lua work progressing");
 now+=40000; job.state="waiting"; job.waitUntilTick=10001;
 assert.equal(observer.observe("operation",job,30000).message,"Waiting for a scheduled Lua phase");
 job.state="running"; job.epoch="second";
 assert.equal(observer.observe("operation",job,30000).message,"Lua work progressing");
 assert.equal(observer.observe("operation",{state:"unavailable"},30000).message,"Status unavailable");
});

test("one outstanding batched request per instance, at most one each five monotonic seconds",async()=>{
 let now=0, calls=0, resolve;
 const observer=new JobObserver(async(_,jobs)=>{calls++; assert.equal(jobs.length,2); return new Promise(r=>{resolve=r;});},()=>now);
 const jobs=[{jobId:"a"},{jobId:"b"}];
 const first=observer.poll(1,jobs);
 assert.equal(await observer.poll(1,jobs),undefined);
 now=200000;
 assert.equal(await observer.poll(1,jobs),undefined,"slow RCON cannot cause request stacking");
 resolve({version:1,epoch:"runtime",jobs:[]}); await first;
 const second=observer.poll(1,jobs);
 resolve({version:1,epoch:"runtime",jobs:[]}); await second;
 now+=4999;
 assert.equal(await observer.poll(1,jobs),undefined);
 assert.equal(calls,2);
});

test("bounded status batches rotate through all tracked jobs",async()=>{
 let now=0;
 const observer=new JobObserver(async(_,jobs)=>({version:1,epoch:"runtime",jobs:jobs.map(ref=>({...ref,state:"queued"}))}),()=>now);
 const jobs=Array.from({length:125},(_,index)=>({jobId:`job-${index}`}));
 const first=await observer.poll(1,jobs);now=5000;
 const second=await observer.poll(1,jobs);
 assert.equal(first.requested.length,100);assert.equal(second.requested.length,100);
 assert.equal(new Set([...first.jobs,...second.jobs].map(j=>j.jobId)).size,125);
});
