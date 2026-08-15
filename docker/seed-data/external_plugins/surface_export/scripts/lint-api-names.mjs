#!/usr/bin/env node
// lint-api-names — every API member name read, written, probed or named as a string must exist at the pin.
// requires: scripts/factorio-api-index.json (vendored; regenerate with extract-factorio-api-index.mjs),
//           scripts/vendor/luaparse.cjs
// produces: exit 0 with a per-receiver summary, or exit 1 listing each unknown name with file:line,
//           whether it exists on another class, and the near-misses
// does not: infer receiver TYPES (a receiver is mapped to a class BY NAME, from module/ convention),
//           check subclass availability (a real member on the wrong subclass returns nil, not a throw,
//           so it is invisible here), check write permission, follow past the first hop, or reach the
//           network — the vendored index is the whole oracle

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "scripts", "factorio-api-index.json");
const luaparse = createRequire(import.meta.url)(path.join(ROOT, "scripts", "vendor", "luaparse.cjs"));

export const BARE_RECEIVERS = {
	entity: "LuaEntity",
	platform: "LuaSpacePlatform",
	surface: "LuaSurface",
	player: "LuaPlayer",
	force: "LuaForce",
};

export const PROBE_ONLY_RECEIVERS = {
	stack: "LuaItemStack",
	inventory: "LuaInventory",
};

export const RECEIVER_CLASS = { ...BARE_RECEIVERS, ...PROBE_ONLY_RECEIVERS };

const MIN_CHECKED_READS = 800;

function walk(node, visit) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (typeof node.type === "string") visit(node);
	for (const [key, value] of Object.entries(node)) {
		if (key === "loc" || key === "range") continue;
		if (value && typeof value === "object") walk(value, visit);
	}
}

function isDotMember(node) {
	return node.type === "MemberExpression" && node.indexer === "."
		&& node.base && node.base.type === "Identifier";
}

function probeReturnMembers(call) {
	const body = call.arguments[0].body;
	if (body.length !== 1 || body[0].type !== "ReturnStatement") return [];
	const members = [];
	for (const argument of body[0].arguments) {
		let expression = argument;
		while (expression.type === "CallExpression") expression = expression.base;
		if (isDotMember(expression)) members.push(expression);
	}
	return members;
}

export function collectReads(source, file) {
	const ast = luaparse.parse(source, { luaVersion: "5.2", scope: true, locations: true, comments: false });
	const reads = [];
	const claimed = new Set();

	walk(ast, node => {
		if (node.type !== "CallExpression" || !node.base) return;
		const isPcall = node.base.type === "Identifier" && node.base.name === "pcall"
			&& node.arguments[0] && node.arguments[0].type === "FunctionDeclaration";
		if (isPcall) {
			for (const member of probeReturnMembers(node)) {
				if (!RECEIVER_CLASS[member.base.name]) continue;
				claimed.add(member);
				reads.push({
					file, line: member.loc.start.line, receiver: member.base.name,
					name: member.identifier.name, context: "probe",
				});
			}
		}
		const isSafeGet = (node.base.type === "Identifier" && node.base.name === "safe_get")
			|| (node.base.type === "MemberExpression" && node.base.identifier.name === "safe_get");
		if (isSafeGet && node.arguments.length === 2
			&& node.arguments[0].type === "Identifier" && node.arguments[1].type === "StringLiteral") {
			const receiver = node.arguments[0].name;
			if (!RECEIVER_CLASS[receiver]) return;
			const literal = node.arguments[1];
			reads.push({
				file, line: node.loc.start.line, receiver,
				name: literal.value !== undefined && literal.value !== null
					? literal.value
					: literal.raw.slice(1, -1),
				context: "safe_get",
			});
		}
	});

	walk(ast, node => {
		if (!isDotMember(node)) return;
		if (!BARE_RECEIVERS[node.base.name]) return;
		if (claimed.has(node)) return;
		reads.push({
			file, line: node.loc.start.line, receiver: node.base.name,
			name: node.identifier.name, context: "bare",
		});
	});

	return reads;
}

function nearMisses(name, members) {
	const candidates = [];
	for (const member of Object.keys(members)) {
		if (member.includes(name) || name.includes(member)) {
			candidates.push(member);
			continue;
		}
		const shorter = member.length < name.length ? member : name;
		const longer = member.length < name.length ? name : member;
		if (longer.startsWith(shorter.slice(0, Math.max(4, shorter.length - 4)))) {
			candidates.push(member);
		}
	}
	return candidates.slice(0, 4);
}

export function classifyReads(reads, index) {
	const allMembers = new Set();
	for (const members of Object.values(index.classes)) {
		for (const name of Object.keys(members)) allMembers.add(name);
	}
	const failures = [];
	const perReceiver = new Map(Object.keys(RECEIVER_CLASS).map(receiver => [receiver, 0]));
	for (const read of reads) {
		const className = RECEIVER_CLASS[read.receiver];
		const members = index.classes[className];
		perReceiver.set(read.receiver, perReceiver.get(read.receiver) + 1);
		if (members[read.name]) continue;
		failures.push({
			...read,
			className,
			elsewhere: allMembers.has(read.name),
			near: nearMisses(read.name, members),
		});
	}
	return { checked: reads.length, failures, perReceiver, knownMembers: allMembers.size };
}

function luaFiles(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...luaFiles(full));
		else if (entry.endsWith(".lua")) out.push(full);
	}
	return out;
}

function main() {
	const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
	const missingClasses = [...new Set(Object.values(RECEIVER_CLASS))].filter(name => !index.classes[name]);
	if (missingClasses.length) {
		console.error(`lint:api-names CONTROL FAILURE: the vendored index has no ${missingClasses.join(", ")} — `
			+ "every read on that receiver would pass unchecked. Regenerate with extract-factorio-api-index.mjs.");
		process.exit(1);
	}
	if (Object.keys(index.classes.LuaEntity).length < 100) {
		console.error("lint:api-names CONTROL FAILURE: the vendored index has no plausible LuaEntity — "
			+ "refusing to lint against a broken oracle");
		process.exit(1);
	}

	const reads = [];
	for (const file of luaFiles(path.join(ROOT, "module"))) {
		const relative = path.relative(ROOT, file).replace(/\\/g, "/");
		const source = readFileSync(file, "utf8");
		try {
			reads.push(...collectReads(source, relative));
		} catch (err) {
			console.error(`lint:api-names CONTROL FAILURE: ${relative} did not parse (${err.message}). `
				+ "An unparsed file is an unchecked file — fix the syntax rather than letting the walk skip it.");
			process.exit(1);
		}
	}

	const { checked, failures, perReceiver, knownMembers } = classifyReads(reads, index);

	if (checked < MIN_CHECKED_READS) {
		console.error(`lint:api-names CONTROL FAILURE: only ${checked} member reads found in module/, below the `
			+ `${MIN_CHECKED_READS} floor. The walk or the member extraction matched almost nothing, which would `
			+ "pass vacuously.");
		process.exit(1);
	}
	const silentReceivers = [...perReceiver].filter(([, count]) => count === 0).map(([receiver]) => receiver);
	if (silentReceivers.length) {
		console.error(`lint:api-names CONTROL FAILURE: receiver(s) ${silentReceivers.join(", ")} contributed zero `
			+ "reads. Either the walk stopped seeing them or that receiver left module/ — confirm which, then "
			+ "fix the walk or drop the receiver from the map.");
		process.exit(1);
	}

	if (failures.length) {
		console.error(`lint:api-names — ${failures.length} unknown API name(s) at pin ${index.application_version}. `
			+ "A bare read of an absent member THROWS; the same name behind safe_get or a pcall probe reads as nil "
			+ "forever:");
		for (const failure of failures) {
			const elsewhere = failure.elsewhere
				? " (exists on ANOTHER class — wrong receiver, or this variable is not a "
					+ `${failure.className} here)`
				: "";
			const near = failure.near.length ? ` — near misses: ${failure.near.join(", ")}` : "";
			console.error(`  ${failure.file}:${failure.line}  [${failure.context}] ${failure.receiver}.`
				+ `${failure.name} is not a ${failure.className} member${elsewhere}${near}`);
		}
		process.exit(1);
	}

	const summary = [...perReceiver].map(([receiver, count]) => `${receiver}=${count}`).join(" ");
	console.log(`lint:api-names — OK (${checked} member reads verified against ${index.application_version}, `
		+ `${knownMembers} known members; ${summary})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
