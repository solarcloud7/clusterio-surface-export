import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { applyOnce, classifyExit, insideTree, luaMutationRun, normalizeCases, summarize } from "../../tools/tests/testkit/lua-mutation.mjs";

const MODULE = "docker/seed-data/external_plugins/surface_export/module/";
const valid = { name: "guard", file: MODULE + "core/gateway.lua", find: "if a then", replace: "if true then", tests: ["tests/lua/gateway-route.lua"] };

test("a mutation applies only when the find string occurs exactly once", () => {
	assert.deepEqual(applyOnce("x if a then y", "if a then", "if true then"), { applied: true, source: "x if true then y" });
	assert.deepEqual(applyOnce("no match", "if a then", "z"), { applied: false, occurrences: 0 });
	assert.deepEqual(applyOnce("if a then if a then", "if a then", "z"), { applied: false, occurrences: 2 });
	assert.equal(applyOnce("keep $& literal", "$&", "$1").source, "keep $1 literal", "replacement text is literal");
});

test("cases are validated before anything runs", () => {
	assert.deepEqual(normalizeCases(valid)[0].tests, valid.tests);
	assert.deepEqual(normalizeCases({ ...valid, tests: "tests/lua/x.lua" })[0].tests, ["tests/lua/x.lua"]);
	assert.equal(normalizeCases({ ...valid, replace: "" })[0].replace, "", "deleting a guard is a mutation");
	for (const [change, reason] of [
		[{ find: "" }, /"find"/],
		[{ replace: undefined }, /"replace"/],
		[{ replace: "if a then" }, /identical/],
		[{ tests: [] }, /"tests"/],
		[{ tests: ["../outside.lua"] }, /"tests"/],
		[{ file: "tools/tests/testkit/cli.mjs" }, /not a Lua file/],
		[{ file: "docs/readme.lua" }, /not a Lua file/],
	]) assert.throws(() => normalizeCases({ ...valid, ...change }), reason, JSON.stringify(change));
	assert.throws(() => normalizeCases([valid, valid]), /duplicate/);
	assert.throws(() => normalizeCases([]), /no mutation cases/);
});

test("only an all-killed run is ok", () => {
	assert.equal(summarize([{ verdict: "KILLED" }, { verdict: "KILLED" }]).ok, true);
	for (const verdict of ["SURVIVED", "INVALID", "NOT APPLIED"]) {
		assert.equal(summarize([{ verdict: "KILLED" }, { verdict }]).ok, false, verdict);
	}
});

test("traversal, absolute and backslash paths are refused before anything is resolved", () => {
	for (const file of [MODULE + "../../../../victim.lua", MODULE + "core/../../../../../../victim.lua", "/etc/victim.lua",
		"C:/victim.lua", MODULE.replace(/\//g, "\\") + "core\\gateway.lua", MODULE + "./core/gateway.lua", MODULE + "core//gateway.lua"]) {
		assert.throws(() => normalizeCases({ ...valid, file }), /not a Lua file/, file);
	}
	for (const test of ["tests/../../victim.lua", "tests/lua/../../../victim.lua", "/tests/lua/x.lua", "tests\\lua\\x.lua"]) {
		assert.throws(() => normalizeCases({ ...valid, tests: [test] }), /"tests"/, test);
	}
	const root = path.join(tmpdir(), "export-root", "tree");
	assert.equal(insideTree(root, "tests/lua/x.lua"), path.join(root, "tests/lua/x.lua"));
	for (const escape of ["../x.lua", "tests/../../x.lua", path.resolve(root, "..", "x.lua")]) {
		assert.throws(() => insideTree(root, escape), /outside the isolated export/, escape);
	}
});

test("only a completed Lua failure counts; Docker failures give no verdict", () => {
	assert.equal(classifyExit({ status: 0 }, "t"), "pass");
	assert.equal(classifyExit({ status: 1 }, "t"), "fail");
	for (const result of [{ status: 125, stderr: "daemon error" }, { status: 126 }, { status: 127 }, { status: 137 },
		{ status: null, signal: "SIGKILL" }, { status: 1, signal: "SIGTERM" }, { error: new Error("spawn docker ENOENT") }]) {
		assert.throws(() => classifyExit(result, "t"), /docker/, JSON.stringify(result));
	}
});

test("a Docker failure on a mutant fails the run instead of counting as a kill", t => {
	const repo = mkdtempSync(path.join(tmpdir(), "lua-mutation-repo-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	const put = (file, text) => { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); writeFileSync(path.join(repo, file), text); };
	put(MODULE + "core/gateway.lua", "local guarded = true\nif a then return end\n");
	put("tests/lua/gateway-route.lua", "print('ok')\n");
	put("tools/clusterio/lua-tests.Dockerfile", "FROM scratch\n");
	put("docker/seed-data/mods-src/surfexp_gateways/data.lua", "-- fixture\n");
	const git = (...args) => spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { cwd: repo, encoding: "utf8" });
	git("init", "-q"); git("add", "."); git("commit", "-qm", "fixture");
	const dockerRuns = [];
	const exec = (command, args, options) => {
		if (command !== "docker") return spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
		if (args[0] === "build") return { status: 0, stdout: "", stderr: "" };
		dockerRuns.push(args.at(-1));
		if (args.includes("luac5.2")) return { status: 0, stdout: "", stderr: "" };
		return dockerRuns.length === 1 ? { status: 0, stdout: "ok", stderr: "" } : { status: 125, stdout: "", stderr: "docker: Error response from daemon" };
	};
	const lines = [];
	assert.throws(() => luaMutationRun(valid, { repo, exec, log: line => lines.push(line) }), /exit 125.*no verdict is credited/s);
	assert.ok(!lines.some(line => line.startsWith("KILLED")), lines.join("\n"));
	assert.equal(readFileSync(path.join(repo, MODULE, "core/gateway.lua"), "utf8"), "local guarded = true\nif a then return end\n", "the working tree is untouched");
});

test("the committed routing cases are well formed", () => {
	const cases = normalizeCases(JSON.parse(readFileSync(new URL("../lua/mutations/cross-instance-routing.json", import.meta.url), "utf8")));
	assert.ok(cases.length >= 20);
});
