const {test}=require("node:test");
const assert=require("node:assert/strict");
const {UploadSessions}=require("../dist/node/lib/upload-session");
const limits={chunkBytes:7,maxUploadBytes:100,maxBufferedBytes:200,maxSessions:2};
test("sender uses receiver chunk size and rejects oversized encoded payloads before begin",async()=>{
	const calls=[];
	const client=new UploadSessions(async(action,q)=>{
		calls.push({action,...q});
		if(action==="initialize")return {version:1,success:true,epoch:q.epoch,limits};
		return { version: 1, success: true, attemptId: q.attemptId, operationId: q.operationId,
			state: action === "commit" ? "accepted" : "receiving", jobId: action === "commit" ? "one" : undefined };
	});
	await client.initialize("boot");
	await client.send("op","fixture","player",{text:"x".repeat(20)});
	const chunks=calls.filter(q=>q.action==="chunk");
	assert.equal(chunks.length,5);assert.equal(chunks[0].data.length,7);
	assert.equal(calls.find(q=>q.action==="begin").totalChunks,5);
	assert.deepEqual(JSON.parse(chunks.map(c=>c.data).join("")),{text:"x".repeat(20)});
	const count=calls.length;
	await assert.rejects(client.send("large","fixture","player",{text:"x".repeat(100)}),/encoded-byte limit/);
	assert.equal(calls.length,count);client.stop();
});
test("missing or malformed receiver limits prevent any upload",async()=>{
	for(const invalid of [undefined,{}, {...limits,chunkBytes:0},{...limits,maxSessions:1.5},
		{...limits,maxUploadBytes:Infinity},{...limits,maxBufferedBytes:99},{...limits,chunkBytes:101}]) {
		const calls=[];
		const client = new UploadSessions(async (action, q) => {
			calls.push(action); return { version: 1, success: true, epoch: q.epoch, limits: invalid };
		});
		await assert.rejects(client.initialize("boot"),/upload limits/i);
		await assert.rejects(client.send("op","fixture","player",{}),/not ready/);
		assert.deepEqual(calls,["initialize"]);client.stop();
	}
});

test("oversized receiver chunks fail before admission even when their staging limits allow them", async () => {
	const calls = [];
	const client = new UploadSessions(async (action, q) => {
		calls.push(action);
		return { version: 1, success: true, epoch: q.epoch, limits: {
			chunkBytes: 64 * 1024 * 1024, maxUploadBytes: 512 * 1024 * 1024,
			maxBufferedBytes: 1024 * 1024 * 1024, maxSessions: 4,
		} };
	});
	try {
		await assert.rejects(client.initialize("boot"), /upload limits/i);
		await assert.rejects(client.send("op", "fixture", "player", {}), /not ready/);
		assert.deepEqual(calls, ["initialize"]);
	} finally { client.stop(); }
});
test("late initialization cannot replace a newer runtime or revive a stopped one",async()=>{
	for(const replacement of [true,false]) {
		const pending=[];
		const client=new UploadSessions((action,q)=>new Promise(resolve=>pending.push({q,resolve})));
		const old=client.initialize("old");
		if(replacement) {
			const newer = client.initialize("new");
			pending[1].resolve({ version: 1, success: true, epoch: "new", highWater: 20, limits });
			await newer;
		}else client.stop();
		pending[0].resolve({version:1,success:true,epoch:"old",highWater:3,limits:{...limits,chunkBytes:11}});
		await assert.rejects(old,/stopped or replaced/);
		assert.equal(client.epoch,replacement?"new":"");
		assert.equal(client.limits?.chunkBytes,replacement?7:undefined);client.stop();
	}
});
test("receiver session cap preserves same-operation deduplication",async()=>{
	let admit;
	const client=new UploadSessions(async(action,q)=>{
		if(action==="initialize")return {version:1,success:true,epoch:q.epoch,limits:{...limits,maxSessions:1}};
		if (action === "begin") return new Promise(resolve => admit = () => resolve({
			version: 1, success: true, attemptId: q.attemptId, operationId: q.operationId,
			state: "accepted", jobId: "existing",
		}));
		throw Error(action);
	});
	await client.initialize("boot");
	const first=client.send("one","fixture","player",{});
	assert.equal(client.send("one","fixture","player",{}),first);
	await assert.rejects(client.send("two","fixture","player",{}),/admission/);
	await new Promise(resolve=>setImmediate(resolve));admit();await first;client.stop();
});
test("a conflicting receiver receipt cannot adopt or abort another operation",async()=>{
	for(const state of ["accepted","receiving"]) {
		const calls=[];
		const client=new UploadSessions(async(action,q)=>{
			calls.push(action);
			if(action==="initialize")return {version:1,success:true,epoch:q.epoch,limits};
			if(action==="begin")return {version:1,success:false,error:"Upload metadata changed"};
			if (action === "status") return { version: 1, success: true, attemptId: q.attemptId,
				operationId: "foreign", state, jobId: state === "accepted" ? "foreign-job" : undefined };
			return {version:1,success:true,state:"aborted"};
		});
		await client.initialize("boot");
		await assert.rejects(client.send("mine","fixture","player",{}),/identity/);
		await client.reconcileCleanup();
		assert.deepEqual(calls,["initialize","begin","status"]);client.stop();
	}
});
