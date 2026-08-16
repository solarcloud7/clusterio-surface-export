#!/usr/bin/env node
// derive-we-set — what the pipeline WRITES and what it CAPTURES, read mechanically off module source
//
// requires: module/core/deserializer.lua and module/export_scanners/entity-handlers.lua
// produces: we-set.json — restore-rule rows (field, property, gating types), per-category handler
//           capture field names, direct entity property writes, and we_set: the union of properties
//           the pipeline actually writes to an entity
// does not: contact the cluster, read the API index, prove restoration (a property in the WE-SET is
//           one the pipeline TRIES to set — the differ decides whether it landed), or emit anything
//           when a floor or a known-member control fails

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

const RESTORE_RULE_CONTROLS = ["link_id", "override_logistic_mode", "crafting_progress",
	"result_quality", "switch_state"];
const HANDLER_CONTROLS = [["assembling-machine", "recipe"], ["inserter", "held_item"],
	["power-switch", "switch_state"], [COMMON_CATEGORY, "burner"]];
const DIRECT_WRITE_CONTROLS = ["last_user", "health", "color", "orientation", "tick_grown"];

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

export function extractHandlerCaptures(source) {
	const lines = source.split("\n");
	const blocks = [];
	const aliases = [];
	let current = null;

	for (const line of lines) {
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
		for (const m of line.matchAll(/\bdata\.([a-z_][a-z0-9_]*)\s*=(?!=)/g)) current.fields.add(m[1]);
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

export function extractDirectWrites(files) {
	const byProperty = new Map();
	for (const { rel, source } of files) {
		for (const m of source.matchAll(/\bentity\.([a-z_][a-z0-9_]*)\s*=(?!=)/g)) {
			const existing = byProperty.get(m[1]) || new Set();
			existing.add(rel);
			byProperty.set(m[1], existing);
		}
	}
	return [...byProperty.entries()]
		.map(([property, files]) => ({ property, files: [...files].sort() }))
		.sort((a, b) => a.property.localeCompare(b.property));
}

export function assemble({ deserializerSource, handlerSource, phaseFiles }) {
	const restoreRules = extractRestoreRules(deserializerSource);
	const handlerCaptures = extractHandlerCaptures(handlerSource);
	const directWrites = extractDirectWrites([
		{ rel: "core/deserializer.lua", source: deserializerSource },
		...phaseFiles,
	]);

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
		},
		restore_rules: restoreRules,
		handler_captures: handlerCaptures,
		direct_writes: directWrites,
		we_set: [...weSet.values()].sort((a, b) => a.property.localeCompare(b.property)),
		counts: {
			restore_rules: restoreRules.length,
			types_gated_rules: restoreRules.filter(rule => rule.types !== null).length,
			handler_categories: handlerCaptures.length,
			handler_fields: new Set(handlerCaptures.flatMap(row => row.fields)).size,
			direct_writes: directWrites.length,
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
	];
	for (const [name, actual, floor] of floors) {
		if (actual < floor) failures.push(`${name} extracted ${actual}, floor is ${floor} — a lexer that `
			+ "desyncs returns few rows, not zero, so the floor is the control");
	}

	const ruleFields = new Set(artifact.restore_rules.map(rule => rule.field));
	for (const control of RESTORE_RULE_CONTROLS) {
		if (!ruleFields.has(control)) failures.push(`restore rule "${control}" went missing from the extraction`);
	}

	const captures = new Map(artifact.handler_captures.map(row => [row.category, new Set(row.fields)]));
	for (const [category, field] of HANDLER_CONTROLS) {
		if (!captures.get(category)?.has(field)) {
			failures.push(`handler capture ${category}.${field} went missing from the extraction`);
		}
	}

	const written = new Set(artifact.direct_writes.map(row => row.property));
	for (const control of DIRECT_WRITE_CONTROLS) {
		if (!written.has(control)) failures.push(`direct write "${control}" went missing from the extraction`);
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
		+ `${c.direct_writes} direct writes, WE-SET ${c.we_set} properties`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
