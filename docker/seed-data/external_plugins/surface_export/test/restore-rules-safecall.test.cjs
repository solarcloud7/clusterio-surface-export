"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const deserializerPath = path.join(__dirname, "..", "module", "core", "deserializer.lua");
const source = fs.readFileSync(deserializerPath, "utf8");

function extractRules() {
	const marker = "local SIMPLE_RESTORE_RULES = {";
	const start = source.indexOf(marker);
	assert.notEqual(start, -1, "SIMPLE_RESTORE_RULES must exist in deserializer.lua");
	let depth = 0;
	let end = -1;
	for (let i = start + marker.length - 1; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) { end = i; break; }
		}
	}
	assert.notEqual(end, -1, "SIMPLE_RESTORE_RULES must be a closed table");
	const body = source.slice(start + marker.length, end);

	const rules = [];
	let rowDepth = 0;
	let rowStart = -1;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "{") {
			if (rowDepth === 0) rowStart = i;
			rowDepth++;
		} else if (body[i] === "}") {
			rowDepth--;
			if (rowDepth === 0) rules.push(body.slice(rowStart, i + 1));
		}
	}
	return rules;
}

const rules = extractRules();

const fieldOf = rule => (rule.match(/field\s*=\s*"([^"]+)"/) || [])[1];

test("the rule table parses into plausible rows (a broken parser must not pass vacuously)", () => {
	assert.ok(rules.length >= 20, `expected the rule table to carry many rows, parsed ${rules.length}`);
	const named = rules.filter(rule => fieldOf(rule) !== undefined);
	assert.equal(named.length, rules.length, "every parsed row must carry a field name");
	const typesGated = rules.filter(rule => /\btypes\s*=/.test(rule));
	assert.ok(typesGated.length >= 10,
		`expected many types-gated rows, parsed ${typesGated.length} — the types detection is broken`);
});

test("every types-gated restore rule carries safecall", () => {
	const offenders = rules
		.filter(rule => /\btypes\s*=/.test(rule))
		.filter(rule => !/\bsafecall\s*=\s*true\b/.test(rule))
		.map(fieldOf);
	assert.deepEqual(offenders, [],
		"a types-gated row skips the read-probe that incidentally guards probe-matched rows, so its write "
		+ "reaches the entity unguarded on the on_tick import path — where a throw kills the instance. "
		+ "Add safecall = true to: " + offenders.join(", "));
});

test("override_logistic_mode is restored before the saved_* rows it would otherwise consume", () => {
	const order = rules.map(fieldOf);
	const override = order.indexOf("override_logistic_mode");
	assert.notEqual(override, -1, "override_logistic_mode must be a restore rule");
	for (const saved of ["saved_request_filters", "saved_storage_filters",
		"saved_request_from_buffers", "saved_set_requests"]) {
		const index = order.indexOf(saved);
		assert.notEqual(index, -1, `${saved} must be a restore rule`);
		assert.ok(override < index,
			`${saved} must be restored AFTER override_logistic_mode: writing the override applies the saved `
			+ "requests into the now-live logistic point, which clears the saved table (measured 2.1.11), and "
			+ "the reverse order additionally trips an engine assertion on the destination");
	}
});

test("result_quality is restored after crafting_progress, which is what makes it writable", () => {
	const order = rules.map(fieldOf);
	const progress = order.indexOf("crafting_progress");
	const quality = order.indexOf("result_quality");
	assert.notEqual(progress, -1, "crafting_progress must be a restore rule");
	assert.notEqual(quality, -1, "result_quality must be a restore rule");
	assert.ok(progress < quality,
		"result_quality reads nil unless a craft is in progress, so writing it before crafting_progress is "
		+ "a silent no-op (measured 2.1.11)");
});
