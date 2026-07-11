#!/usr/bin/env node
/**
 * lint-catch-swallow.mjs — caught TypeScript errors must reach an observable sink.
 *
 * A non-empty catch is not automatically safe: `catch { value = [] }` silently converts a read failure
 * into valid-looking empty state. Every catch in plugin TS/TSX must propagate, log, or show its error, or
 * carry an owner-approved `catch:allow <reason>` on the catch line or the line immediately above it.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const REPO_DIR = join(PLUGIN_DIR, "..", "..", "..", "..");
const ALLOW_MARKER = "catch:allow";

function maskNonCode(source) {
	const out = [...source];
	const states = [{ kind: "code", templateDepth: null }];
	const blank = (index) => { if (source[index] !== "\n" && source[index] !== "\r") out[index] = " "; };

	for (let i = 0; i < source.length; i++) {
		const state = states.at(-1);
		const next = source[i + 1];
		if (state.kind === "line-comment") {
			blank(i);
			if (source[i] === "\n") states.pop();
			continue;
		}
		if (state.kind === "block-comment") {
			blank(i);
			if (source[i] === "*" && next === "/") { blank(i + 1); i++; states.pop(); }
			continue;
		}
		if (state.kind === "quote") {
			blank(i);
			if (source[i] === "\\") { blank(i + 1); i++; }
			else if (source[i] === state.quote) states.pop();
			continue;
		}
		if (state.kind === "template") {
			blank(i);
			if (source[i] === "\\") { blank(i + 1); i++; continue; }
			if (source[i] === "`") { states.pop(); continue; }
			if (source[i] === "$" && next === "{") {
				out[i] = "$";
				out[i + 1] = "{";
				i++;
				states.push({ kind: "code", templateDepth: 1 });
			}
			continue;
		}

		if (source[i] === "/" && next === "/") { blank(i); blank(i + 1); i++; states.push({ kind: "line-comment" }); continue; }
		if (source[i] === "/" && next === "*") { blank(i); blank(i + 1); i++; states.push({ kind: "block-comment" }); continue; }
		if (source[i] === "'" || source[i] === '"') { blank(i); states.push({ kind: "quote", quote: source[i] }); continue; }
		if (source[i] === "`") { blank(i); states.push({ kind: "template" }); continue; }
		if (state.templateDepth !== null) {
			if (source[i] === "{") state.templateDepth++;
			if (source[i] === "}" && --state.templateDepth === 0) states.pop();
		}
	}
	return out.join("");
}

function matchingDelimiter(code, openIndex, open, close) {
	let depth = 0;
	for (let i = openIndex; i < code.length; i++) {
		if (code[i] === open) depth++;
		else if (code[i] === close && --depth === 0) return i;
	}
	return -1;
}

function hasName(code, name) {
	return new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`).test(code);
}

function surfacedBinding(body, binding) {
	const names = new Set([binding]);
	let changed = true;
	while (changed) {
		changed = false;
		const assignmentRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^;\n]+)/g;
		for (const match of body.matchAll(assignmentRe)) {
			if (![...names].some((name) => hasName(match[2], name)) || names.has(match[1])) continue;
			names.add(match[1]);
			changed = true;
		}
	}

	for (const name of names) {
		const escaped = name.replace(/[$]/g, "\\$");
		if (new RegExp(`\\bthrow\\b[\\s\\S]*?\\b${escaped}\\b`).test(body)) return true;
		if (new RegExp(`\\breturn\\b[\\s\\S]*?\\b${escaped}\\b`).test(body)) return true;
	}

	const sinkRe = /(?:\b(?:logger|console|antMessage)\.\w+|\breject)\s*\(/g;
	for (const match of body.matchAll(sinkRe)) {
		const open = match.index + match[0].lastIndexOf("(");
		const close = matchingDelimiter(body, open, "(", ")");
		if (close === -1) continue;
		const args = body.slice(open + 1, close);
		if ([...names].some((name) => hasName(args, name))) return true;
	}
	return false;
}

export function findCatchSwallows(source, filename = "<source>") {
	const code = maskNonCode(source);
	const lines = source.split(/\r?\n/);
	const violations = [];
	const catchRe = /\bcatch\s*(?:\(\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\))?\s*\{/g;
	for (const match of code.matchAll(catchRe)) {
		const open = match.index + match[0].lastIndexOf("{");
		const close = matchingDelimiter(code, open, "{", "}");
		const line = source.slice(0, match.index).split(/\r?\n/).length;
		const catchLine = lines[line - 1] ?? "";
		const previousLine = lines[line - 2] ?? "";
		if (catchLine.includes(ALLOW_MARKER) || previousLine.includes(ALLOW_MARKER)) continue;
		if (close === -1) {
			violations.push({ file: filename, line, reason: "catch block has no matching closing brace" });
			continue;
		}
		const binding = match[1];
		if (!binding) {
			violations.push({ file: filename, line, reason: "catch has no error binding and cannot surface the failure" });
			continue;
		}
		const body = code.slice(open + 1, close);
		if (!surfacedBinding(body, binding)) {
			violations.push({ file: filename, line, reason: `caught error '${binding}' does not reach a log, user error, throw, rejection, or returned error` });
		}
	}
	return violations;
}

function walk(dir, extensions, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		if (name === "dist" || name === "node_modules") continue;
		const file = join(dir, name);
		if (statSync(file).isDirectory()) walk(file, extensions, out);
		else if (extensions.some((extension) => name.endsWith(extension))) out.push(file);
	}
	return out;
}

export function pluginSourceFiles(pluginDir = PLUGIN_DIR) {
	const roots = ["controller.ts", "instance.ts", "index.ts", "messages.ts", "control.ts", "helpers.ts"]
		.map((name) => join(pluginDir, name)).filter(existsSync);
	return [...roots, ...walk(join(pluginDir, "lib"), [".ts", ".tsx"]), ...walk(join(pluginDir, "web"), [".ts", ".tsx"])];
}

function runCli() {
	const violations = [];
	let catchCount = 0;
	for (const file of pluginSourceFiles()) {
		const source = readFileSync(file, "utf8");
		const rel = relative(REPO_DIR, file).replaceAll("\\", "/");
		violations.push(...findCatchSwallows(source, rel));
		catchCount += (maskNonCode(source).match(/\bcatch\s*(?:\([^)]*\))?\s*\{/g) ?? []).length;
	}
	if (violations.length) {
		console.error("lint:catch-swallow — FAILED\n");
		for (const violation of violations) console.error(`  ${violation.file}:${violation.line}  ${violation.reason}`);
		console.error(`\n${violations.length} catch block(s) may swallow errors. Surface the caught error or seek approval for // ${ALLOW_MARKER} <reason>.`);
		process.exitCode = 1;
		return;
	}
	console.log(`lint:catch-swallow — OK (${catchCount} catch block(s) surface their errors or are approved)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();
