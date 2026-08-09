#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const TARGET = process.argv[2] ?? join(PLUGIN_DIR, "webpack.config.js");
const ALLOW_MARKER = "lint-webpack-cache:allow";

const ASSIGN = /\b(filename|chunkFilename)\s*:\s*(["'`])([^"'`]*)\2/g;
const HASH = /\[(contenthash|chunkhash|hash)(:\d+)?\]/;

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
		if (rawLine.includes(ALLOW_MARKER)) return;
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
