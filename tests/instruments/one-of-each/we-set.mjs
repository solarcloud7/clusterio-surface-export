// we-set — read side of we-set.json
//
// requires: we-set.json beside this file (regenerate with derive-we-set.mjs)
// produces: loadWeSet() -> the artifact, plus lookups for the properties the pipeline writes and
//           the payload fields each handler category captures
// does not: derive anything, contact the cluster, or claim a WE-SET property SURVIVES — the set is
//           what the pipeline tries to write, and only a diff of two arms says whether it landed

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARTIFACT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "we-set.json");

let cached = null;
let byProperty = null;

export function loadWeSet() {
	if (cached === null) {
		cached = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
		byProperty = new Map(cached.we_set.map(row => [row.property, row]));
	}
	return cached;
}

export function weSetRow(property) {
	loadWeSet();
	return byProperty.get(property) || null;
}

export function writesProperty(property, entityType) {
	const row = weSetRow(property);
	if (!row) return false;
	return row.types === null || row.types.includes(entityType);
}

export function capturesFor(category) {
	const row = loadWeSet().handler_captures.find(entry => entry.category === category);
	return row ? row.fields : null;
}
