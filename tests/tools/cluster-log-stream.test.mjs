import { test } from "node:test";
import assert from "node:assert/strict";
import { lineCollector, readCommandLines } from "../../tools/clusterio/read-cluster-logs.mjs";

test("log reader streams beyond the old 8 MiB buffer and retains only bounded, redacted matches", async () => {
	const result = await readCommandLines(process.execPath, ["-e", `
for(let i=0;i<10000;i++) process.stdout.write('error '+i+' token="secret" '+'x'.repeat(1000)+'\\n');
process.stdout.write('error final 雪');`], { pattern: /error/, lines: 3 });
	assert.equal(result.status, 0);
	assert.equal(result.matches.length, 3);
	assert.match(result.matches[0], /^error 9998/);
	assert.equal(result.matches.at(-1), "error final 雪");
	assert.ok(result.matches.every(line => line.length <= 800 && !line.includes("secret")));
});

test("split CRLF records and oversized records cannot leak partial credentials", () => {
	const lines = [], collector = lineCollector(line => lines.push(line), 20);
	collector.push("first\r"); collector.push("\npassword=secret");
	collector.push("x".repeat(1000)); collector.push("more\nlast");
	assert.equal(collector.finish(), 1);
	assert.deepEqual(lines, ["first", "last"]);
});

test("log filtering uses diagnostic fields, not HTTP referrers or secret metadata", async () => {
	const records = [
		'[cluster-log] ' + JSON.stringify({ level: "http", message: "GET /static/icon.png", meta: { referer: "/surface-export" } }),
		JSON.stringify({ level: "info", message: "export completed" }),
	];
	const result = await readCommandLines(process.execPath, ["-e", `for (const record of ${JSON.stringify(records)}) console.log(record);`], { pattern: /export/ });
	assert.equal(result.status, 0);
	assert.deepEqual(result.matches, ["info export completed"]);
});

test("stderr, nonzero exits, missing executables and timeouts remain visible", async () => {
	const failure = await readCommandLines(process.execPath, ["-e", "console.error('error password=secret'); process.exitCode=7"]);
	assert.equal(failure.status, 7);
	assert.match(failure.matches[0], /REDACTED/);
	const missing = await readCommandLines("nonexistent-surface-export-command", []);
	assert.ok(missing.error);
	const timeout = await readCommandLines(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 250 });
	assert.notEqual(timeout.status, 0);
	assert.ok(timeout.signal || timeout.error);
});
