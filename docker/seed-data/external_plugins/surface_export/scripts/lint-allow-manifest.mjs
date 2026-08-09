#!/usr/bin/env node

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const REPO_DIR = join(PLUGIN_DIR, "..", "..", "..", "..");
const MANIFEST_PATH = join(SCRIPT_DIR, "lint-allow-manifest.json");

function walk(dir, exts, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name === ".git") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, exts, out);
		else if (exts.some((e) => name.toLowerCase().endsWith(e))) out.push(p);
	}
	return out;
}
function filesInDir(dir, exts) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((n) => join(dir, n))
		.filter((p) => statSync(p).isFile() && exts.some((e) => p.toLowerCase().endsWith(e)));
}
function mdIn(dir, recursive = false) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) {
			if (recursive) out.push(...mdIn(p, true));
		} else if (name.toLowerCase().endsWith(".md")) out.push(p);
	}
	return out;
}

const SCOPES = {
	"lint-lua:allow": () => walk(join(PLUGIN_DIR, "module"), [".lua"]),
	"pcall:allow": () => walk(join(PLUGIN_DIR, "module"), [".lua"]),
	"lint-webpack-cache:allow": () => [join(PLUGIN_DIR, "webpack.config.js")].filter(existsSync),
	"lint-test-grounding:allow": () => walk(join(REPO_DIR, "tests"), [".ps1", ".mjs", ".js"]),
};

const actual = new Map();
for (const [marker, filesOf] of Object.entries(SCOPES)) {
	for (const file of filesOf()) {
		const text = readFileSync(file, "utf8");
		let count = 0;
		for (let i = text.indexOf(marker); i !== -1; i = text.indexOf(marker, i + marker.length)) count++;
		if (count > 0) {
			const rel = relative(REPO_DIR, file).replaceAll("\\", "/");
			actual.set(rel + "\u0000" + marker, count);
		}
	}
}

const errors = [];
let manifest;
try {
	manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
} catch (e) {
	console.error(`lint-allow-manifest: cannot read/parse ${MANIFEST_PATH}: ${e.message}`);
	process.exit(1);
}
const listed = new Map();
for (const entry of manifest.entries ?? []) {
	const { file, marker, count, reason, approver } = entry;
	if (!file || !marker || !Number.isInteger(count) || count < 1) {
		errors.push(`manifest entry malformed (need file, marker, integer count>=1): ${JSON.stringify(entry)}`);
		continue;
	}
	if (!(marker in SCOPES)) {
		errors.push(`manifest entry for unknown marker "${marker}" (known: ${Object.keys(SCOPES).join(", ")})`);
		continue;
	}
	if (!reason || !String(reason).trim()) errors.push(`manifest entry ${file} [${marker}] has no reason — an allow without a WHY is not reviewable`);
	if (!approver || !String(approver).trim()) errors.push(`manifest entry ${file} [${marker}] has no approver — allows are escalations, name who approved`);
	const key = file.replaceAll("\\", "/") + "\u0000" + marker;
	if (listed.has(key)) errors.push(`manifest lists ${file} [${marker}] twice — merge the entries`);
	listed.set(key, count);
}

for (const [key, actualCount] of actual) {
	const [file, marker] = key.split("\u0000");
	const listedCount = listed.get(key);
	if (listedCount === undefined) {
		errors.push(
			`UNLISTED allow: ${file} contains ${actualCount}x \`${marker}\` with no manifest entry — `
			+ "get orchestrator/owner approval, then add {file, marker, count, reason, approver} to scripts/lint-allow-manifest.json.",
		);
	} else if (listedCount !== actualCount) {
		errors.push(`COUNT DRIFT: ${file} [${marker}] — manifest says ${listedCount}, code has ${actualCount}. Update the manifest in the same reviewed commit.`);
	}
}
for (const [key, listedCount] of listed) {
	if (!actual.has(key)) {
		const [file, marker] = key.split("\u0000");
		errors.push(`STALE manifest entry: ${file} [${marker}] (count ${listedCount}) — no such annotation exists anymore. Remove the entry.`);
	}
}

if (errors.length > 0) {
	console.error(`lint-allow-manifest: ${errors.length} problem(s):\n`);
	for (const e of errors) console.error("  " + e);
	console.error("\nThe manifest must match reality exactly. Allows are escalations: approval comes BEFORE the PR, and the manifest diff is the reviewable record.");
	process.exit(1);
}
console.log(`lint-allow-manifest: OK (${actual.size} annotated (file,marker) pairs, all enumerated with reason+approver)`);
