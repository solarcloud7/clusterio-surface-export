"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("persistence guard rejects the retired global table and allows runtime-global settings", async () => {
	const {RULES} = await import("../scripts/lint-lua-invariants.mjs");
	const rule = RULES.find(item => item.id === "no-global-persistence-table");
	for (const code of ["global.jobs = {}", "global['jobs']", "global = {}", "local value = global.state"]) {
		assert.ok(rule.regex.test(code), code);
	}
	for (const code of ["settings.global['boarding']", "settings . global.boarding", "storage.global.value", "local globalCount = 1"]) {
		assert.ok(!rule.regex.test(code), code);
	}
});
