#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const MODULE_DIR = join(PLUGIN_DIR, "module");
const ALLOW_MARKER = "lint-lua:allow";

const RULES = [
	{
		id: "no-clusterio-lib-mod-path",
		pitfall: "#12",
		regex: /__clusterio_lib__|active_mods\s*[.[]\s*['"]?clusterio_lib/,
		hint: 'Clusterio is save-patched, not a mod. Use require("modules/clusterio/api"); '
			+ 'never gate on script.active_mods["clusterio_lib"] (always nil).',
	},
	{
		id: "no-global-persistence-table",
		pitfall: "#4",
		regex: /\bglobal\s*[.[=]/,
		hint: "Factorio 2.0 renamed the persistent table to `storage`. Use storage.<key>, not global.<key>.",
	},
	{
		id: "no-platform-destroy",
		pitfall: "#19",
		regex: /\b\w*platform\w*\.destroy\s*\(/i,
		hint: "LuaSpacePlatform.destroy() is a no-op in Factorio 2.0. "
			+ "Use GameUtils.delete_platform(platform) (game.delete_surface under the hood).",
	},
	{
		id: "no-name-as-transfer-identity",
		pitfall: "#31",
		// exception: annotate them with `-- lint-lua:allow` + a reason.
		regex: /(?:\bplatform\.name|\bplatform_name)\s*[=~]=|[=~]=\s*(?:platform\.name|\bplatform_name)\b/,
		appliesTo: [
			"interfaces/remote/delete-platform-for-transfer.lua",
			"utils/surface-lock.lua",
			"core/transfer-trigger.lua",
			"core/export-pipeline.lua",
		],
		hint: "Source-delete/lock identity must use surface.index / unique platform.index, never the mutable "
			+ "platform.name (rename dup exploit). Resolve name→index only at the admin boundary (fail-loud) "
			+ "and annotate that line with `-- lint-lua:allow <reason>`.",
	},
];

function stripLineComment(line) {
	const idx = line.indexOf("--");
	return idx === -1 ? line : line.slice(0, idx);
}

function collectLuaFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...collectLuaFiles(full));
		} else if (name.endsWith(".lua")) {
			out.push(full);
		}
	}
	return out;
}

function main() {
	const files = collectLuaFiles(MODULE_DIR);
	const violations = [];

	for (const file of files) {
		const relPath = relative(PLUGIN_DIR, file).replace(/\\/g, "/");
		const lines = readFileSync(file, "utf8").split(/\r?\n/);
		lines.forEach((rawLine, i) => {
			if (rawLine.includes(ALLOW_MARKER)) return;
			const code = stripLineComment(rawLine);
			for (const rule of RULES) {
					if (rule.appliesTo && !rule.appliesTo.some((p) => relPath.includes(p))) continue;
				const m = rule.regex.exec(code);
				if (m) {
					violations.push({
						file: relPath,
						line: i + 1,
						col: m.index + 1,
						rule,
						text: rawLine.trim(),
					});
				}
			}
		});
	}

	if (violations.length === 0) {
		console.log(`lint:lua — OK (${files.length} Lua files, ${RULES.length} invariants enforced)`);
		process.exit(0);
	}

	console.error(`lint:lua — ${violations.length} violation(s):\n`);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}:${v.col}  [${v.rule.id}] (Pitfall ${v.rule.pitfall})`);
		console.error(`    ${v.text}`);
		console.error(`    → ${v.rule.hint}\n`);
	}
	console.error("Fix the above, or add `-- lint-lua:allow` with a reason if it is a verified false positive.");
	process.exit(1);
}

main();
