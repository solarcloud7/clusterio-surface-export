const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LuaInterface } = require("../dist/node/lib/lua-interface");
const base = { batchSize: 50, maxConcurrentJobs: 3, showProgress: false, debugMode: true, maxExportCacheSize: 10 };

test("belt batching configuration is separate from entity batching and expensive trace is opt-in", async () => {
	const calls = [];
	const lua = new LuaInterface({ sendRcon: async command => { calls.push(command); return ""; } }, {});
	await lua.configure(base);
	assert.match(calls[0], /batch_size=50,/);
	assert.match(calls[0], /belt_batch_size=500, belt_trace=false,/);
	await lua.configure({ ...base, beltBatchSize: 125, beltTrace: true });
	assert.match(calls[1], /belt_batch_size=125, belt_trace=true,/);
});

test("invalid belt budgets never reach RCON", async () => {
	let sends = 0;
	const lua = new LuaInterface({ sendRcon: async () => { sends++; return ""; } }, {});
	for (const beltBatchSize of [0, -1, 1.5, NaN, Infinity, 1000001]) {
		await assert.rejects(lua.configure({ ...base, beltBatchSize }), /belt_batch_size must be an integer/);
	}
	assert.equal(sends, 0);
});

test("general debug does not implicitly enable destination snapshots over RCON", async () => {
	const calls = [];
	const lua = new LuaInterface({ sendRcon: async command => { calls.push(command); return ""; } }, {});
	await lua.configure(base);
	await lua.configure({ ...base, debugDestinationSnapshot: true });
	await lua.configure({ ...base, debugDestinationSnapshot: false });
	assert.match(calls[0], /debug_mode=true, debug_destination_snapshot=false,/);
	assert.match(calls[1], /debug_destination_snapshot=true,/);
	assert.match(calls[2], /debug_destination_snapshot=false,/);
});
