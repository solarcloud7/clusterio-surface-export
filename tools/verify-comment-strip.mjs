#!/usr/bin/env node
// verify-comment-strip — prove a comment strip changed nothing but comments.
// requires: pre-strip files, from a git ref (default) or from SC_BEFORE_DIR when git is unreachable
//           (the container that has typescript cannot see this repo's .git); scripts/vendor/luaparse.cjs
//           for .lua; a resolvable `typescript` for .ts/.tsx/.js/.mjs/.cjs (NODE_PATH is honoured)
// produces: exit 0 only when every changed file's parse is identical before and after; a per-file verdict
// does not: check that comments were actually removed, that the KEEP list was right, that anything
//           still runs, or that line endings are unchanged (CRLF is normalized to LF on both sides
//           before parsing) — it proves code equivalence, not correctness

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(REPO_DIR, "docker/seed-data/external_plugins/surface_export");
const require = createRequire(import.meta.url);

const ref = process.argv[2] || "HEAD";
const LUA_EXT = new Set([".lua"]);
const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PS_EXT = new Set([".ps1", ".psm1"]);

const BEFORE_DIR = process.env.SC_BEFORE_DIR || null;

function changedFiles() {
	if (BEFORE_DIR) {
		const { readdirSync, statSync } = require("node:fs");
		const found = [];
		const walk = (dir) => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) walk(full);
				else found.push(relativePosix(BEFORE_DIR, full));
			}
		};
		walk(BEFORE_DIR);
		return found;
	}
	const out = execFileSync("git", ["diff", "--name-only", "--diff-filter=M", ref], { cwd: REPO_DIR, encoding: "utf8" });
	return out.split("\n").map(l => l.trim()).filter(Boolean);
}

function lf(source) {
	return source.split("\r\n").join("\n");
}

function relativePosix(from, to) {
	return require("node:path").relative(from, to).split(sep).join("/");
}

function original(path) {
	if (BEFORE_DIR) return readFileSync(join(BEFORE_DIR, path), "utf8");
	return execFileSync("git", ["show", `${ref}:${path}`], { cwd: REPO_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function luaShape(source) {
	const luaparse = require(join(PLUGIN_DIR, "scripts/vendor/luaparse.cjs"));
	return JSON.stringify(luaparse.parse(source, {
		luaVersion: "5.2", comments: false, ranges: false, locations: false, scope: false,
	}));
}

let ts = null;
function jsShape(source, path) {
	if (!ts) ts = require("typescript");
	if (path.endsWith(".d.ts")) return tokenShape(source);
	const tsx = extname(path) === ".tsx" || extname(path) === ".jsx";
	return ts.transpileModule(source, {
		fileName: path,
		reportDiagnostics: false,
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			removeComments: true,
			jsx: tsx ? ts.JsxEmit.Preserve : undefined,
			newLine: ts.NewLineKind.LineFeed,
		},
	}).outputText;
}

function tokenShape(source) {
	const skipTrivia = true;
	const scanner = ts.createScanner(ts.ScriptTarget.ESNext, skipTrivia, ts.LanguageVariant.Standard, source);
	const tokens = [];
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
		tokens.push(`${kind}|${scanner.getTokenText()}`);
	}
	return tokens.join("\n");
}

let psScriptPath = null;
function psShape(source) {
	if (!psScriptPath) {
		const { mkdtempSync, writeFileSync } = require("node:fs");
		const { tmpdir } = require("node:os");
		psScriptPath = join(mkdtempSync(join(tmpdir(), "verify-ps-")), "tokens.ps1");
		writeFileSync(psScriptPath, [
			"param([string]$Path)",
			"$t = $null; $e = $null",
			"$null = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$t, [ref]$e)",
			"if ($e -and $e.Count -gt 0) { Write-Error $e[0].Message; exit 1 }",
			"$t | Where-Object { $_.Kind -ne 'Comment' -and $_.Kind -ne 'NewLine' -and $_.Kind -ne 'EndOfInput' } |",
			"  ForEach-Object { \"$($_.Kind)|$($_.Text)\" } | Out-String",
		].join("\n"), "utf8");
	}
	const { writeFileSync } = require("node:fs");
	const tmp = join(dirname(psScriptPath), "subject.ps1");
	writeFileSync(tmp, source, "utf8");
	return execFileSync("pwsh", ["-NoProfile", "-File", psScriptPath, "-Path", tmp], { encoding: "utf8" });
}

const files = changedFiles();
let checked = 0;
let skipped = 0;
const mismatches = [];
const errors = [];

const extractTo = process.argv.includes("--extract-before")
	? process.argv[process.argv.indexOf("--extract-before") + 1]
	: null;
if (extractTo) {
	const { mkdirSync, writeFileSync } = require("node:fs");
	const changed = execFileSync("git", ["diff", "--name-only", "--diff-filter=M", ref], { cwd: REPO_DIR, encoding: "utf8" })
		.split("\n").map(l => l.trim()).filter(Boolean);
	for (const path of changed) {
		const bytes = execFileSync("git", ["show", `${ref}:${path}`], { cwd: REPO_DIR, maxBuffer: 64 * 1024 * 1024 });
		const target = join(extractTo, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, bytes);
	}
	console.log(`extracted ${changed.length} pre-strip file(s) from ${ref}`);
	process.exit(0);
}

const ONLY = (process.env.SC_ONLY || "").split(",").filter(Boolean);
const wanted = (kind) => ONLY.length === 0 || ONLY.includes(kind);

for (const path of files) {
	const ext = extname(path);
	const shape = LUA_EXT.has(ext) && wanted("lua") ? luaShape
		: JS_EXT.has(ext) && wanted("js") ? jsShape
			: PS_EXT.has(ext) && wanted("ps") ? psShape
				: null;
	if (!shape) { skipped++; continue; }
	try {
		const before = shape(lf(original(path)), path);
		const after = shape(lf(readFileSync(join(REPO_DIR, path), "utf8")), path);
		if (before === after) checked++;
		else mismatches.push(path);
	} catch (err) {
		errors.push(`${path}: ${err.message.split("\n")[0]}`);
	}
}

console.log(`identical parse before/after: ${checked} file(s)`);
if (skipped) console.log(`not a parseable language, unchecked: ${skipped} file(s)`);
if (mismatches.length) {
	console.log(`\nPARSE DIFFERS — the strip changed code, not just comments:`);
	for (const m of mismatches) console.log(`  ${m}`);
}
if (errors.length) {
	console.log(`\nCOULD NOT VERIFY (treat as failure):`);
	for (const e of errors) console.log(`  ${e}`);
}
process.exit(mismatches.length || errors.length ? 1 : 0);
