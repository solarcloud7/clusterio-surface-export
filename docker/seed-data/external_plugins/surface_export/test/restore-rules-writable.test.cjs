"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const deserializerPath = path.join(__dirname, "..", "module", "core", "deserializer.lua");
const indexPath = path.join(__dirname, "..", "scripts", "factorio-api-index.json");
const source = fs.readFileSync(deserializerPath, "utf8");
const apiIndex = JSON.parse(fs.readFileSync(indexPath, "utf8"));

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
const propOf = rule => (rule.match(/prop\s*=\s*"([^"]+)"/) || [])[1] || fieldOf(rule);
const entityMembers = apiIndex.classes && apiIndex.classes.LuaEntity;

const directWrites = [...new Set([...source.matchAll(/\bentity\.(\w+)\s*=\s*[^=]/g)].map(hit => hit[1]))];

test("the rule table and the API index both parse (a broken reader must not pass vacuously)", () => {
	assert.ok(rules.length >= 20, `expected the rule table to carry many rows, parsed ${rules.length}`);
	const named = rules.filter(rule => fieldOf(rule) !== undefined);
	assert.equal(named.length, rules.length, "every parsed row must carry a field name");
	assert.ok(entityMembers, `the vendored index must carry LuaEntity (read ${indexPath})`);
	assert.ok(Object.keys(entityMembers).length >= 100,
		`LuaEntity resolved ${Object.keys(entityMembers).length} members — the index is malformed and every `
		+ "membership check below would pass or fail for the wrong reason");
	assert.equal(entityMembers.previous_recipe && entityMembers.previous_recipe.write, false,
		"previous_recipe must still read as a read-only attribute — if the index says otherwise, this test's "
		+ "notion of writability has drifted and its verdicts mean nothing");
});

test("every restore-rule property EXISTS on LuaEntity at the pin", () => {
	const missing = rules
		.map(propOf)
		.filter(prop => !entityMembers[prop]);
	assert.deepEqual(missing, [],
		`no such member on LuaEntity at ${apiIndex.application_version}: ${missing.join(", ")}. The rule's read `
		+ "probe throws on every entity, so the row never fires and the captured field is never restored. Look "
		+ "the name up with `testkit api LuaEntity.<member>` and use the real one, or delete the rule.");
});

test("every restore-rule property is WRITABLE on LuaEntity at the pin", () => {
	const readOnly = rules
		.map(propOf)
		.filter(prop => entityMembers[prop])
		.filter(prop => entityMembers[prop].kind !== "attribute" || !entityMembers[prop].write);
	assert.deepEqual(readOnly, [],
		`read-only at ${apiIndex.application_version}: ${readOnly.join(", ")}. Assigning to it throws `
		+ "(\"LuaEntity::<name> is read only.\"), which safe_call swallows into a log line, so the property is "
		+ "never restored and the transfer reports no failure. Delete the rule and its export-side capture.");
});

test("the direct-write scan sees the writes it is meant to police", () => {
	assert.ok(directWrites.length >= 20,
		`scanned ${directWrites.length} direct entity writes — the scan is broken and would pass vacuously`);
	for (const known of ["health", "direction", "tick_grown"]) {
		assert.ok(directWrites.includes(known), `the scan must see entity.${known}`);
	}
});

test("every directly written entity property is restorable at the pin", () => {
	const offenders = directWrites
		.filter(prop => !entityMembers[prop]
			|| entityMembers[prop].kind !== "attribute" || !entityMembers[prop].write);
	assert.deepEqual(offenders, [],
		`not restorable at ${apiIndex.application_version}: ${offenders.join(", ")}. A write to a missing or `
		+ "read-only member throws, and every such write here sits inside safe_call, so the failure becomes a "
		+ "log line and the property silently never transfers. Look the name up with `testkit api "
		+ "LuaEntity.<member>`. This arm covers `entity.<prop> =` in deserializer.lua only; a nested write such "
		+ "as `entity.train.schedule` is out of scope by construction, since the receiver it captures is `train`.");
});
