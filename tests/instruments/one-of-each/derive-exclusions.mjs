#!/usr/bin/env node
// derive-exclusions — the comparator's do-not-compare-raw list, derived from Wube's own docs
//
// requires: the vendored scripts/factorio-api-index.json (doc + merged inheritance) and a FULL
//           runtime-api.json at the same pin — --api <path>, else fetched from
//           https://lua-api.factorio.com/<pin>/runtime-api.json, because the vendored index drops
//           read_type and the object-valued derivation is a read_type question
// produces: derived-exclusions.json — one entry per scoped class member the differ must not
//           compare raw, each carrying the derivation that produced it, plus the reviewed manual
//           residue from manual-exclusions.json
// does not: contact the cluster, read module source, decide what the pipeline SETS (that is
//           derive-we-set.mjs), accept a manual entry without a reason, or write anything when a
//           control fails

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadIndex } from "../../../tools/tests/testkit/api-oracle.mjs";
import { absoluteTickAttributes }
	from "../../../docker/seed-data/external_plugins/surface_export/scripts/lint-tick-portability.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MANUAL_PATH = path.join(here, "manual-exclusions.json");
const OUT_PATH = path.join(here, "derived-exclusions.json");

export const SCHEMA = "one-of-each/derived-exclusions@1";
export const SCOPE_CLASSES = ["LuaEntity", "LuaItemStack", "LuaInventory", "LuaTrain", "LuaSpacePlatform"];
export const IDENTITY_DOC_RE = /^A unique number|^The unique|unique number identifying|^The index of this/i;
export const CLASSIFICATIONS = ["band", "canonicalize", "exclude"];

const CLOCK_CONTROLS = ["character_corpse_tick_of_death", "spoil_tick", "tick_grown",
	"tick_of_last_attack", "tick_of_last_damage"];
const IDENTITY_CONTROLS = ["LuaEntity.unit_number", "LuaItemStack.item_number",
	"LuaSpacePlatform.index", "LuaTrain.id"];
const OBJECT_CONTROLS = { LuaEntity: { total: 61, own: 51, inherited: 10 } };
const UNCLASSIFIED_CONTROL = "LuaEntity.link_id";

const OBJECT_RULE = "read_type names a Lua class, recursing through array/dictionary/union; "
	+ "a table complex_type is a plain Lua table and is serialized, not canonicalized";

export function mentionsClass(type, classNames) {
	if (type === null || type === undefined) return false;
	if (typeof type === "string") return classNames.has(type);
	switch (type.complex_type) {
		case "array": return mentionsClass(type.value, classNames);
		case "dictionary": return mentionsClass(type.key, classNames) || mentionsClass(type.value, classNames);
		case "union": return type.options.some(option => mentionsClass(option, classNames));
		case "literal": return false;
		case "table": return false;
		default: throw new Error(`unhandled complex_type "${type.complex_type}" — an unenumerated type `
			+ "shape would silently read as not-object-valued, which is a MISSED canonicalization and "
			+ "therefore a false agreement. Enumerate it here.");
	}
}

export function mergedAttributes(api, className) {
	const byName = new Map(api.classes.map(cls => [cls.name, cls]));
	const merged = new Map();
	let current = byName.get(className);
	if (!current) throw new Error(`${className} is not in the runtime API document`);
	const seen = new Set();
	while (current) {
		if (seen.has(current.name)) throw new Error(`inheritance cycle at ${current.name}`);
		seen.add(current.name);
		for (const attribute of current.attributes) {
			if (!merged.has(attribute.name)) merged.set(attribute.name, { attribute, definingClass: current.name });
		}
		current = current.parent ? byName.get(current.parent) : null;
	}
	return merged;
}

export function deriveClocks(index) {
	const names = absoluteTickAttributes(index);
	const entries = [];
	for (const className of SCOPE_CLASSES) {
		const members = (index.classes || {})[className] || {};
		for (const name of names) {
			const member = members[name];
			if (!member || member.kind !== "attribute") continue;
			entries.push({
				class: className, member: name,
				definingClass: member.inherited_from || className,
				classification: "band", derivation: "absolute_clock", reason: null,
			});
		}
	}
	return { names, entries };
}

export function deriveIdentity(index) {
	const entries = [];
	for (const className of SCOPE_CLASSES) {
		const members = (index.classes || {})[className] || {};
		for (const [name, member] of Object.entries(members)) {
			if (member.kind !== "attribute") continue;
			if (typeof member.doc !== "string" || !IDENTITY_DOC_RE.test(member.doc)) continue;
			entries.push({
				class: className, member: name,
				definingClass: member.inherited_from || className,
				classification: "exclude", derivation: "identity", reason: null,
			});
		}
	}
	return entries;
}

export function deriveObjectValued(api) {
	const classNames = new Set(api.classes.map(cls => cls.name));
	const entries = [];
	for (const className of SCOPE_CLASSES) {
		for (const [name, { attribute, definingClass }] of mergedAttributes(api, className)) {
			if (attribute.read_type === null || attribute.read_type === undefined) continue;
			if (!mentionsClass(attribute.read_type, classNames)) continue;
			entries.push({
				class: className, member: name, definingClass,
				classification: "canonicalize", derivation: "object_valued", reason: null,
			});
		}
	}
	return entries;
}

export function loadManual(index, raw) {
	const entries = [];
	for (const entry of raw.entries || []) {
		const id = `${entry.class}.${entry.member}`;
		if (!entry.class || !entry.member) throw new Error(`manual entry without class/member: ${JSON.stringify(entry)}`);
		if (!SCOPE_CLASSES.includes(entry.class)) throw new Error(`manual entry ${id} is outside the derivation scope`);
		if (!CLASSIFICATIONS.includes(entry.classification)) {
			throw new Error(`manual entry ${id} carries classification "${entry.classification}"`);
		}
		if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
			throw new Error(`manual entry ${id} has no reason — every exclusion the docs do not derive is a `
				+ "judgement, and an unreasoned judgement is indistinguishable from a mistake");
		}
		const member = ((index.classes || {})[entry.class] || {})[entry.member];
		if (!member) throw new Error(`manual entry ${id} names a member that does not exist at this pin`);
		if (entry.assert_read_only === true && member.write !== false) {
			throw new Error(`manual entry ${id} claims read-only, but the index says write=${member.write}`);
		}
		entries.push({
			class: entry.class, member: entry.member,
			definingClass: member.inherited_from || entry.class,
			classification: entry.classification, derivation: "manual", reason: entry.reason,
		});
	}
	return entries;
}

export function assemble({ index, api, manualRaw }) {
	const clocks = deriveClocks(index);
	const identity = deriveIdentity(index);
	const objects = deriveObjectValued(api);
	const manual = loadManual(index, manualRaw);

	const byId = new Map();
	for (const entry of [...identity, ...clocks.entries, ...objects, ...manual]) {
		const id = `${entry.class}.${entry.member}`;
		const prior = byId.get(id);
		if (prior && prior.classification !== entry.classification) {
			throw new Error(`${id} derives as both "${prior.classification}" (${prior.derivation}) and `
				+ `"${entry.classification}" (${entry.derivation}) — the differ cannot hold two rules for one cell`);
		}
		if (!prior) byId.set(id, entry);
	}
	const entries = [...byId.values()]
		.sort((a, b) => a.class.localeCompare(b.class) || a.member.localeCompare(b.member));

	const counts = {};
	for (const entry of entries) counts[entry.derivation] = (counts[entry.derivation] || 0) + 1;

	return {
		schema: SCHEMA,
		source: api.__source,
		application_version: api.application_version,
		api_version: api.api_version,
		scope_classes: SCOPE_CLASSES,
		derivations: {
			absolute_clock: {
				classification: "band",
				derived_by: "scripts/lint-tick-portability.mjs absoluteTickAttributes()",
				names: clocks.names, count: counts.absolute_clock || 0,
			},
			object_valued: { classification: "canonicalize", rule: OBJECT_RULE, count: counts.object_valued || 0 },
			identity: {
				classification: "exclude", doc_pattern: IDENTITY_DOC_RE.source,
				count: counts.identity || 0,
			},
			manual: { classification: "exclude", count: counts.manual || 0 },
		},
		entries,
	};
}

export function checkControls(artifact) {
	const failures = [];
	const idOf = entry => `${entry.class}.${entry.member}`;

	const clockNames = artifact.derivations.absolute_clock.names;
	if (clockNames.join(",") !== CLOCK_CONTROLS.join(",")) {
		failures.push(`absolute_clock derived [${clockNames}] — expected exactly [${CLOCK_CONTROLS}]`);
	}

	const identityIds = artifact.entries.filter(e => e.derivation === "identity").map(idOf).sort();
	if (identityIds.join(",") !== [...IDENTITY_CONTROLS].sort().join(",")) {
		failures.push(`identity derived [${identityIds}] — expected exactly [${IDENTITY_CONTROLS}]`);
	}

	for (const [className, expected] of Object.entries(OBJECT_CONTROLS)) {
		const rows = artifact.entries.filter(e => e.derivation === "object_valued" && e.class === className);
		const own = rows.filter(e => e.definingClass === className).length;
		const inherited = rows.length - own;
		if (rows.length !== expected.total || own !== expected.own || inherited !== expected.inherited) {
			failures.push(`object_valued ${className} derived ${rows.length} (own ${own}, inherited ${inherited}) — `
				+ `expected ${expected.total} (own ${expected.own}, inherited ${expected.inherited}); an inheritance `
				+ "chain that stopped merging lands exactly here");
		}
	}

	if (artifact.entries.some(e => idOf(e) === UNCLASSIFIED_CONTROL)) {
		failures.push(`${UNCLASSIFIED_CONTROL} is classified — the pipeline restores it `
			+ "(entity-handlers.lua captures it, deserializer.lua writes it), so a derivation that excludes it "
			+ "would hide a real loss");
	}

	if (!artifact.entries.some(e => e.derivation === "manual")) {
		failures.push("no manual entries survived — the reviewed residue vanished");
	}

	return failures;
}

async function loadApi(argv) {
	const index = loadIndex();
	const pinArg = argv.indexOf("--pin");
	const pin = pinArg === -1 ? index.application_version : argv[pinArg + 1];
	const apiArg = argv.indexOf("--api");
	const url = `https://lua-api.factorio.com/${pin}/runtime-api.json`;

	let api;
	if (apiArg !== -1) {
		api = JSON.parse(readFileSync(argv[apiArg + 1], "utf8"));
	} else {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`fetch failed: ${response.status} ${response.statusText} for ${url}`);
		api = await response.json();
	}
	if (api.application_version !== pin) {
		throw new Error(`refusing: the runtime API document says application_version=${api.application_version}, not ${pin}`);
	}
	if (api.application_version !== index.application_version) {
		throw new Error(`refusing: runtime API is ${api.application_version} but the vendored index is `
			+ `${index.application_version} — the two derivations would describe different engines`);
	}
	api.__source = url;
	return { index, api };
}

async function main() {
	const { index, api } = await loadApi(process.argv);
	const manualRaw = JSON.parse(readFileSync(MANUAL_PATH, "utf8"));
	const artifact = assemble({ index, api, manualRaw });

	const failures = checkControls(artifact);
	if (failures.length) {
		console.error("derive-exclusions CONTROL FAILURE — refusing to write derived-exclusions.json:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}

	writeFileSync(OUT_PATH, JSON.stringify(artifact, null, "\t") + "\n");
	const { absolute_clock, object_valued, identity, manual } = artifact.derivations;
	console.log(`wrote ${OUT_PATH}: ${artifact.entries.length} entries at pin ${artifact.application_version} `
		+ `(band ${absolute_clock.count}, canonicalize ${object_valued.count}, `
		+ `exclude ${identity.count + manual.count} = identity ${identity.count} + manual ${manual.count})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
