#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import luaparse from "./vendor/luaparse.cjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const MODULE_DIR = join(PLUGIN_DIR, "module");
const REPO_ROOT = join(PLUGIN_DIR, "..", "..", "..", "..");
const MODS_SRC_DIR = join(REPO_ROOT, "docker", "seed-data", "mods-src");

const CONTROL_STAGE_GLOBALS = new Set([
	"game", "script", "remote", "commands", "settings", "rcon", "rendering", "defines",
	"prototypes", "helpers", "storage",
	"serpent", "log", "localised_print", "table_size", "print",
	"assert", "collectgarbage", "error", "getmetatable", "ipairs", "load", "next", "pairs",
	"pcall", "rawequal", "rawget", "rawlen", "rawset", "require", "select", "setmetatable",
	"tonumber", "tostring", "type", "xpcall", "_G", "_VERSION",
	"table", "string", "math", "bit32", "debug", "coroutine",
]);

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
