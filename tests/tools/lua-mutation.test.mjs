import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyOnce, normalizeCases, summarize } from "../../tools/tests/testkit/lua-mutation.mjs";

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

test("the committed routing cases are well formed", () => {
	const cases = normalizeCases(JSON.parse(readFileSync(new URL("../lua/mutations/cross-instance-routing.json", import.meta.url), "utf8")));
	assert.ok(cases.length >= 20);
});
