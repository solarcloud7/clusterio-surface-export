#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(SCRIPT_DIR, "..");
const REPO_DIR = join(PLUGIN_DIR, "..", "..", "..", "..");
const ALLOW_MARKER = "catch:allow";

const REGEX_PRECEDING_KEYWORDS = new Set([
	"return", "typeof", "case", "in", "of", "delete", "void", "new", "do", "else", "yield", "await", "instanceof",
]);

function startsRegex(out, index) {
	let j = index - 1;
	while (j >= 0 && /\s/.test(out[j])) j--;
	if (j < 0) return true;
	const prev = out[j];
	if (/[A-Za-z0-9_$]/.test(prev)) {
		let start = j;
		while (start > 0 && /[A-Za-z_$]/.test(out[start - 1])) start--;
		return REGEX_PRECEDING_KEYWORDS.has(out.slice(start, j + 1).join(""));
	}
	if ((prev === "+" && out[j - 1] === "+") || (prev === "-" && out[j - 1] === "-")) return false;
	return prev !== ")" && prev !== "]";
}

function maskNonCode(source, filename = "<source>") {
	const out = [...source];
	const states = [{ kind: "code", templateDepth: null }];
	const blank = (index) => { if (source[index] !== "\n" && source[index] !== "\r") out[index] = " "; };
	const desync = (state, index) => {
		const line = source.slice(0, state.openedAt ?? index).split("\n").length;
		const error = new Error(`maskNonCode desynced in ${filename}: unterminated ${state.kind} from ` +
			`line ${line} — the lexer cannot parse this construct; extend maskNonCode, do not exempt the file`);
		error.desyncLine = line;
		throw error;
	};

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
			if (source[i] === "\n") desync(state, i);
			blank(i);
			if (source[i] === "\\") { blank(i + 1); i++; }
			else if (source[i] === state.quote) states.pop();
			continue;
		}
		if (state.kind === "regex") {
			if (source[i] === "\n") desync(state, i);
			blank(i);
			if (source[i] === "\\") { blank(i + 1); i++; }
			else if (source[i] === "[") state.inClass = true;
			else if (source[i] === "]") state.inClass = false;
			else if (source[i] === "/" && !state.inClass) states.pop();
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
		if (source[i] === "/" && next === "*") { blank(i); blank(i + 1); i++; states.push({ kind: "block-comment", openedAt: i }); continue; }
		if (source[i] === "/" && (source[i - 1] === "<" || next === ">")) { }
		else if (source[i] === "/" && startsRegex(out, i)) {
			blank(i);
			states.push({ kind: "regex", inClass: false, openedAt: i });
			continue;
		}
		if ((source[i] === "'" || source[i] === '"') && /[A-Za-z0-9_$]/.test(source[i - 1] ?? "")) { continue; }
		if (source[i] === "'" || source[i] === '"') { blank(i); states.push({ kind: "quote", quote: source[i], openedAt: i }); continue; }
		if (source[i] === "`") { blank(i); states.push({ kind: "template", openedAt: i }); continue; }
		if (state.templateDepth !== null) {
			if (source[i] === "{") state.templateDepth++;
			if (source[i] === "}" && --state.templateDepth === 0) states.pop();
		}
	}
	if (states.length > 1) desync(states.at(-1), source.length);
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

	const declaredLocally = (root) =>
		new RegExp(`\\b(?:const|let|var)\\s+${root.replace(/[$]/g, "\\$")}\\b`).test(body);
	const assignRe = /(?<![.\w$])([A-Za-z_$][\w$]*(?:\s*(?:\.\s*[A-Za-z_$][\w$]*|\[[^\]]*\]))*)\s*(?:\*\*|[+\-*/%&|^]|\?\?|\|\||&&)?=(?![=>])([^;\n]+)/g;
	for (const match of body.matchAll(assignRe)) {
		const root = match[1].match(/^[A-Za-z_$][\w$]*/)[0];
		if (declaredLocally(root)) continue;
		if ([...names].some((name) => hasName(match[2], name))) return true;
	}

	const pushRe = /([A-Za-z_$][\w$]*)((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]]*\])*)\s*\.\s*push\s*\(/g;
	for (const match of body.matchAll(pushRe)) {
		if (declaredLocally(match[1])) continue;
		const open = match.index + match[0].lastIndexOf("(");
		const close = matchingDelimiter(body, open, "(", ")");
		if (close === -1) continue;
		if ([...names].some((name) => hasName(body.slice(open + 1, close), name))) return true;
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
	const promiseCatchRe = /\.\s*catch\s*\(\s*(?:\(\s*(?:[A-Za-z_$][\w$]*)?\s*\)|[A-Za-z_$][\w$]*)?\s*=>\s*\{\s*\}\s*\)/g;
	for (const match of code.matchAll(promiseCatchRe)) {
		const line = source.slice(0, match.index).split(/\r?\n/).length;
		const catchLine = lines[line - 1] ?? "";
		const previousLine = lines[line - 2] ?? "";
		if (catchLine.includes(ALLOW_MARKER) || previousLine.includes(ALLOW_MARKER)) continue;
		violations.push({ file: filename, line, reason: "promise .catch with an empty body discards the rejection" });
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

export function repoRootMjsFiles(repoDir = REPO_DIR) {
	const scanDirs = [join(repoDir, "tools"), join(repoDir, "tests")];
	const missing = scanDirs.filter((dir) => !existsSync(dir));
	if (missing.length > 0) {
		if (/^([a-z]:)?\/clusterio\/external_plugins\//i.test(SCRIPT_DIR.replace(/\\/g, "/"))) return null;
		throw new Error(`repo-root scan dir(s) missing: ${missing.map((dir) => relative(repoDir, dir)).join(", ")}`);
	}
	return scanDirs.flatMap((dir) => walk(dir, [".mjs"]));
}

function runCli() {
	const violations = [];
	let catchCount = 0;
	const scan = (files) => {
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			const rel = relative(REPO_DIR, file).replaceAll("\\", "/");
			try {
				violations.push(...findCatchSwallows(source, rel));
				catchCount += (maskNonCode(source, rel).match(/\bcatch\s*(?:\([^)]*\))?\s*\{/g) ?? []).length;
			} catch (error) {
				violations.push({ file: rel, line: error.desyncLine ?? 1, reason: error.message });
			}
		}
	};
	scan(pluginSourceFiles());

	let surfaceNote = "";
	let mjsFiles;
	try {
		mjsFiles = repoRootMjsFiles();
	} catch (err) {
		for (const violation of violations) console.error(`  ${violation.file}:${violation.line}  ${violation.reason}`);
		console.error(`lint:catch-swallow — FAILED: ${err.message}`);
		process.exitCode = 1;
		return;
	}
	if (mjsFiles === null) {
		surfaceNote = "; repo-root .mjs skipped (plugin-only container mount)";
	} else if (mjsFiles.length === 0) {
		console.error("lint:catch-swallow — FAILED: repo-root tools/ and tests/ contain zero .mjs files; " +
			"the integration runner and testkit are .mjs, so an empty scan surface means discovery is broken.");
		process.exitCode = 1;
		return;
	} else {
		scan(mjsFiles);
		surfaceNote = `; incl. ${mjsFiles.length} repo-root .mjs file(s)`;
	}
	if (violations.length) {
		console.error("lint:catch-swallow — FAILED\n");
		for (const violation of violations) console.error(`  ${violation.file}:${violation.line}  ${violation.reason}`);
		console.error(`\n${violations.length} catch block(s) may swallow errors. Surface the caught error or seek approval for // ${ALLOW_MARKER} <reason>.`);
		process.exitCode = 1;
		return;
	}
	console.log(`lint:catch-swallow — OK (${catchCount} catch block(s) surface their errors or are approved${surfaceNote})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();
