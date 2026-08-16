"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const moduleDir = path.join(__dirname, "..", "module");
const apiIndex = require("../scripts/factorio-api-index.json");

const LUA_ENTITY_METHODS = new Set(Object.entries(apiIndex.classes.LuaEntity)
	.filter(([, member]) => member.kind === "method")
	.map(([name]) => name));

const CONDITION_RE = /\b(?:if|elseif)\s+([\s\S]+?)\s+then\b/g;
const OPERAND_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.([A-Za-z_][A-Za-z0-9_]*)$/;

function methodReferenceConditions(source) {
	const stripped = source.split(/\r?\n/).map(line => line.replace(/--.*$/, "")).join("\n");
	const found = [];
	CONDITION_RE.lastIndex = 0;
	let match;
	while ((match = CONDITION_RE.exec(stripped)) !== null) {
		const line = stripped.slice(0, match.index).split("\n").length;
		for (const operand of match[1].split(/\s+(?:and|or)\s+/)) {
			const bare = operand.trim().replace(/^not\s+/, "").replace(/^\(+/, "").replace(/\)+$/, "");
			const named = OPERAND_RE.exec(bare);
			if (named && LUA_ENTITY_METHODS.has(named[1])) {
				found.push({ line, member: named[1], text: match[1].replace(/\s+/g, " ") });
			}
		}
	}
	return found;
}

function luaFiles(dir) {
	const out = [];
	for (const name of fs.readdirSync(dir)) {
		const full = path.join(dir, name);
		if (fs.statSync(full).isDirectory()) out.push(...luaFiles(full));
		else if (name.endsWith(".lua")) out.push(full);
	}
	return out;
}

const FILES = luaFiles(moduleDir);

test("the pin reads real data and the detector still detects (no vacuous pass)", () => {
	assert.ok(LUA_ENTITY_METHODS.size >= 150,
		`expected LuaEntity's full method roster from the vendored index, parsed ${LUA_ENTITY_METHODS.size} — `
		+ "an index whose shape changed would disarm this pin silently");
	for (const known of ["get_recipe", "get_inventory", "get_transport_line", "set_fluid_filter"]) {
		assert.ok(LUA_ENTITY_METHODS.has(known),
			`LuaEntity method '${known}' must be parsed from scripts/factorio-api-index.json`);
	}
	assert.ok(FILES.length >= 100, `expected the module tree, walked ${FILES.length} lua files`);

	const planted = methodReferenceConditions([
		"  if entity.get_recipe then",
		"  if not entity.get_inventory then",
		"  elseif created_entity.get_transport_line then",
		"  if data.bar and entity.get_inventory then",
		"  if data.fluid_filter and entity.set_fluid_filter then",
		"  if data.recipe or entity.get_recipe then",
		"  if entity_data.specific_data and entity_data.specific_data.items",
		"     and created_entity.valid and created_entity.get_transport_line then",
	].join("\n"));
	assert.deepEqual(planted.map(hit => hit.line), [1, 2, 3, 4, 5, 6, 7],
		"the detector must flag a method reference standing as the whole condition AND as any operand of an "
		+ "and/or chain, including a chain wrapped across lines — a regex that quietly stops matching turns "
		+ "this pin green forever");

	const clean = methodReferenceConditions([
		"  local recipe = entity.get_recipe()",
		"  if entity.get_recipe() then",
		"  if data.recipe and entity.get_recipe() then",
		"  if data.bar and inv.valid then",
		"  if data.recipe then",
		"  if entity.crafting_progress then",
		"  if data.bar and entity.crafting_progress then",
		"  -- if data.bar and entity.get_inventory then",
		"  local mock = { get_transport_line = function() return line end }",
	].join("\n"));
	assert.deepEqual(clean, [],
		"calling the method, reading an attribute, a plain field, a commented-out line and a table field that "
		+ "genuinely holds a function must NOT be flagged");
});

test("no Lua module tests a LuaEntity method reference for truth", () => {
	const hits = [];
	for (const file of FILES) {
		const rel = path.relative(moduleDir, file).replace(/\\/g, "/");
		for (const hit of methodReferenceConditions(fs.readFileSync(file, "utf8"))) {
			hits.push(`${rel}:${hit.line}: [${hit.member}] if ${hit.text} then`);
		}
	}
	assert.deepEqual(hits, [],
		"a method is a member of the CLASS, so this reference is truthy on every entity and the condition "
		+ "gates nothing (measured 2026-08-15 at 2.1.11: type(transport_belt.get_recipe) is 'function', and "
		+ "calling it raises 'Entity is not crafting-machine.'). Inside an and-chain it is worse than useless: "
		+ "the real gate is whatever else is in the chain, and the dead clause reads as a type check that was "
		+ "never performed. Call the method and gate on its RESULT; where a routed or caller-supplied type "
		+ "cannot answer, pcall the call. GameUtils.TYPE_TO_CATEGORY routes foreign types into a handler, so "
		+ "'only my own type reaches this line' is not a property of the handler:\n"
		+ hits.join("\n"));
});
