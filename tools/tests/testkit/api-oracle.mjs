// api-oracle — answer "does this member exist at the pin" without the network or a guess.
// requires: the plugin's vendored scripts/factorio-api-index.json
// produces: lookup(query) -> { ok, ... } ; a miss carries near-misses and the classes that DO have it
// does not: know signatures or types beyond read/write, reach lua-api.factorio.com, or verify values

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../docker/seed-data/external_plugins/surface_export/scripts/factorio-api-index.json",
);

let cached = null;
export function loadIndex() {
	if (!cached) {
		cached = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
	}
	return cached;
}

function nearMisses(name, members) {
	const scored = [];
	for (const candidate of Object.keys(members)) {
		if (candidate === name) continue;
		if (candidate.includes(name) || name.includes(candidate)) {
			scored.push([0, candidate]);
			continue;
		}
		const prefix = commonPrefix(candidate, name);
		if (prefix >= 4) {
			scored.push([1, candidate]);
		}
	}
	scored.sort((a, b) => a[0] - b[0]);
	return scored.slice(0, 5).map(([, candidate]) => candidate);
}

function commonPrefix(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
	return i;
}

export function lookup(query) {
	const index = loadIndex();
	const [className, memberName] = query.includes(".") ? query.split(".", 2) : [query, null];

	const cls = index.classes[className];
	if (!cls) {
		const classNear = Object.keys(index.classes)
			.filter(name => name.toLowerCase().includes(className.toLowerCase()))
			.slice(0, 5);
		return { ok: false, kind: "no_such_class", className, pin: index.application_version, near: classNear };
	}

	if (memberName === null) {
		return {
			ok: true, kind: "class", className, pin: index.application_version,
			memberCount: Object.keys(cls).length,
		};
	}

	const member = cls[memberName];
	if (member) {
		return { ok: true, kind: "member", className, memberName, pin: index.application_version, ...member };
	}

	const holders = [];
	for (const [otherName, members] of Object.entries(index.classes)) {
		if (members[memberName]) holders.push(otherName);
	}
	return {
		ok: false, kind: "no_such_member", className, memberName, pin: index.application_version,
		near: nearMisses(memberName, cls),
		existsOn: holders.slice(0, 6),
	};
}

export function formatLookup(result) {
	if (result.ok && result.kind === "class") {
		return `${result.className} exists at ${result.pin} (${result.memberCount} members incl. inherited)`;
	}
	if (result.ok) {
		const description = result.kind === "attribute"
			? `attribute ${result.read && result.write ? "RW" : result.read ? "R" : "W"}`
			: result.kind;
		return `${result.className}.${result.memberName} — ${description}`
			+ (result.inherited_from ? ` (inherited from ${result.inherited_from})` : "")
			+ ` at ${result.pin}`;
	}
	if (result.kind === "no_such_class") {
		return `NO such class '${result.className}' at ${result.pin}`
			+ (result.near.length ? ` — did you mean: ${result.near.join(", ")}` : "");
	}
	return `NO such member ${result.className}.${result.memberName} at ${result.pin}`
		+ (result.near.length ? `\n  near misses on ${result.className}: ${result.near.join(", ")}` : "")
		+ (result.existsOn.length ? `\n  '${result.memberName}' DOES exist on: ${result.existsOn.join(", ")}` : "");
}
