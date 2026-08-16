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

const STRING_LITERAL_RE = /"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*'/g;
const CONDITION_RE = /\b(?:if|elseif)\s+([\s\S]+?)\s+then\b/g;
const OPERAND_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.([A-Za-z_][A-Za-z0-9_]*)$/;

function blankStringLiterals(line) {
	return line.replace(STRING_LITERAL_RE,
		literal => literal[0] + "\u0001".repeat(literal.length - 2) + literal[literal.length - 1]);
}

function methodReferenceConditions(source) {
	const stripped = source.split(/\r?\n/)
		.map(line => blankStringLiterals(line).replace(/--.*$/, ""))
		.join("\n");
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
	].join("\n"));
	assert.deepEqual(clean, [],
		"calling the method, reading an attribute, a plain field and a commented-out line must NOT be flagged");
});

test("the lexer ignores string literals (a quoted -- or if must not steer the scan)", () => {
	const quoted = methodReferenceConditions([
		"  log(\"placed item -- not in IMPORT_PHASES, so nothing ran\")",
		"  local msg = \"held items may be capped if the dest is under-researched\"",
		"  if data.bar and entity.get_inventory then",
	].join("\n"));
	assert.deepEqual(quoted.map(hit => hit.line), [3],
		"a '--' inside a string literal must not truncate the line, and an 'if' inside a string literal must "
		+ "not start a condition scan that swallows the real one below it. module/ carries both shapes today "
		+ "(measured 2026-08-16: 2 lines with a quoted '--', 3 with a quoted 'if'), so a lexer that mis-scans "
		+ "them would hide a real site rather than report it");
});

test("known limitations of this rule, kept honest and re-checkable", () => {
	assert.deepEqual(methodReferenceConditions("  if entity.get_recipe ~= nil then"), [],
		"NAMED GAP: `<recv>.<method> ~= nil` is the same vacuous check and is NOT flagged. Extending the rule "
		+ "to nil-comparisons was measured over module/ on 2026-08-16 and produces a false positive at "
		+ "interfaces/commands/test-entity.lua:85 (`result.debug_info.can_place_entity ~= nil`), where the "
		+ "receiver is a plain result table whose field merely shares a name with LuaEntity.can_place_entity. "
		+ "The extension was rejected rather than ship a rule that cries wolf; close the gap only together "
		+ "with receiver typing, and re-measure before doing so");

	assert.equal(methodReferenceConditions("  if mock.get_transport_line then").length, 1,
		"KNOWN FALSE-POSITIVE CLASS: the rule is keyed on the member NAME, not on the receiver's class, so a "
		+ "plain Lua table that genuinely holds a function under a LuaEntity method name WOULD be flagged here "
		+ "(the selftest mocks at interfaces/remote/belt-side-restore-selftest.lua:535-537 build exactly such "
		+ "tables, though none is currently tested for truth in a condition). module/ contains zero of these "
		+ "today, which is why the rule ships name-keyed; if one ever appears, prefer restructuring the mock "
		+ "check over weakening this pin");
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
		"a method is a member of the CLASS, so this reference is truthy on every valid entity and the "
		+ "condition gates nothing (measured 2026-08-15 at 2.1.11: type(transport_belt.get_recipe) is "
		+ "'function' — a transport belt is not a CraftingMachine, so the read succeeds on the very entity "
		+ "whose call raises 'Entity is not crafting-machine.'). Inside an and-chain it is worse than "
		+ "useless: the real gate is whatever else is in the chain, and the dead clause reads as a type "
		+ "check that was never performed. Call the method and gate on its RESULT; where a routed or "
		+ "caller-supplied type cannot answer, pcall the call. GameUtils.TYPE_TO_CATEGORY routes foreign "
		+ "types into a handler, so 'only my own type reaches this line' is not a property of the handler:\n"
		+ hits.join("\n"));
});
