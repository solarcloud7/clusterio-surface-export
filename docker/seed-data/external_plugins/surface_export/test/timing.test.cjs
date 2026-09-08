const { test } = require("node:test");
const assert = require("node:assert/strict");
const { TimingClock, parseProfiler, parseLuaTiming, timingContext, timed, timedSync } = require("../dist/node/lib/timing");
const { mergeTiming, clockGroups, elapsed } = require("../dist/node/shared/timing");

const meta = { v: 1, id: "entities", jobId: "import_1", operationId: "1:export", owner: "destination-lua",
	stage: "entities", kind: "execution", status: "completed", revision: 2, startTick: 100, endTick: 100, ticksElapsed: 0 };
const line = values => `123.000 Script @test.lua:1: [SE_TIMING_V1]${JSON.stringify(meta)}\t${values.join("\t")}`;

test("Factorio 2.1.17 rendered profiler format preserves milliseconds and exact zero ticks", () => {
	const record = parseLuaTiming(line(["Duration: 0.000000ms", "Duration: 0.397571ms", "Duration: 0.397571ms"]), 2, "boot1");
	assert.equal(record.executionMs, .397571); assert.equal(elapsed(record), .397571);
	assert.equal(record.ticksElapsed, 0); assert.equal(record.endTick, 100);
	assert.ok(record.raw.includes("Duration: 0.397571ms"));
});
test("profiler units are explicit; absent, malformed and nonfinite readings stay unavailable", () => {
	assert.equal(parseProfiler("Duration: 1.5s"), 1500);
	assert.equal(parseProfiler("Duration: 300us"), .3);
	for (const value of ["", "0", "NaNms", "Infinityms", "-1ms", "1e999ms", "3 ticks"]) assert.equal(parseProfiler(value), null);
	const record = parseLuaTiming(line(["-", "broken", "-"]), 2, "boot1");
	assert.equal(record.executionMs, null); assert.equal(record.endMs, null); assert.ok(record.error);
	assert.equal(parseLuaTiming("arbitrary game chat", 2, "boot1"), null);
});
test("monotonic measurement does not use or change UTC and does not include later work", () => {
	let time = 10; const records = [];
	const clock = new TimingClock("op", "controller", record => records.push(record), () => time);
	const span = clock.start("request", "round-trip"); time += 43; clock.stop(span); time += 50; clock.stop(span);
	assert.equal(elapsed(records.at(-1)), 43); assert.equal(records.length, 2);
	assert.equal(records.at(-1).executionMs, null);
});
test("communication delay and local execution remain separate nested measurements", async () => {
	let time = 0; const records = [];
	const clock = new TimingClock("op", "instance", record => records.push(record), () => time);
	await timingContext.run(clock, () => timed("RCON", "round-trip", async () => {
		time += 30; timedSync("serialization", () => { time += 4; }); time += 20;
	}));
	assert.equal(elapsed(records.find(r => r.stage === "RCON" && r.status === "completed")), 54);
	assert.equal(records.find(r => r.stage === "serialization" && r.status === "completed").executionMs, 4);
});
test("late, duplicate and out-of-order updates do not replace finished measurements", () => {
	const done = parseLuaTiming(line(["0ms", "42ms", "40ms"]), 2, "boot1");
	let records = mergeTiming([], done);
	records = mergeTiming(records, { ...done, status: "running", endMs: null, revision: 1 });
	records = mergeTiming(records, done);
	assert.equal(records.length, 1); assert.equal(records[0].endMs, 42);
	records = mergeTiming(records, { ...done, clockId: "another-boot" });
	assert.equal(clockGroups(records).length, 2);
});
test("binding an early request republishes prior spans without duplicate identities", () => {
	let records = []; let time = 0;
	const clock = new TimingClock("pending", "controller", record => { records = mergeTiming(records, record); }, () => time);
	const span = clock.start("request"); clock.bind("1:export"); time = 5; clock.stop(span);
	assert.equal(records.length, 1); assert.equal(records[0].operationId, "1:export"); assert.equal(records[0].status, "completed");
});

test("UTC clock adjustments do not alter an in-flight monotonic span", () => {
	const original = Date.now; let now = 0, wall = 1_000_000; const records = [];
	try {
		Date.now = () => wall;
		const clock = new TimingClock("op", "controller", row => records.push(row), () => now);
		const span = clock.start("request"); wall -= 900_000; now = 12.5; clock.stop(span);
		assert.equal(elapsed(records.at(-1)), 12.5);
	} finally { Date.now = original; }
});

test("telemetry sink failure cannot change the operation result", async () => {
	const clock = new TimingClock("op", "controller", () => { throw new Error("test telemetry failure"); });
	assert.equal(await clock.measure("work", "execution", () => 42), 42);
	await assert.rejects(clock.measure("work", "execution", () => { throw new Error("actual work failure"); }), /actual work failure/);
});

test("malformed metadata and impossible boundaries never become waterfall geometry", () => {
	for (const value of [null, [], 1, { ...meta, kind: "ticks" }, { ...meta, revision: 1.5 }]) {
		assert.equal(parseLuaTiming(`[SE_TIMING_V1]${JSON.stringify(value)}\t0ms\t1ms\t1ms`, 1, "boot"), null);
	}
	assert.equal(elapsed(parseLuaTiming(line(["4ms", "1ms", "2ms"]), 2, "boot")), null);
	assert.equal(elapsed({ startMs: NaN, endMs: 1 }), null);
});
