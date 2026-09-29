const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatUptime, uptimeMs } = require("../dist/node/shared/uptime");

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;

test("uptime shows the two largest non-zero units", () => {
	assert.equal(formatUptime(DAY + 2 * HOUR + 30 * MIN + 50 * SEC), "1 day 2 hours");
	assert.equal(formatUptime(3 * DAY + 45 * MIN), "3 days 45 min");
	assert.equal(formatUptime(2 * HOUR + 5 * MIN + 9 * SEC), "2 hours 5 min");
	assert.equal(formatUptime(1 * HOUR), "1 hour");
	assert.equal(formatUptime(12 * MIN + 1 * SEC), "12 min 1 sec");
	assert.equal(formatUptime(45 * SEC + 900), "45 sec");
	assert.equal(formatUptime(0), "0 sec");
});

test("uptime rejects values that are not durations", () => {
	for (const value of [null, undefined, NaN, -1, "5"]) assert.equal(formatUptime(value), "");
});

test("uptime is measured from a positive start time that is not in the future", () => {
	assert.equal(uptimeMs(1000, 61_000), 60_000);
	for (const started of [0, null, undefined, NaN, 70_000]) assert.equal(uptimeMs(started, 61_000), null, String(started));
});
