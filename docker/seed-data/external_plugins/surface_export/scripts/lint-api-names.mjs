#!/usr/bin/env node
// lint-api-names — every API member name written as a string or probe must exist at the pin.
// requires: scripts/factorio-api-index.json (vendored; regenerate with extract-factorio-api-index.mjs)
// produces: exit 0 with a summary, or exit 1 listing each unknown name with file:line and near-misses
// does not: verify receiver TYPES (an `entity` receiver is assumed LuaEntity), check values or
//          signatures, or reach the network — the index is the whole oracle

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = path.join(ROOT, "scripts", "factorio-api-index.json");
const index = JSON.parse(readFileSync(INDEX_PATH, "utf8"));
const luaEntity = index.classes.LuaEntity;
if (!luaEntity || Object.keys(luaEntity).length < 100) {
	console.error("lint-api-names: the vendored index has no plausible LuaEntity — refusing to lint against a broken oracle");
	process.exit(1);
}

const allMembers = new Set();
for (const members of Object.values(index.classes)) {
	for (const name of Object.keys(members)) {
		allMembers.add(name);
	}
}

function* luaFiles(dir) {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			yield* luaFiles(full);
		} else if (entry.endsWith(".lua")) {
			yield full;
		}
	}
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

const SAFE_GET = /safe_get\(\s*entity\s*,\s*"([a-z_0-9]+)"\s*\)/g;
const ENTITY_PROBE = /pcall\(\s*function\(\)\s*return\s+entity\.([a-zA-Z_0-9]+)/g;
const ENTITY_GHOST_OK = new Set(["ghost_name", "ghost_type", "ghost_prototype", "ghost_localised_name"]);

const failures = [];
let checked = 0;
for (const file of luaFiles(path.join(ROOT, "module"))) {
	const source = readFileSync(file, "utf8");
	const relative = path.relative(ROOT, file);
	for (const pattern of [SAFE_GET, ENTITY_PROBE]) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(source)) !== null) {
			const name = match[1];
			checked += 1;
			if (luaEntity[name] || ENTITY_GHOST_OK.has(name)) {
				continue;
			}
			const line = source.slice(0, match.index).split("\n").length;
			const elsewhere = allMembers.has(name)
				? " (exists on ANOTHER class — wrong receiver, or the entity variable is not a LuaEntity here)"
				: "";
			const near = nearMisses(name, luaEntity);
			failures.push(`${relative}:${line}  entity.${name} is not a LuaEntity member at pin `
				+ `${index.application_version}${elsewhere}`
				+ (near.length ? ` — near misses: ${near.join(", ")}` : ""));
		}
	}
}

if (failures.length) {
	console.error(`lint:api-names — ${failures.length} unknown API name(s) (a wrong name reads as nil forever; `
		+ "this is how driver_is_main_gunner shipped silent for months):");
	for (const failure of failures) {
		console.error("  " + failure);
	}
	process.exit(1);
}
console.log(`lint:api-names — OK (${checked} entity member reads verified against `
	+ `${index.application_version}, ${allMembers.size} known members)`);
