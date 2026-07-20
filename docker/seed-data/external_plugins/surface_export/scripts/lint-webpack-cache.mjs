#!/usr/bin/env node
/**
 * lint-webpack-cache.mjs — static guard that the plugin's webpack output stays content-hashed.
 *
 * The controller serves /static/* with `Cache-Control: immutable, max-age=1y`, which is ONLY safe
 * for content-hashed filenames (a content change must yield a new URL). @clusterio/web_ui's shared
 * webpack.common already hashes by default (static/[name].[contenthash].js); a local
 * `output.filename`/`chunkFilename` — or a ModuleFederation `filename` — override WITHOUT a hash
 * token silently defeats that and pins stale chunks on returning users for up to a year. That exact
 * regression shipped once (commit 94e1b8c, "major refactor, WIP") and wasn't caught until it hit
 * prod. This guard is the catch (see the "Web cache" guard entry in CLAUDE.md).
 *
 * Rule: every `filename:`/`chunkFilename:` string literal in webpack.config.js must contain a
 *       content-hash token ([contenthash] / [chunkhash] / [hash]). Omitting the keys entirely (to
 *       inherit the hashed default) is fine — only an explicit non-hashed override trips it.
 *
 * Scope: the plugin's webpack.config.js.
 * Run:   node scripts/lint-webpack-cache.mjs            (also: npm run lint:web-cache)
 *        node scripts/lint-webpack-cache.mjs <file>     (lint an alternate config — used to self-test)
 * Escape hatch: append a `lint-webpack-cache:allow` comment on a line to suppress it (with a reason).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const TARGET = process.argv[2] ?? join(PLUGIN_DIR, "webpack.config.js");
const ALLOW_MARKER = "lint-webpack-cache:allow";

// `filename:` / `chunkFilename:` set to a string literal (single/double/back-quoted).
const ASSIGN = /\b(filename|chunkFilename)\s*:\s*(["'`])([^"'`]*)\2/g;
// Any webpack content-hash token makes immutable caching safe.
const HASH = /\[(contenthash|chunkhash|hash)(:\d+)?\]/;

/** Strip a JS line comment (`// ...`) so the rule only sees code — the explanatory comment in
 *  webpack.config.js that MENTIONS the old "static/[name].js" override must not trip the guard.
 *  (We split on the first `//`; the config has no string literals containing `//`.) */
function stripLineComment(line) {
	const idx = line.indexOf("//");
	return idx === -1 ? line : line.slice(0, idx);
}

function main() {
	let src;
	try {
		src = readFileSync(TARGET, "utf8");
	} catch (err) {
		console.error(`lint:web-cache — cannot read ${TARGET}: ${err.message}`);
		process.exit(1);
	}

	const lines = src.split(/\r?\n/);
	const violations = [];

	lines.forEach((rawLine, i) => {
		if (rawLine.includes(ALLOW_MARKER)) return; // explicit per-line suppression
		const code = stripLineComment(rawLine);
		for (const m of code.matchAll(ASSIGN)) {
			const [, key, , value] = m;
			if (!HASH.test(value)) {
				violations.push({ line: i + 1, col: m.index + 1, key, value, text: rawLine.trim() });
			}
		}
	});

	const rel = relative(PLUGIN_DIR, TARGET).replace(/\\/g, "/") || TARGET;

	if (violations.length === 0) {
		console.log(`lint:web-cache — OK (${rel}: webpack output filenames are content-hashed)`);
		process.exit(0);
	}

	console.error(`lint:web-cache — ${violations.length} non-content-hashed output filename(s):\n`);
	for (const v of violations) {
		console.error(`  ${rel}:${v.line}:${v.col}  output.${v.key} = "${v.value}"`);
		console.error(`    ${v.text}`);
		console.error("    → The controller serves /static with an immutable 1y cache, so a fixed name pins this");
		console.error("      chunk STALE on returning users. Add a [contenthash] token, or drop the override to");
		console.error("      inherit @clusterio/web_ui's hashed default. See the Web cache guard entry in CLAUDE.md\n");
	}
	console.error(`Fix the above, or add a "${ALLOW_MARKER} <reason>" comment on the line if it is a verified exception.`);
	process.exit(1);
}

main();
