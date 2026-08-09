#!/usr/bin/env node
// strip-code-comments — delete comments from source files, keeping the ones tooling reads.
// requires: node 20+; scripts/vendor/luaparse.cjs for .lua; pwsh on PATH for .ps1
// produces: rewritten files in place (or a per-file count with --dry-run); a KEPT tally on stderr
// does not: prove the result compiles, prove semantics are unchanged, or judge whether a comment
//           was worth keeping — run the language's own compiler/parser afterwards for that

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(REPO_DIR, "docker/seed-data/external_plugins/surface_export");
const require = createRequire(import.meta.url);

const { maskNonCode } = await import(
	`file://${join(PLUGIN_DIR, "scripts/lint-catch-swallow.mjs").split(sep).join("/")}`
);

const SKIP_DIRS = new Set([
	".git", "node_modules", "dist", "graphify-out", ".claude", "raw",
	"docker/seed-data/mods", "docker/seed-data/lab-saves",
]);

const SKIP_FILES = [
	"scripts/vendor/",
	"module/core/json.lua",
];

const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const LUA_EXT = new Set([".lua"]);
const PS_EXT = new Set([".ps1", ".psm1"]);

const KEEP_ANY = [
	/eslint-(disable|enable|env)/,
	/^\s*global\s/,
	/@ts-(expect-error|ignore|nocheck)/,
	/prettier-ignore/,
	/(istanbul|c8|v8)\s+ignore/,
	/webpack(ChunkName|Mode|Ignore|Prefetch|Preload)/,
	/@vite-ignore/,
	/\bCopyright\b/i,
	/SPDX-License/,
	/Permission is hereby granted/,
];

const KEEP_SINGLE_LINE = [
	/:allow\b/,
	/intentional probe/i,
	/failure expected/i,
	/deliberately quiet/i,
];

const METADATA_LINE = /^\s*(requires|produces|does not):/i;

function walk(dir, out = []) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const rel = relative(REPO_DIR, full).split(sep).join("/");
		if (SKIP_DIRS.has(entry) || SKIP_DIRS.has(rel)) continue;
		const st = statSync(full);
		if (st.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

function isSkipped(file) {
	const rel = relative(REPO_DIR, file).split(sep).join("/");
	return SKIP_FILES.some(frag => rel.includes(frag));
}

function luaComments(source, file) {
	const luaparse = require(join(PLUGIN_DIR, "scripts/vendor/luaparse.cjs"));
	const ast = luaparse.parse(source, { luaVersion: "5.2", comments: true, ranges: true, locations: false, scope: false });
	return (ast.comments || []).map(c => ({ start: c.range[0], end: c.range[1], text: c.raw }));
}

function jsComments(source) {
	const ranges = [];
	const states = [{ kind: "code", templateDepth: null }];
	for (let i = 0; i < source.length; i++) {
		const state = states.at(-1);
		const next = source[i + 1];
		if (state.kind === "line-comment") {
			if (source[i] === "\n") { ranges.push({ start: state.openedAt, end: i }); states.pop(); }
			else if (i === source.length - 1) { ranges.push({ start: state.openedAt, end: source.length }); states.pop(); }
			continue;
		}
		if (state.kind === "block-comment") {
			if (source[i] === "*" && next === "/") { i++; ranges.push({ start: state.openedAt, end: i + 1 }); states.pop(); }
			continue;
		}
		if (state.kind === "quote") {
			if (source[i] === "\\") i++;
			else if (source[i] === state.quote) states.pop();
			continue;
		}
		if (state.kind === "regex") {
			if (source[i] === "\\") i++;
			else if (source[i] === "[") state.inClass = true;
			else if (source[i] === "]") state.inClass = false;
			else if (source[i] === "/" && !state.inClass) states.pop();
			continue;
		}
		if (state.kind === "template") {
			if (source[i] === "\\") { i++; continue; }
			if (source[i] === "`") { states.pop(); continue; }
			if (source[i] === "$" && next === "{") { i++; states.push({ kind: "code", templateDepth: 1 }); }
			continue;
		}
		if (source[i] === "/" && next === "/") { states.push({ kind: "line-comment", openedAt: i }); i++; continue; }
		if (source[i] === "/" && next === "*") { states.push({ kind: "block-comment", openedAt: i }); i++; continue; }
		if (source[i] === "/" && (source[i - 1] === "<" || next === ">")) { }
		else if (source[i] === "/" && startsRegexAt(source, i)) { states.push({ kind: "regex", inClass: false }); continue; }
		if ((source[i] === "'" || source[i] === '"') && /[A-Za-z0-9_$]/.test(source[i - 1] ?? "")) continue;
		if (source[i] === "'" || source[i] === '"') { states.push({ kind: "quote", quote: source[i] }); continue; }
		if (source[i] === "`") { states.push({ kind: "template" }); continue; }
		if (state.templateDepth !== null) {
			if (source[i] === "{") state.templateDepth++;
			if (source[i] === "}" && --state.templateDepth === 0) states.pop();
		}
	}
	return ranges;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
	"return", "typeof", "case", "in", "of", "delete", "void", "new", "do", "else", "yield", "await", "instanceof",
]);

function startsRegexAt(source, index) {
	let j = index - 1;
	while (j >= 0 && /\s/.test(source[j])) j--;
	if (j < 0) return true;
	const prev = source[j];
	if (/[A-Za-z0-9_$]/.test(prev)) {
		let start = j;
		while (start > 0 && /[A-Za-z_$]/.test(source[start - 1])) start--;
		return REGEX_PRECEDING_KEYWORDS.has(source.slice(start, j + 1));
	}
	if ((prev === "+" && source[j - 1] === "+") || (prev === "-" && source[j - 1] === "-")) return false;
	return prev !== ")" && prev !== "]";
}

let psScript = null;
function psComments(source) {
	if (!psScript) {
		psScript = join(mkdtempSync(join(tmpdir(), "strip-ps-")), "tokens.ps1");
		writeFileSync(psScript, [
			"param([string]$Path)",
			"$t = $null; $e = $null",
			"$null = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$t, [ref]$e)",
			"if ($e -and $e.Count -gt 0) { Write-Error $e[0].Message; exit 1 }",
			"$t | Where-Object { $_.Kind -eq 'Comment' } |",
			"  ForEach-Object { [pscustomobject]@{ start = $_.Extent.StartOffset; end = $_.Extent.EndOffset } } |",
			"  ConvertTo-Json -Compress -AsArray",
		].join("\n"), "utf8");
	}
	const tmp = join(dirname(psScript), "subject.ps1");
	writeFileSync(tmp, source, "utf8");
	const out = execFileSync("pwsh", ["-NoProfile", "-File", psScript, "-Path", tmp], { encoding: "utf8" });
	return JSON.parse(out.trim() || "[]");
}

function leadingMetadataBlockEnd(source, ranges) {
	const sorted = [...ranges].sort((a, b) => a.start - b.start);
	const block = [];
	let end = -1;
	for (const r of sorted) {
		const between = source.slice(end === -1 ? 0 : end, r.start);
		if (end === -1 ? /[^\s]/.test(between.replace(/^#![^\n]*/, "")) : between.trim() !== "") break;
		block.push(r);
		end = r.end;
	}
	const isMetadata = block.some(r => source.slice(r.start, r.end)
		.split("\n")
		.some(line => METADATA_LINE.test(line.replace(/^\s*(\/\/+|--+|#+|\*+)/, ""))));
	return isMetadata ? end : -1;
}

function stripFile(file, { dryRun }) {
	const ext = extname(file);
	const source = readFileSync(file, "utf8");
	let ranges;
	if (LUA_EXT.has(ext)) ranges = luaComments(source, file);
	else if (JS_EXT.has(ext)) ranges = jsComments(source);
	else if (PS_EXT.has(ext)) ranges = psComments(source);
	else return null;

	if (JS_EXT.has(ext)) {
		const masked = maskNonCode(source, file);
		for (const r of ranges) {
			const slice = masked.slice(r.start, r.end);
			if (/[^\s]/.test(slice)) {
				throw new Error(
					`${relative(REPO_DIR, file)}: range ${r.start}-${r.end} was collected as a comment but the `
					+ "proven lexer sees code there — the collector desynced, do not write this file");
			}
		}
	}

	const metadataEnd = leadingMetadataBlockEnd(source, ranges);
	let removed = 0;
	let kept = 0;
	const drop = [];
	for (const r of ranges) {
		const text = source.slice(r.start, r.end);
		if (r.start === 0 && text.startsWith("#!")) { kept++; continue; }
		if (metadataEnd !== -1 && r.end <= metadataEnd) { kept++; continue; }
		if (KEEP_ANY.some(re => re.test(text))) { kept++; continue; }
		if (!text.includes("\n") && KEEP_SINGLE_LINE.some(re => re.test(text))) { kept++; continue; }
		drop.push(r);
		removed++;
	}
	if (!removed) return { removed: 0, kept };

	let out = "";
	let cursor = 0;
	for (const r of drop.sort((a, b) => a.start - b.start)) {
		let start = r.start;
		let end = r.end;
		const lineStart = source.lastIndexOf("\n", start - 1) + 1;
		const before = source.slice(lineStart, start);
		const nl = source.indexOf("\n", end);
		const after = source.slice(end, nl === -1 ? source.length : nl);
		if (before.trim() === "" && after.trim() === "") {
			start = lineStart;
			end = nl === -1 ? source.length : nl + 1;
		} else if (before.trim() === "") {
			start = lineStart;
		} else {
			while (start > lineStart && /[ \t]/.test(source[start - 1])) start--;
		}
		if (start < cursor) continue;
		out += source.slice(cursor, start);
		cursor = end;
	}
	out += source.slice(cursor);
	out = out.replace(/^(﻿)?(?:[ \t]*\r?\n)+/, "$1");

	if (!dryRun) writeFileSync(file, out, "utf8");
	return { removed, kept };
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const only = args.find(a => a.startsWith("--only="))?.slice(7);
const targets = args.filter(a => !a.startsWith("--"));

const extFilter = only === "lua" ? LUA_EXT : only === "js" ? JS_EXT : only === "ps" ? PS_EXT : null;
const roots = targets.length ? targets.map(t => resolve(t)) : [REPO_DIR];

let files = [];
for (const root of roots) {
	files = files.concat(statSync(root).isDirectory() ? walk(root) : [root]);
}
files = files.filter(f => {
	const ext = extname(f);
	if (extFilter) return extFilter.has(ext) && !isSkipped(f);
	return (JS_EXT.has(ext) || LUA_EXT.has(ext) || PS_EXT.has(ext)) && !isSkipped(f);
});

let totalRemoved = 0;
let totalKept = 0;
let touched = 0;
const failures = [];
for (const file of files.sort()) {
	try {
		const result = stripFile(file, { dryRun });
		if (!result) continue;
		totalKept += result.kept;
		if (result.removed) {
			totalRemoved += result.removed;
			touched++;
			console.log(`  ${String(result.removed).padStart(4)}  ${relative(REPO_DIR, file).split(sep).join("/")}`);
		}
	} catch (err) {
		failures.push(`${relative(REPO_DIR, file).split(sep).join("/")}: ${err.message}`);
	}
}

if (psScript) rmSync(dirname(psScript), { recursive: true, force: true });

console.error(`\n${dryRun ? "would remove" : "removed"} ${totalRemoved} comment(s) across ${touched} file(s); kept ${totalKept}`);
if (failures.length) {
	console.error(`\n${failures.length} FILE(S) FAILED — none of them written:`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}
