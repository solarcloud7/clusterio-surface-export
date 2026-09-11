import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, projectInspection, STAGE_BUFFER_BYTES } from "../../tools/shared/command-evidence.mjs";
import { preflightRuntime, validatePreflight, expectations } from "../../tools/tests/preflight-runtime.mjs";
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
	for(const args of [["--acceptance"],["--runtime"],["--client-volume","v"],["--runtime","x","--build-config","y"],["--unknown"],
		["--runtime", "x", "--acceptance"], ["--build-config", "x", "--acceptance"],
		["--acceptance", "--acceptance"], ["--runtime", "x", "--runtime", "y"]]) assert.throws(()=>parseOptions(args));
	assert.equal(parseOptions(["--runtime","x","--acceptance","--client-volume","v"])["--acceptance"],true);
});

test("Docker inspection evidence excludes arbitrary environment and command fields", () => {
	const raw = JSON.stringify([{ Id: "a".repeat(64), Image: "sha256:" + "b".repeat(64), State: { Running: true, ExitCode: 0 },
		Config: { Env: ["SECRET_EXAMPLE=hunter2"], Cmd: ["another-secret"] }, Mounts: [{ Source: "private-path" }] }]);
	for (const args of [["inspect", "x"], ["container", "inspect", "x"], ["image", "inspect", "x"]]) {
		const evidence = projectInspection("docker", args, raw, "hunter2");
		assert.ok(!/hunter2|another-secret|private-path/.test(JSON.stringify(evidence)));
		assert.equal(JSON.parse(evidence.stdout)[0].running, true);
	}
	assert.ok(!projectInspection("docker", ["inspect", "x", "--format", "env"], '["SECRET_EXAMPLE=hunter2"]', "").stdout.includes("hunter2"));
});

test("redacted JSON preserves escaped text, arrays and non-secret field types", () => {
	const value = { message: 'cannot open "file" at C:\\path', n: 3, ok: true, nested: [{ password: { value: "secret" } }], token: 123 };
	const result = runCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(" + JSON.stringify(value) + "))"]);
	assert.deepEqual(JSON.parse(result.record.stdout), { ...value, nested: [{ password: "[REDACTED]" }], token: "[REDACTED]" });
});

test("verbose successful stages fit their explicit buffer while evidence stays bounded", () => {
	const result = runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"], { maxBuffer: STAGE_BUFFER_BYTES });
	assert.equal(result.stdout.length, 2 * 1024 * 1024);
	assert.equal(result.record.status, 0); assert.equal(result.record.stdoutTruncated, true);
	assert.equal(result.record.captureIncomplete, false);
});

test("repeated polling discards old evidence explicitly and retains the latest failure", t => {
	const dir = mkdtempSync(join(tmpdir(), "evidence-bounded-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "commands.jsonl"), options = { evidenceFile: file, maxEvidenceBytes: 16384 };
	for (let i = 0; i < 40; i++) runCommand(process.execPath, ["-e", "console.log('x'.repeat(2000))"], options);
	assert.throws(() => runCommand(process.execPath, ["-e", "console.error('last failure');process.exit(7)"], options));
	const raw = readFileSync(file), lines = raw.toString().trim().split("\n").map(JSON.parse);
	assert.ok(raw.length <= 16384); assert.equal(lines[0].type, "retention");
	assert.ok(lines[0].droppedRecords > 0);
	assert.equal(lines[0].droppedRecords + lines.length - 1, 41);
	assert.equal(lines.at(-1).status, 7); assert.match(lines.at(-1).stderr, /last failure/);
});

test("preflight output must match the role, version, discovery and every hardening field", () => {
	for (const role of ["host", "controller"]) {
		const expected = { schemaVersion: 1, role, ...expectations(role), localConfig: "verified" };
		assert.deepEqual(validatePreflight(JSON.stringify(expected), role), expected);
		for (const mutate of [r => r.role = "wrong", r => r.version = "wrong", r => r.plugins = [],
			r => r.localConfig = "unknown", r => r.unexpected = true,
			...Object.keys(expected.settings).map(key => r => r.settings[key] = true)]) {
			const value = structuredClone(expected); mutate(value);
			assert.throws(() => validatePreflight(JSON.stringify(value), role));
		}
		assert.throws(() => validatePreflight("{}", role));
	}
});

test("partial create is cleaned up; cleanup failures preserve the original error and ownership", () => {
	const runtime = { images: { controller: "sha256:" + "a".repeat(64), host: "sha256:" + "b".repeat(64) } };
	for (const failure of ["none", "inspect", "foreign-label", "remove"]) {
		const calls = []; let present = false;
		const command = (_file, args) => {
			calls.push(args);
			if (args[0] === "create") { present = true; throw Error("original create failure"); }
			if (args[0] === "ps") return { stdout: present ? (args[1] === "-a" ? "se-manual-cli-test1234-controller" : "container-id") : "" };
			if (args[1] === "inspect") { if (failure === "inspect") throw Error("ownership unavailable");
				return { stdout: failure === "foreign-label" ? "someone-else" : "se-manual-cli-test1234" }; }
			if (args[0] === "rm") { if (failure === "remove") throw Error("remove failed"); present = false; return { stdout: "" }; }
			throw Error("unexpected command");
		};
		assert.throws(() => preflightRuntime(runtime, undefined, { command, identity: () => "test1234" }), error => {
			assert.match(error.message, /original create failure/);
			assert.equal(error.cause.message, "original create failure");
			assert.equal(error.preflight.cleanup.success, failure === "none");
			return true;
		});
		assert.equal(calls.some(a => a[0] === "rm"), ["none", "remove"].includes(failure));
		assert.ok(!calls.some(a => a[0] === "start"));
	}
});
