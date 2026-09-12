const {test}=require("node:test");
const assert=require("node:assert/strict");
const {UploadSessions,UploadUncertain}=require("../dist/node/lib/upload-session.js");

function harness(fault) {
 const records=new Map(), calls=[];
 let jobs=0;
 const client=new UploadSessions(async(action,q)=>{
  calls.push(action);
  const r=records.get(q.attemptId);
  if(action==="initialize") return {version:1,success:true,epoch:q.epoch};
  if(action==="begin") {
   const record={version:1,success:true,state:"receiving",attemptId:q.attemptId,epoch:q.epoch,chunks:[]};
   records.set(q.attemptId,record); return record;
  }
  if(action==="chunk") {
   if(fault==="chunk") throw new Error("broken connection");
   r.chunks[q.index-1]=q.data; return r;
  }
  if(action==="commit") {
   jobs++; r.state="accepted"; r.jobId=`job_${jobs}`;
   if(fault==="ack"||fault==="missing") throw new Error("lost reply");
   return r;
  }
  if(action==="status") return fault==="missing" ? {version:1,success:true,state:"unavailable"}:r;
  if(action==="abort") {r.state="aborted";r.chunks=[];return r;}
  throw new Error(action);
 });
 return {client,records,calls,get jobs(){return jobs;}};
}
test("lost final acknowledgement resolves the same job without another commit",async()=>{
 const h=harness("ack");await h.client.initialize("runtime");
 const result=await h.client.send("op","平台","player",{_operationId:"op",text:"]]=]\n🙂"});
 assert.equal(result.jobId,"job_1");assert.equal(h.jobs,1);
 assert.deepEqual(h.calls,["initialize","begin","chunk","commit","status"]);
 assert.equal(JSON.parse([...h.records.values()][0].chunks.join("")).text,"]]=]\n🙂");
 h.client.stop();
});
test("failed chunk handler discards only a confirmed receiving attempt",async()=>{
 const h=harness("chunk");await h.client.initialize("runtime");
 await assert.rejects(h.client.send("op","same","player",{}),/broken connection/);
 assert.deepEqual(h.calls,["initialize","begin","chunk","status","abort"]);
 assert.equal(h.jobs,0);assert.equal([...h.records.values()][0].chunks.length,0);
 h.client.stop();
});
test("missing commit status is unavailable, never another import or source release",async()=>{
 const h=harness("missing");await h.client.initialize("runtime");
 await assert.rejects(h.client.send("op","same","player",{}),UploadUncertain);
 assert.equal(h.jobs,1);assert.equal(h.calls.includes("abort"),false);
 h.client.stop();
});
test("concurrent delivery of the same operation shares one upload",async()=>{
 const h=harness();await h.client.initialize("runtime");
 const first=h.client.send("op","same","player",{});
 const second=h.client.send("op","same","player",{});
 assert.equal(first,second);
 await first;assert.equal(h.jobs,1);
 h.client.stop();
});

test("repeated startup handshake resumes the receiver's sequence checkpoint",async()=>{
 const sequences=[];
 const client=new UploadSessions(async(action,q)=>{
  if(action==="initialize") return {version:1,success:true,epoch:q.epoch,highWater:40};
  if(action==="begin") {sequences.push(q.sequence);return {version:1,success:true,state:"accepted",jobId:"retained"};}
  throw Error(action);
 });
 await client.initialize("boot");await client.send("op","fixture","player",{});
 assert.deepEqual(sequences,[41]);client.stop();
});

test("unresolved cleanup retries receiving bytes but never aborts an accepted job",async()=>{
 for(const state of ["receiving","accepted"]) {
  const calls=[],reports=[];let unreachable=true;
  const client=new UploadSessions(async(action,q)=>{
   calls.push(action);
   if(action==="initialize") return {version:1,success:true,epoch:q.epoch};
   if(action==="begin") return {version:1,success:true,state:"receiving",attemptId:q.attemptId};
   if(action==="chunk") throw Error("connection interrupted");
   if(action==="status"&&unreachable) throw Error("status unreachable");
   if(action==="status") return {version:1,success:true,state,jobId:state==="accepted"?"job_1":undefined};
   if(action==="abort") return {version:1,success:true,state:"aborted"};
   throw Error(action);
  }, message=>reports.push(message));
  await client.initialize("boot");
  await assert.rejects(client.send("op","fixture","player",{}),/connection interrupted/);
  await client.reconcileCleanup();assert.equal(reports.length,1,"identical failures must not flood logs");
  unreachable=false;await client.reconcileCleanup();
  assert.equal(calls.filter(a=>a==="abort").length,state==="receiving"?1:0);
  assert.equal(calls.includes("commit"),false);client.stop();
 }
});
