#!/usr/bin/env node
// extract-factorio-api-index — derive the vendored API-name index from Wube's machine-readable docs.
// requires: network access to lua-api.factorio.com (run at repin time, not in CI)
// produces: scripts/factorio-api-index.json — every class's attribute/method names with read/write
//          flags, plus per-attribute subclasses and first-sentence doc where upstream carries them
// does not: run in CI, validate anything itself (lint-api-names.mjs consumes the output), or keep
//          full descriptions — one sentence capped at 200 chars, so the index stays vendorable

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PIN = process.argv[2];
if (!PIN) {
	console.error("usage: node scripts/extract-factorio-api-index.mjs <factorio-version>   e.g. 2.1.11");
	process.exit(1);
}

const url = `https://lua-api.factorio.com/${PIN}/runtime-api.json`;
const response = await fetch(url);
if (!response.ok) {
	console.error(`fetch failed: ${response.status} ${response.statusText} for ${url}`);
	process.exit(1);
}
const api = await response.json();
if (api.application_version !== PIN) {
	console.error(`refusing: the served document says application_version=${api.application_version}, not ${PIN}`);
	process.exit(1);
}

const byName = new Map(api.classes.map(cls => [cls.name, cls]));

function firstSentence(description) {
	if (typeof description !== "string" || !description.trim()) return null;
	const plain = description.replace(/\[([^\]]+)\]\((?:runtime|prototype):[^)]*\)/g, "$1");
	const sentence = plain.split(/\.\s/)[0].trim();
	if (!sentence) return null;
	const capped = sentence.length > 200 ? sentence.slice(0, 197) + "..." : sentence;
	return capped.endsWith(".") || capped.endsWith("...") ? capped : capped + ".";
}

function ownMembers(cls) {
	const members = {};
	for (const attribute of cls.attributes) {
		const doc = firstSentence(attribute.description);
		members[attribute.name] = {
			kind: "attribute",
			read: Boolean(attribute.read_type),
			write: Boolean(attribute.write_type),
			...(Array.isArray(attribute.subclasses) && attribute.subclasses.length
				? { subclasses: attribute.subclasses } : {}),
			...(doc ? { doc } : {}),
		};
	}
	for (const method of cls.methods) {
		members[method.name] = { kind: "method" };
	}
	return members;
}

const classes = {};
for (const cls of api.classes) {
	const members = {};
	let current = cls;
	const seen = new Set();
	while (current) {
		if (seen.has(current.name)) {
			console.error(`refusing: inheritance cycle at ${current.name}`);
			process.exit(1);
		}
		seen.add(current.name);
		for (const [name, info] of Object.entries(ownMembers(current))) {
			if (!(name in members)) {
				members[name] = current === cls ? info : { ...info, inherited_from: current.name };
			}
		}
		current = current.parent ? byName.get(current.parent) : null;
	}
	classes[cls.name] = members;
}

const index = {
	source: url,
	application_version: api.application_version,
	api_version: api.api_version,
	classes,
};

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "factorio-api-index.json");
writeFileSync(out, JSON.stringify(index));
const classCount = Object.keys(classes).length;
const memberCount = Object.values(classes).reduce((n, m) => n + Object.keys(m).length, 0);
console.log(`wrote ${out}: ${classCount} classes, ${memberCount} members, pin ${api.application_version}`);
