#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = join(SCRIPT_DIR, "..", "module");
const INDEX_PATH = join(SCRIPT_DIR, "factorio-api-index.json");

const ABSOLUTE_TICK_DOC_RE = /^The (last )?tick (this|when|at which)\b/i;
const ALLOW_RE = /tick:allow/;
const CLOCK_RE = /\bgame\.tick\b/;
const REQUIRED_CONTROLS = ["tick_grown", "spoil_tick"];

export function absoluteTickAttributes(index) {
	const names = new Set();
	for (const members of Object.values(index.classes || {})) {
		for (const [name, d] of Object.entries(members)) {
			if (d.kind !== "attribute") continue;
			if (!name.includes("tick")) continue;
			if (typeof d.doc === "string" && ABSOLUTE_TICK_DOC_RE.test(d.doc)) names.add(name);
		}
	}
	return [...names].sort();
}

export function findTickViolations(source, file, names) {
	const violations = [];
	const patterns = names.map(name => ({ name, re: new RegExp(`\\b${name}\\b`) }));
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		for (const { name, re } of patterns) {
			if (!re.test(line)) continue;
			if (CLOCK_RE.test(line)) continue;
			if (ALLOW_RE.test(line) || (i > 0 && ALLOW_RE.test(lines[i - 1]))) continue;
			violations.push({
				file, line: i + 1, name,
				text: line.trim().slice(0, 120),
			});
		}
	}
	return violations;
}

function luaFiles(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...luaFiles(p));
		else if (name.endsWith(".lua")) out.push(p);
	}
	return out;
}

function main() {
	const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
	const names = absoluteTickAttributes(index);
	const missingControls = REQUIRED_CONTROLS.filter(n => !names.includes(n));
	if (missingControls.length) {
		console.error(`lint:tick-portability CONTROL FAILURE: the doc-derived absolute-tick list is missing `
			+ `${missingControls.join(", ")} — the index lost its doc fields, which would silently disable `
			+ "this guard. Regenerate the index with extract-factorio-api-index.mjs.");
		process.exit(1);
	}
	const violations = [];
	for (const file of luaFiles(MODULE_DIR)) {
		violations.push(...findTickViolations(readFileSync(file, "utf8"), relative(MODULE_DIR, file), names));
	}
	if (violations.length) {
		console.error(`lint:tick-portability: ${violations.length} raw absolute-tick access(es). `
			+ "An absolute engine tick is another instance's clock: written raw it instant-spoils items "
			+ "and mis-grows plants. Store a duration (attr - game.tick), restore as game.tick + duration, "
			+ "keep the arithmetic on the same line — or annotate `-- tick:allow` (enumerated in the "
			+ "allow manifest).");
		for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.name}  ${v.text}`);
		process.exit(1);
	}
	console.log(`lint:tick-portability OK — ${names.length} absolute-tick attributes watched `
		+ `(${names.join(", ")}), 0 raw accesses in module/`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
