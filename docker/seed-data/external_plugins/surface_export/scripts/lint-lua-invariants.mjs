#!/usr/bin/env node
/**
 * lint-lua-invariants.mjs — static guard for the Lua module's documented-but-otherwise-unenforced
 * invariants. ESLint covers the TypeScript side (incl. Pitfall #26, the unbound Link-method guard);
 * the Lua module has no linter, so the footguns we have already been bitten by used to ship through
 * review with nothing to catch a regression. This script is that catch.
 *
 * Each rule below maps to a CLAUDE.md Pitfall and was VERIFIED clean (or fixed clean) when added —
 * so the guard is green today and only goes red if someone reintroduces the anti-pattern.
 *
 * Scope: every .lua file under the plugin's module/ subtree.
 * Run:   node scripts/lint-lua-invariants.mjs        (also: npm run lint:lua)
 *        (agent shell has no node on PATH — run inside a host container, see CLAUDE.md)
 * Escape hatch: append a `-- lint-lua:allow` comment on a line to suppress it (use sparingly,
 *               with a reason).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const MODULE_DIR = join(PLUGIN_DIR, "module");
const ALLOW_MARKER = "lint-lua:allow";

/**
 * Rules run against each Lua source line AFTER line-comments (`-- ...`) are stripped, so the
 * anti-pattern only trips on real code — doc comments that mention it (e.g. the delete_platform
 * helper explaining why platform.destroy() is forbidden) are intentionally not flagged.
 */
const RULES = [
	{
		id: "no-clusterio-lib-mod-path",
		pitfall: "#12",
		// `clusterio_lib` is NOT a Factorio mod — Clusterio injects its API via save-patching.
		// require("__clusterio_lib__/api") and gating on script.active_mods["clusterio_lib"]
		// (always nil) both silently disable the API → "Clusterio API not available" crashes.
		regex: /__clusterio_lib__|active_mods\s*[.[]\s*['"]?clusterio_lib/,
		hint: 'Clusterio is save-patched, not a mod. Use require("modules/clusterio/api"); '
			+ 'never gate on script.active_mods["clusterio_lib"] (always nil).',
	},
	{
		id: "no-global-persistence-table",
		pitfall: "#4",
		// Factorio 2.0 renamed the persistent state table `global` -> `storage`. A stray `global.x`
		// writes to a non-persistent table that vanishes on save/load.
		regex: /\bglobal\s*[.[=]/,
		hint: "Factorio 2.0 renamed the persistent table to `storage`. Use storage.<key>, not global.<key>.",
	},
	{
		id: "no-platform-destroy",
		pitfall: "#19",
		// LuaSpacePlatform.destroy() is a SILENT no-op in Factorio 2.0 Space Age (verified: after the
		// call, platform.valid is still true and the platform count is unchanged). Matches any
		// receiver whose name contains "platform" — does NOT match pod/ent/GUI-element .destroy().
		regex: /\b\w*platform\w*\.destroy\s*\(/i,
		hint: "LuaSpacePlatform.destroy() is a no-op in Factorio 2.0. "
			+ "Use GameUtils.delete_platform(platform) (game.delete_surface under the hood).",
	},
	{
		id: "no-name-as-transfer-identity",
		pitfall: "#31",
		// Platform identity in the source-delete / lock spine MUST key on the STABLE surface.index (or the
		// unique platform.index), NEVER the mutable platform.name. A player can rename a platform mid-transfer
		// from the hub GUI, so a name-based identity check on the DESTRUCTIVE delete path refused the delete →
		// source survived + dest committed = a duplication exploit. Matches `platform.name`/`platform_name`
		// used in an ==/~= comparison. SCOPED to the delete + lock-identity spine (appliesTo) — name→index
		// LOOKUPS at the admin boundary (e.g. find_lock_key_by_name, fail-loud on ambiguity) are the sanctioned
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

/** Strip a Lua line comment (`-- ...`) so rules only see executable code. Block comments are rare
 *  here and not handled; a forbidden pattern inside one can be suppressed with the escape hatch. */
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
		const lines = readFileSync(file, "utf8").split(/\r?\n/);
		lines.forEach((rawLine, i) => {
			if (rawLine.includes(ALLOW_MARKER)) return; // explicit per-line suppression
			const code = stripLineComment(rawLine);
			for (const rule of RULES) {
				if (rule.appliesTo && !rule.appliesTo.some((p) => relative(PLUGIN_DIR, file).replace(/\\/g, "/").includes(p))) continue;
					const m = rule.regex.exec(code);
				if (m) {
					violations.push({
						file: relative(PLUGIN_DIR, file).replace(/\\/g, "/"),
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
