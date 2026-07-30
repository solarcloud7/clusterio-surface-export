#!/usr/bin/env node
/**
 * lint-lua-syntax.mjs — Lua PARSE + UNDEFINED-GLOBAL guard for the save-patched module.
 *
 * Incident (2026-07-28): a module file referenced the module-table name `FixtureMeters` where the
 * local was actually named `M`. Nothing between "edit" and "deploy" parses Lua, so the defect
 * shipped through a full patch-and-reset and KILLED THE INSTANCE AT SAVE-LOAD (error() during
 * save-patching = headless server death, exit 255 — see the error-in-event-context memory). The
 * only detection was the server dying. A parse + undefined-global pass catches that whole class
 * in under a second, before any deploy.
 *
 * Two rules:
 *   R1 (parse):            every .lua file must parse as Lua 5.2 (Factorio's dialect).
 *   R2 (undefined-global): every global READ or WRITE must name a known engine/stdlib global.
 *                          Locals, upvalues, and require()d module tables never appear as globals,
 *                          so a misspelled local/module-table name (`FixtureMeters` vs `M`)
 *                          surfaces here as an undefined global.
 *
 * Scope: every .lua under the plugin's module/ subtree (control stage), plus the gateway mod
 * sources under docker/seed-data/mods-src when running from a full checkout (data stage — its
 * whitelist additionally carries `data` and `mods`).
 *
 * Escape hatch: NONE by design. A legitimate new engine global belongs in the whitelist below —
 * a central, reviewable diff — not in a scattered per-line annotation. If the whitelist is wrong,
 * fix the whitelist.
 *
 * Run:   node scripts/lint-lua-syntax.mjs        (also: npm run lint:lua-syntax)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import luaparse from "luaparse";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const MODULE_DIR = join(PLUGIN_DIR, "module");
// scripts/ -> plugin -> external_plugins -> seed-data -> docker -> repo root
const REPO_ROOT = join(PLUGIN_DIR, "..", "..", "..", "..");
const MODS_SRC_DIR = join(REPO_ROOT, "docker", "seed-data", "mods-src");

// Factorio 2.0 control-stage globals + the Lua 5.2 subset Factorio keeps. This list is the whole
// policy: a name not on it is a violation, full stop. Extending it is a reviewed change to THIS
// file. Deliberately absent: `global` (renamed to storage in 2.0 — lint:lua bans it), `os`/`io`
// (removed by the Factorio sandbox), `unpack` (5.2 moved it to table.unpack).
const CONTROL_STAGE_GLOBALS = new Set([
	// Factorio runtime
	"game", "script", "remote", "commands", "settings", "rcon", "rendering", "defines",
	"prototypes", "helpers", "storage",
	// Factorio-provided libraries/functions
	"serpent", "log", "localised_print", "table_size", "print",
	// Lua 5.2 base library (Factorio-retained subset)
	"assert", "collectgarbage", "error", "getmetatable", "ipairs", "load", "next", "pairs",
	"pcall", "rawequal", "rawget", "rawlen", "rawset", "require", "select", "setmetatable",
	"tonumber", "tostring", "type", "xpcall", "_G", "_VERSION",
	// Lua 5.2 standard libraries
	"table", "string", "math", "bit32", "debug", "coroutine",
]);

// Data-stage files (mods-src) additionally see the prototype-definition globals.
const DATA_STAGE_EXTRAS = new Set(["data", "mods", "feature_flags"]);

function collectLuaFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) out.push(...collectLuaFiles(full));
		else if (name.endsWith(".lua")) out.push(full);
	}
	return out;
}

function lintFile(file, whitelist) {
	const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
	const source = readFileSync(file, "utf8");
	let ast;
	try {
		ast = luaparse.parse(source, { luaVersion: "5.2", scope: true, locations: true, comments: false });
	} catch (err) {
		const line = err.line ?? "?";
		const column = err.column ?? "?";
		return [{ file: relPath, line, column, rule: "parse", message: err.message }];
	}
	const violations = [];
	// luaparse's scope tracking (scope: true) collects every global VARIABLE reference — reads and
	// writes, one entry per name — on ast.globals. Property names, table keys, and goto labels are
	// names-but-not-variables and never appear there, so no AST walk is needed.
	for (const ref of ast.globals ?? []) {
		if (whitelist.has(ref.name)) continue;
		violations.push({
			file: relPath,
			line: ref.loc.start.line,
			column: ref.loc.start.column + 1,
			rule: "undefined-global",
			message: `undefined global \`${ref.name}\` — not a local, not a required module table, and not a known engine global`,
		});
	}
	return violations;
}

function main() {
	if (!existsSync(MODULE_DIR)) {
		console.error(`lint:lua-syntax — FAILED: module/ not found at ${MODULE_DIR}. A missing scan surface is not a pass.`);
		process.exit(1);
	}
	const moduleFiles = collectLuaFiles(MODULE_DIR);
	// mods-src lives at the repo root; absent in the sanctioned plugin-only container mount
	// (same positive-path bypass as lint-test-grounding — reviewable, no ambient env-var).
	let modsSrcFiles = [];
	if (existsSync(MODS_SRC_DIR)) {
		modsSrcFiles = collectLuaFiles(MODS_SRC_DIR);
	} else if (/^([a-z]:)?\/clusterio\/external_plugins\//i.test(SCRIPT_DIR.replace(/\\/g, "/"))) {
		console.log("lint:lua-syntax — note: mods-src skipped (plugin-only container mount)");
	} else {
		console.error(`lint:lua-syntax — FAILED: mods-src not found at ${MODS_SRC_DIR} outside a container mount. A missing scan surface is not a pass.`);
		process.exit(1);
	}
	if (moduleFiles.length === 0) {
		// An EMPTY scan surface is as vacuous as a missing one (the "OK (0 checked)" trap).
		console.error("lint:lua-syntax — FAILED: module/ exists but contains zero .lua files. Ran 0 checks; refusing to report a pass.");
		process.exit(1);
	}

	const dataStageWhitelist = new Set([...CONTROL_STAGE_GLOBALS, ...DATA_STAGE_EXTRAS]);
	const violations = [
		...moduleFiles.flatMap((f) => lintFile(f, CONTROL_STAGE_GLOBALS)),
		...modsSrcFiles.flatMap((f) => lintFile(f, dataStageWhitelist)),
	];

	if (violations.length === 0) {
		console.log(`lint:lua-syntax — OK (${moduleFiles.length + modsSrcFiles.length} Lua files parsed, undefined-global check clean)`);
		process.exit(0);
	}
	console.error(`lint:lua-syntax — ${violations.length} violation(s):\n`);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}:${v.column}  [${v.rule}]`);
		console.error(`    ${v.message}\n`);
	}
	console.error(
		"A parse failure here would have killed the instance at save-load. For undefined globals: fix the name, "
			+ "or — if it is a real engine global — add it to the whitelist in scripts/lint-lua-syntax.mjs (reviewed change).",
	);
	process.exit(1);
}

main();
