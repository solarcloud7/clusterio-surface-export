import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

function listedLuaTests() {
	return new Set([...workflow.matchAll(/^\s+lua5\.2 (tests\/lua\/[A-Za-z0-9_.-]+\.lua)\s*$/gm)].map(match => match[1]));
}

function nodeTestsRunWithLua() {
	const files = new Set();
	for (const line of workflow.matchAll(/^\s+SE_TEST_LUA=\S+ node --test (.*)$/gm)) {
		for (const path of line[1].matchAll(/(tests\/[A-Za-z0-9_./-]+\.test\.mjs)/g)) files.add(path[1]);
	}
	return [...files];
}

test("every Lua test file runs in CI, either listed in ci.yml or driven by a node test CI runs with SE_TEST_LUA", () => {
	const listed = listedLuaTests();
	const drivers = nodeTestsRunWithLua();
	assert.ok(listed.size > 0, "no `lua5.2 tests/lua/...` lines were found in ci.yml; the pattern no longer matches the workflow");
	assert.ok(drivers.length > 0, "no `SE_TEST_LUA=... node --test` line was found in ci.yml; the pattern no longer matches the workflow");
	const driverText = drivers.map(file => {
		assert.ok(existsSync(join(repoRoot, file)), `ci.yml runs ${file} with SE_TEST_LUA, but it does not exist`);
		return readFileSync(join(repoRoot, file), "utf8");
	}).join("\n");
	const unregistered = readdirSync(join(repoRoot, "tests", "lua"), { withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith(".lua"))
		.map(entry => entry.name)
		.filter(name => !listed.has(`tests/lua/${name}`) && !driverText.includes(name));
	assert.deepEqual(unregistered, [],
		"these tests/lua files never run in CI: add a `lua5.2 tests/lua/<name>.lua` line to the Lua step in ci.yml (run-lua-tests.ps1 reads the same list)");
});

test("every Lua test ci.yml lists exists", () => {
	const missing = [...listedLuaTests()].filter(path => !existsSync(join(repoRoot, path)));
	assert.deepEqual(missing, [], "ci.yml lists Lua tests that do not exist");
});
