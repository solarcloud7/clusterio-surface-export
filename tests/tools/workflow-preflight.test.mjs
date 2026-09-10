import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../tools/shared/command-evidence.mjs";
import { readConfigList, localConfigArgs } from "../../tools/tests/clusterio-cli.mjs";
import { parseOptions, runStages } from "../../tools/verify-workflow.mjs";

test("command evidence retains both streams, redacts secrets before truncation, and omits argv", t => {
	const directory = mkdtempSync(join(tmpdir(), "evidence-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, "commands.jsonl");
	const result = runCommand(process.execPath, ["-e", "console.log('token=supersecret'); console.error('warning');"],
		{ label: "fixture", evidenceFile: file, tailChars: 64 });
	assert.match(result.stdout, /supersecret/, "callers still receive the unmodified data");
	const record = JSON.parse(readFileSync(file));
	assert.equal(record.stderr, "warning\n"); assert.match(record.stdout, /REDACTED/);
	assert.ok(!JSON.stringify(record).includes("supersecret")); assert.ok(!("args" in record));
	assert.ok(record.elapsedMs >= 0);
});
test("failed, timed out and oversized commands cannot look like successful complete captures", () => {
	assert.throws(() => runCommand(process.execPath, ["-e", "console.error('failed'); process.exit(7)"]), /failed \(7\)/);
	assert.throws(() => runCommand(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {timeout:100}), error => error.evidence.captureIncomplete);
	assert.throws(() => runCommand(process.execPath, ["-e", "console.log('x'.repeat(100000))"], {maxBuffer:1024}), error => error.evidence.captureIncomplete);
});
test("local and remote config reads have distinct formats and reject missing or duplicate fields", () => {
	assert.deepEqual(localConfigArgs("host", "/config.json", "host.name").slice(-3), ["config", "show", "host.name"]);
	assert.throws(() => localConfigArgs("control", "/config.json", "host.name"));
	assert.deepEqual(readConfigList('host.name "hello there"\nhost.id 3\n', ["host.name", "host.id"]), {"host.name":"hello there","host.id":3});
	for (const raw of ["", "host.id nope", "host.id 1\nhost.id 2"]) assert.throws(() => readConfigList(raw,["host.id"]));
});
test("verification stages run sequentially and stop at the first failure", async () => {
	const calls=[],report={stages:[]};
	await assert.rejects(runStages([["first", async()=>{calls.push(1);}], ["second", ()=>{calls.push(2);throw new Error("stop");}], ["third", ()=>calls.push(3)]],report,()=>{}), /stop/);
	assert.deepEqual(calls,[1,2]); assert.deepEqual(report.stages.map(s=>s.status),["passed","failed"]);
});
test("live acceptance is explicit and cannot run without its required inputs", () => {
	assert.deepEqual(parseOptions([]),{});
	for(const args of [["--acceptance"],["--runtime"],["--client-volume","v"],["--runtime","x","--build-config","y"],["--unknown"]]) assert.throws(()=>parseOptions(args));
	assert.equal(parseOptions(["--runtime","x","--acceptance","--client-volume","v"])["--acceptance"],true);
});
