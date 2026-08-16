#!/usr/bin/env node
// derive-we-set — what the pipeline WRITES and what it CAPTURES, read mechanically off module source
//
// requires: module/core/deserializer.lua and module/export_scanners/entity-handlers.lua
// produces: we-set.json — restore-rule rows (field, property, gating types), per-category handler
//           capture field names (from `data.X =` assignments AND from the keys of a handler's
//           `local data = {...}` / `return {...}` constructor), direct entity property writes
//           (bare `entity.X =`, plus `RECV[VAR] =` whose VAR an enclosing `for _, VAR in
//           ipairs({"lit",...})` resolves to literals), receiver_writes (writes through a receiver
//           that is NOT the entity: a nested `entity.a.b =` chain, or a local bound to an
//           entity-derived value), and we_set: the union of properties the pipeline writes to an
//           ENTITY
// does not: contact the cluster, read the API index, prove restoration (a property in the WE-SET is
//           one the pipeline TRIES to set — the differ decides whether it landed), emit anything
//           when a floor or a known-member control fails, resolve a bracket index the enclosing
//           source does not bind to literals (`entity[prop]` driven by the restore-rule loop stays
//           unresolved — those properties enter we_set as restore rules, not as writes), or admit a
//           receiver_writes leaf into we_set (the receiver decides, never the leaf name: `cb`'s
//           `parameters` write is a LuaControlBehavior write even though LuaEntity also has a
//           `parameters` attribute)

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(here, "..", "..", "..",
	"docker", "seed-data", "external_plugins", "surface_export", "module");
const DESERIALIZER = path.join(MODULE_ROOT, "core", "deserializer.lua");
const HANDLERS = path.join(MODULE_ROOT, "export_scanners", "entity-handlers.lua");
const PHASES_DIR = path.join(MODULE_ROOT, "import_phases");
const OUT_PATH = path.join(here, "we-set.json");

export const SCHEMA = "one-of-each/we-set@1";
export const COMMON_CATEGORY = "*common*";

const MIN_RESTORE_RULES = 20;
const MIN_TYPES_GATED_RULES = 10;
const MIN_HANDLER_CATEGORIES = 25;
const MIN_HANDLER_FIELDS = 80;
const MIN_DIRECT_WRITES = 20;
const MIN_RECEIVER_WRITES = 3;

const RESTORE_RULE_CONTROLS = ["link_id", "override_logistic_mode", "crafting_progress",
	"result_quality", "switch_state"];
const HANDLER_CONTROLS = [["assembling-machine", "recipe"], ["inserter", "held_item"],
	["power-switch", "switch_state"], [COMMON_CATEGORY, "burner"]];
const CONSTRUCTOR_CAPTURE_CONTROLS = [["entity-ghost", "ghost_name"], ["transport-belt", "items"],
	["assembling-machine", "inventories"], ["underground-belt", "belt_to_ground_type"]];
const DIRECT_WRITE_CONTROLS = ["last_user", "health", "color", "orientation", "tick_grown"];
export const BRACKET_WRITE_CONTROLS = ["providing_to_other_platforms",
	"request_missing_construction_materials", "request_from_buffers", "mining_progress",
	"bonus_mining_progress"];
export const RECEIVER_WRITE_CONTROLS = [["entity.burner", "currently_burning"],
	["entity.burner", "remaining_burning_fuel"], ["entity.train", "schedule"],
	["entity.segmented_unit", "activity_mode"], ["entity.segmented_unit", "minimum_activity_mode"],
	["entity.get_control_behavior()", "parameters"]];
const WE_SET_EXCLUDED_CONTROLS = ["currently_burning", "schedule", "activity_mode",
	"minimum_activity_mode"];

export function matchedBlock(source, openIndex) {
	let depth = 0;
	for (let i = openIndex; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(openIndex, i + 1);
		}
	}
	throw new Error("unbalanced braces — the lexer desynced rather than reaching a closing brace");
}

export function extractRestoreRules(source) {
	const marker = "local SIMPLE_RESTORE_RULES = {";
	const start = source.indexOf(marker);
	if (start === -1) throw new Error("SIMPLE_RESTORE_RULES not found in deserializer.lua");
	const table = matchedBlock(source, start + marker.length - 1);
	const body = table.slice(1, -1);

	const rows = [];
	let depth = 0;
	let rowStart = -1;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "{") {
			if (depth === 0) rowStart = i;
			depth++;
		} else if (body[i] === "}") {
			depth--;
			if (depth === 0) rows.push(body.slice(rowStart, i + 1));
		}
	}

	return rows.map(row => {
		const field = (row.match(/field\s*=\s*"([^"]+)"/) || [])[1];
		if (!field) throw new Error(`a restore rule row carries no field: ${row.slice(0, 80)}`);
		const prop = (row.match(/prop\s*=\s*"([^"]+)"/) || [])[1] || null;
		const typesMatch = row.match(/types\s*=\s*\{/);
		let types = null;
		if (typesMatch) {
			const typesTable = matchedBlock(row, typesMatch.index + typesMatch[0].length - 1);
			types = [...typesTable.matchAll(/\["([^"]+)"\]/g)].map(m => m[1]).sort();
			if (types.length === 0) throw new Error(`restore rule ${field} has an empty types gate`);
		}
		return {
			field,
			property: prop || field,
			types,
			present: /\bpresent\s*=\s*true\b/.test(row),
			safecall: /\bsafecall\s*=\s*true\b/.test(row),
		};
	});
}

export function topLevelKeys(table) {
	const body = table.slice(1, -1);
	const keys = [];
	let depth = 0;
	let start = 0;
	const take = end => {
		const key = body.slice(start, end).match(/^\s*([a-z_][a-z0-9_]*)\s*=(?!=)/);
		if (key) keys.push(key[1]);
	};
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "{" || ch === "(") depth++;
		else if (ch === "}" || ch === ")") depth--;
		else if (ch === "," && depth === 0) { take(i); start = i + 1; }
	}
	take(body.length);
	return keys;
}

export function extractHandlerCaptures(source) {
	const lines = source.split("\n");
	const blocks = [];
	const aliases = [];
	let current = null;
	let offset = 0;

	for (const line of lines) {
		const lineStart = offset;
		offset += line.length + 1;
		const category = line.match(/^EntityHandlers\["([^"]+)"\]\s*=\s*function/);
		const alias = line.match(/^EntityHandlers\["([^"]+)"\]\s*=\s*EntityHandlers\["([^"]+)"\]/);
		const named = line.match(/^function EntityHandlers\.([a-z_]+)/);
		if (alias) {
			aliases.push({ category: alias[1], sameAs: alias[2] });
			current = null;
			continue;
		}
		if (category) {
			current = { category: category[1], fields: new Set() };
			blocks.push(current);
			continue;
		}
		if (named) {
			current = named[1] === "extract_common_state"
				? { category: COMMON_CATEGORY, fields: new Set() }
				: null;
			if (current) blocks.push(current);
			continue;
		}
		if (!current) continue;
		if (/^end\s*$/.test(line)) { current = null; continue; }
		for (const m of line.matchAll(/\bdata\.([a-z_][a-z0-9_]*)\s*=(?!=)/g)) current.fields.add(m[1]);
		const constructor = line.match(/(?:\blocal\s+data\s*=|\breturn)\s*\{/);
		if (constructor) {
			const brace = lineStart + constructor.index + constructor[0].length - 1;
			for (const key of topLevelKeys(matchedBlock(source, brace))) current.fields.add(key);
		}
	}

	const byCategory = new Map();
	for (const block of blocks) {
		const existing = byCategory.get(block.category) || new Set();
		for (const field of block.fields) existing.add(field);
		byCategory.set(block.category, existing);
	}
	for (const { category, sameAs } of aliases) {
		const target = byCategory.get(sameAs);
		if (!target) throw new Error(`handler alias ${category} points at ${sameAs}, which has no block`);
		byCategory.set(category, new Set(target));
	}

	return [...byCategory.entries()]
		.map(([category, fields]) => ({ category, fields: [...fields].sort() }))
		.sort((a, b) => a.category.localeCompare(b.category));
}

export function entityAliases(source) {
	const aliases = [];
	for (const m of source.matchAll(/\blocal\s+([a-z_][a-z0-9_]*)\s*=\s*(entity\.[a-z_][a-z0-9_]*)(\()?/g)) {
		aliases.push({ name: m[1], receiver: m[3] ? `${m[2]}()` : m[2], index: m.index });
	}
	return aliases;
}

export function aliasAt(aliases, name, index) {
	let nearest = null;
	for (const alias of aliases) {
		if (alias.name !== name || alias.index >= index) continue;
		if (nearest === null || alias.index > nearest.index) nearest = alias;
	}
	return nearest && nearest.receiver;
}

function indexLiterals(source) {
	const bound = new Map();
	for (const m of source.matchAll(
		/\bfor\s+[a-z_][a-z0-9_]*\s*,\s*([a-z_][a-z0-9_]*)\s+in\s+ipairs\(\s*\{([^}]*)\}\s*\)/g)) {
		const names = [...m[2].matchAll(/"([a-z_][a-z0-9_]*)"/g)].map(literal => literal[1]);
		if (names.length) bound.set(m[1], names);
	}
	return bound;
}

function isEntityReceiver(receiver) {
	return receiver.split(".").pop() === "entity";
}

export function scanWrites(source) {
	const aliases = entityAliases(source);
	const bound = indexLiterals(source);
	const writes = [];

	for (const m of source.matchAll(/\bentity\.([a-z_][a-z0-9_]*)\s*=(?!=)/g)) {
		writes.push({ receiver: "entity", property: m[1] });
	}
	for (const m of source.matchAll(/\bentity\.([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\s*=(?!=)/g)) {
		writes.push({ receiver: `entity.${m[1]}`, property: m[2] });
	}
	for (const name of new Set(aliases.map(alias => alias.name))) {
		for (const m of source.matchAll(new RegExp(`\\b${name}\\.([a-z_][a-z0-9_]*)\\s*=(?!=)`, "g"))) {
			const receiver = aliasAt(aliases, name, m.index);
			if (receiver) writes.push({ receiver, property: m[1] });
		}
	}
	for (const m of source.matchAll(/\b([a-z_][a-z0-9_.]*)\[([a-z_][a-z0-9_]*)\]\s*=(?!=)/g)) {
		const receiver = isEntityReceiver(m[1]) ? m[1] : aliasAt(aliases, m[1], m.index);
		if (!receiver) continue;
		for (const property of bound.get(m[2]) || []) writes.push({ receiver, property });
	}

	return writes;
}

function collect(files, keep, shape) {
	const rows = new Map();
	for (const { rel, source } of files) {
		for (const write of scanWrites(source)) {
			if (!keep(write)) continue;
			const key = shape(write).join("\0");
			const existing = rows.get(key) || { write, files: new Set() };
			existing.files.add(rel);
			rows.set(key, existing);
		}
	}
	return rows;
}

export function extractDirectWrites(files) {
	const rows = collect(files, write => isEntityReceiver(write.receiver), write => [write.property]);
	return [...rows.values()]
		.map(({ write, files: seen }) => ({ property: write.property, files: [...seen].sort() }))
		.sort((a, b) => a.property.localeCompare(b.property));
}

export function extractReceiverWrites(files) {
	const rows = collect(files, write => !isEntityReceiver(write.receiver),
		write => [write.receiver, write.property]);
	return [...rows.values()]
		.map(({ write, files: seen }) => ({
			receiver: write.receiver, property: write.property, files: [...seen].sort(),
		}))
		.sort((a, b) => a.receiver.localeCompare(b.receiver) || a.property.localeCompare(b.property));
}

export function assemble({ deserializerSource, handlerSource, phaseFiles }) {
	const restoreRules = extractRestoreRules(deserializerSource);
	const handlerCaptures = extractHandlerCaptures(handlerSource);
	const writeFiles = [{ rel: "core/deserializer.lua", source: deserializerSource }, ...phaseFiles];
	const directWrites = extractDirectWrites(writeFiles);
	const receiverWrites = extractReceiverWrites(writeFiles);

	const weSet = new Map();
	for (const rule of restoreRules) {
		const existing = weSet.get(rule.property);
		const types = rule.types;
		if (!existing) {
			weSet.set(rule.property, { property: rule.property, types: types ? [...types] : null, origins: ["restore_rule"] });
		} else if (existing.types && types) {
			existing.types = [...new Set([...existing.types, ...types])].sort();
		} else {
			existing.types = null;
		}
	}
	for (const write of directWrites) {
		const existing = weSet.get(write.property);
		if (!existing) weSet.set(write.property, { property: write.property, types: null, origins: ["direct_write"] });
		else if (!existing.origins.includes("direct_write")) existing.origins.push("direct_write");
	}

	return {
		schema: SCHEMA,
		sources: {
			restore_rules: "module/core/deserializer.lua",
			handler_captures: "module/export_scanners/entity-handlers.lua",
			direct_writes: ["module/core/deserializer.lua", "module/import_phases/*.lua"],
			receiver_writes: ["module/core/deserializer.lua", "module/import_phases/*.lua"],
		},
		restore_rules: restoreRules,
		handler_captures: handlerCaptures,
		direct_writes: directWrites,
		receiver_writes: receiverWrites,
		we_set: [...weSet.values()].sort((a, b) => a.property.localeCompare(b.property)),
		counts: {
			restore_rules: restoreRules.length,
			types_gated_rules: restoreRules.filter(rule => rule.types !== null).length,
			handler_categories: handlerCaptures.length,
			handler_fields: new Set(handlerCaptures.flatMap(row => row.fields)).size,
			direct_writes: directWrites.length,
			receiver_writes: receiverWrites.length,
			we_set: weSet.size,
		},
	};
}

export function checkControls(artifact) {
	const failures = [];
	const { counts } = artifact;

	const floors = [
		["restore_rules", counts.restore_rules, MIN_RESTORE_RULES],
		["types_gated_rules", counts.types_gated_rules, MIN_TYPES_GATED_RULES],
		["handler_categories", counts.handler_categories, MIN_HANDLER_CATEGORIES],
		["handler_fields", counts.handler_fields, MIN_HANDLER_FIELDS],
		["direct_writes", counts.direct_writes, MIN_DIRECT_WRITES],
		["receiver_writes", counts.receiver_writes, MIN_RECEIVER_WRITES],
	];
	for (const [name, actual, floor] of floors) {
		if (!(actual >= floor)) failures.push(`${name} extracted ${actual}, floor is ${floor} — a lexer that `
			+ "desyncs returns few rows, not zero, so the floor is the control");
	}

	const ruleFields = new Set(artifact.restore_rules.map(rule => rule.field));
	for (const control of RESTORE_RULE_CONTROLS) {
		if (!ruleFields.has(control)) failures.push(`restore rule "${control}" went missing from the extraction`);
	}

	const captures = new Map(artifact.handler_captures.map(row => [row.category, new Set(row.fields)]));
	for (const [category, field] of [...HANDLER_CONTROLS, ...CONSTRUCTOR_CAPTURE_CONTROLS]) {
		if (!captures.get(category)?.has(field)) {
			failures.push(`handler capture ${category}.${field} went missing from the extraction`);
		}
	}

	const written = new Set(artifact.direct_writes.map(row => row.property));
	for (const control of [...DIRECT_WRITE_CONTROLS, ...BRACKET_WRITE_CONTROLS]) {
		if (!written.has(control)) failures.push(`direct write "${control}" went missing from the extraction`);
	}

	const throughReceiver = new Set((artifact.receiver_writes || [])
		.map(row => `${row.receiver}.${row.property}`));
	for (const [receiver, property] of RECEIVER_WRITE_CONTROLS) {
		if (!throughReceiver.has(`${receiver}.${property}`)) {
			failures.push(`receiver write "${receiver}.${property}" went missing from the extraction`);
		}
	}

	const entityProperties = new Set(artifact.we_set.map(row => row.property));
	for (const property of WE_SET_EXCLUDED_CONTROLS) {
		if (entityProperties.has(property)) {
			failures.push(`"${property}" is written only through a non-entity receiver, so its presence in `
				+ "the WE-SET means the receiver stopped deciding membership and the leaf name started — "
				+ "the differ would then assert it on every entity and report it unwalked forever");
		}
	}

	const alias = artifact.handler_captures.find(row => row.category === "loader-1x1");
	const target = artifact.handler_captures.find(row => row.category === "loader");
	if (!alias || !target || alias.fields.join(",") !== target.fields.join(",")) {
		failures.push("the loader-1x1 = loader alias did not resolve — an aliased handler contributes no "
			+ "fields, which reads as a category the pipeline captures nothing for");
	}

	return failures;
}

function main() {
	const phaseFiles = readdirSync(PHASES_DIR).filter(name => name.endsWith(".lua"))
		.map(name => ({ rel: `import_phases/${name}`, source: readFileSync(path.join(PHASES_DIR, name), "utf8") }));
	const artifact = assemble({
		deserializerSource: readFileSync(DESERIALIZER, "utf8"),
		handlerSource: readFileSync(HANDLERS, "utf8"),
		phaseFiles,
	});

	const failures = checkControls(artifact);
	if (failures.length) {
		console.error("derive-we-set CONTROL FAILURE — refusing to write we-set.json:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}

	writeFileSync(OUT_PATH, JSON.stringify(artifact, null, "\t") + "\n");
	const c = artifact.counts;
	console.log(`wrote ${OUT_PATH}: ${c.restore_rules} restore rules (${c.types_gated_rules} types-gated), `
		+ `${c.handler_categories} handler categories carrying ${c.handler_fields} distinct fields, `
		+ `${c.direct_writes} direct writes, ${c.receiver_writes} writes through non-entity receivers, `
		+ `WE-SET ${c.we_set} properties`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
