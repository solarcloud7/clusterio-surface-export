// exclusions — read side of derived-exclusions.json
//
// requires: derived-exclusions.json beside this file (regenerate with derive-exclusions.mjs)
// produces: classify(class, member) -> "band" | "canonicalize" | "exclude" | null, and the raw
//           artifact for callers that want the derivation or the reviewed reason
// does not: derive anything (a stale artifact is a regeneration problem, not a read problem),
//           contact the cluster, or treat an unlisted member as anything but comparable-raw

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ARTIFACT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "derived-exclusions.json");

let cached = null;
let byId = null;

export function loadExclusions() {
	if (cached === null) {
		cached = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
		byId = new Map(cached.entries.map(entry => [`${entry.class}.${entry.member}`, entry]));
	}
	return cached;
}

export function classify(className, member) {
	loadExclusions();
	const entry = byId.get(`${className}.${member}`);
	return entry ? entry.classification : null;
}

export function entryFor(className, member) {
	loadExclusions();
	return byId.get(`${className}.${member}`) || null;
}

export function entriesForClass(className) {
	return loadExclusions().entries.filter(entry => entry.class === className);
}
