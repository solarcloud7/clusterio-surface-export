#!/usr/bin/env node
// derive-we-set — what the pipeline WRITES and what it CAPTURES, read mechanically off module source
//
// requires: the capture-side and import-side module sources named in CAPTURE_FILES/RESTORE_FILES
// produces: we-set.json — restore-rule rows (field, property, gating types), per-category handler
//           capture field names (from `data.X =` assignments AND from the keys of a handler's
//           `local data = {...}` / `return {...}` constructor), direct entity property writes
//           (bare `entity.X =`, plus `RECV[VAR] =` whose VAR an enclosing `for _, VAR in
//           ipairs({"lit",...})` resolves to literals), receiver_writes (writes through a receiver
//           that is NOT the entity: a nested `entity.a.b =` chain, or a local bound to an
//           entity-derived value), we_set: the union of properties the pipeline writes to an
//           ENTITY, reachability: the parsed-block arm that says which of those writes a return
//           above them cannot reach (reachability.mjs), every row and every refused function scope
//           matched against reachability-accounted.json in both directions — checkControls takes that
//           ledger as an argument (defaulting to the committed file) so both directions stay testable
//           whichever way the live ledger currently reads — and join: the capture/restore join
//           (capture-join.mjs) over the specific_data and per-entity planes, whose one-sided rows are
//           matched against capture-join-accounted.json in both directions the same way
// does not: contact the cluster, read the API index, prove restoration (a property in the WE-SET is
//           one the pipeline TRIES to set — the differ decides whether it landed), emit anything
//           when a floor or a known-member control fails, resolve a bracket index the enclosing
//           source does not bind to literals (`entity[prop]` driven by the restore-rule loop stays
//           unresolved — those properties enter we_set as restore rules, not as writes), admit a
//           receiver_writes leaf into we_set (the receiver decides, never the leaf name: `cb`'s
//           `parameters` write is a LuaControlBehavior write even though LuaEntity also has a
//           `parameters` attribute), drop a return-dominated write from direct_writes or from
//           we_set — the reachability arm ADDS a row beside them and never subtracts one — or join
//           the top-level payload plane, whose consumers are split across Lua and TS

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSources } from "./reachability.mjs";
import { analyzeJoin, joinKey } from "./capture-join.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MODULE_ROOT = path.join(here, "..", "..", "..",
	"docker", "seed-data", "external_plugins", "surface_export", "module");
const PHASES_DIR = path.join(MODULE_ROOT, "import_phases");
const SCANNERS_DIR = path.join(MODULE_ROOT, "export_scanners");
const OUT_PATH = path.join(here, "we-set.json");
const ACCOUNTED_PATH = path.join(here, "reachability-accounted.json");
const JOIN_ACCOUNTED_PATH = path.join(here, "capture-join-accounted.json");
const REACHABILITY_LEDGER_NAME = "reachability-accounted.json";
const JOIN_LEDGER_NAME = "capture-join-accounted.json";

const accounted = JSON.parse(readFileSync(ACCOUNTED_PATH, "utf8"));
const joinAccounted = JSON.parse(readFileSync(JOIN_ACCOUNTED_PATH, "utf8"));

export const SCHEMA = "one-of-each/we-set@2";
export const COMMON_CATEGORY = "*common*";
export const DESERIALIZER_REL = "core/deserializer.lua";
export const HANDLERS_REL = "export_scanners/entity-handlers.lua";

const MIN_RESTORE_RULES = 20;
const MIN_TYPES_GATED_RULES = 10;
const MIN_HANDLER_CATEGORIES = 25;
const MIN_HANDLER_FIELDS = 80;
const MIN_DIRECT_WRITES = 20;
const MIN_RECEIVER_WRITES = 3;
const MIN_REACHABILITY_CONSIDERED = 35;
const MIN_REACHABILITY_EVALUATED = 5;
const MIN_ENTITY_CAPTURES = 20;
const MIN_ENTITY_READS = 20;
const MIN_SPECIFIC_DATA_READS = 40;

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
const ENTITY_CAPTURE_CONTROLS = ["infinity_pipe_filter", "last_user", "tags", "count"];
export const SCOPED_ROOT_CONTROLS = [{
	file: "import_phases/latch_rearm.lua",
	function: "LatchRearm.schedule",
	name: "record",
}];
export const READ_SITE_CONTROLS = [
	["specific_data", "inventories", "core/deserializer.lua:Deserializer.restore_inventories"],
	["specific_data", "bonus_mining_progress",
		"import_phases/active_state_restoration.lua:ActiveStateRestoration.queue_mining_progress"],
	["entity", "infinity_pipe_filter", "core/deserializer.lua:Deserializer.restore_entity_filters"],
];

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

function pick(files, rel) {
	const file = files.find(entry => entry.rel === rel);
	if (!file) throw new Error(`${rel} is missing from the source set — an arm reading it would report `
		+ "an empty extraction, which reads exactly like a file with nothing in it");
	return file.source;
}

export function loadSources() {
	const read = rel => ({ rel, source: readFileSync(path.join(MODULE_ROOT, rel), "utf8") });
	const inDir = (dir, prefix) => readdirSync(dir).filter(name => name.endsWith(".lua"))
		.map(name => read(`${prefix}/${name}`)).sort((a, b) => a.rel.localeCompare(b.rel));
	return {
		captureFiles: [read("core/export-pipeline.lua"), ...inDir(SCANNERS_DIR, "export_scanners")],
		restoreFiles: [read(DESERIALIZER_REL), read("core/import-completion.lua"),
			read("core/import-pipeline.lua"), ...inDir(PHASES_DIR, "import_phases")],
	};
}

export function assemble({ captureFiles, restoreFiles }) {
	const deserializerSource = pick(restoreFiles, DESERIALIZER_REL);
	const handlerSource = pick(captureFiles, HANDLERS_REL);
	const phaseFiles = restoreFiles.filter(file => file.rel.startsWith("import_phases/"));
	const restoreRules = extractRestoreRules(deserializerSource);
	const handlerCaptures = extractHandlerCaptures(handlerSource);
	const writeFiles = [{ rel: DESERIALIZER_REL, source: deserializerSource }, ...phaseFiles];
	const directWrites = extractDirectWrites(writeFiles);
	const receiverWrites = extractReceiverWrites(writeFiles);
	const reachability = analyzeSources(writeFiles);
	const join = analyzeJoin({
		captureFiles,
		restoreFiles,
		handlerCaptures,
		restoreRuleFields: restoreRules.map(rule => rule.field),
	});

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
			reachability: ["module/core/deserializer.lua", "module/import_phases/*.lua"],
			join: {
				capture: captureFiles.map(file => `module/${file.rel}`),
				restore: restoreFiles.map(file => `module/${file.rel}`),
			},
		},
		restore_rules: restoreRules,
		handler_captures: handlerCaptures,
		direct_writes: directWrites,
		receiver_writes: receiverWrites,
		reachability,
		join,
		we_set: [...weSet.values()].sort((a, b) => a.property.localeCompare(b.property)),
		counts: {
			restore_rules: restoreRules.length,
			types_gated_rules: restoreRules.filter(rule => rule.types !== null).length,
			handler_categories: handlerCaptures.length,
			handler_fields: new Set(handlerCaptures.flatMap(row => row.fields)).size,
			direct_writes: directWrites.length,
			receiver_writes: receiverWrites.length,
			we_set: weSet.size,
			reachability_considered: reachability.considered,
			reachability_evaluated: reachability.evaluated,
			return_dominated_writes: reachability.return_dominated.length,
			entity_captures: join.counts.entity_captures,
			entity_reads: join.counts.entity_reads,
			specific_data_reads: join.counts.specific_data_reads,
			captured_without_consumer: join.counts.captured_without_consumer,
			consumed_without_producer: join.counts.consumed_without_producer,
		},
	};
}

export const returnDominatedKey = row => `${row.file}:${row.function}:${row.property}`;
export const skippedKey = row => `${row.file}:${row.function}`;

function ledgerFailures(ledgerName, label, derived, accountedKeys, unaccountedAdvice, staleAdvice) {
	const failures = [];
	const derivedKeys = new Set(derived);
	for (const key of derivedKeys) {
		if (accountedKeys.has(key)) continue;
		failures.push(`${label} ${key} is not in ${ledgerName} — ${unaccountedAdvice}`);
	}
	for (const key of accountedKeys) {
		if (derivedKeys.has(key)) continue;
		failures.push(`${label} ${key} is accounted in ${ledgerName} but the derivation no `
			+ `longer produces it — ${staleAdvice}`);
	}
	return failures;
}

export function checkJoinControls(artifact, ledger = joinAccounted) {
	const failures = [];
	const { join } = artifact;

	const floors = [
		["entity_captures", join.counts.entity_captures, MIN_ENTITY_CAPTURES],
		["entity_reads", join.counts.entity_reads, MIN_ENTITY_READS],
		["specific_data_reads", join.counts.specific_data_reads, MIN_SPECIFIC_DATA_READS],
	];
	for (const [name, actual, floor] of floors) {
		if (!(actual >= floor)) {
			failures.push(`join ${name} extracted ${actual}, floor is ${floor} — a read walk that stops `
				+ "descending finds no reads, and every captured field then looks consumed by nobody or "
				+ "every read looks unproduced, depending on which side went quiet");
		}
	}

	const captured = new Set(join.entity_captures.map(row => row.field));
	for (const control of ENTITY_CAPTURE_CONTROLS) {
		if (!captured.has(control)) {
			failures.push(`entity capture "${control}" went missing from the extraction`);
		}
	}

	const readSites = new Map(join.payload_reads.map(row => [`${row.plane}\0${row.field}`, row.sites]));
	for (const [plane, field, site] of READ_SITE_CONTROLS) {
		if (!(readSites.get(`${plane}\0${field}`) || []).includes(site)) {
			failures.push(`the ${plane} read of "${field}" at ${site} went missing from the extraction — a `
				+ "read the walk stops seeing turns its captured field into a reported orphan");
		}
	}

	const scoped = join.scoped_roots.map(row => `${row.file}:${row.function}:${row.name}`).sort();
	const scopedControls = SCOPED_ROOT_CONTROLS
		.map(row => `${row.file}:${row.function}:${row.name}`).sort();
	if (scoped.join("\n") !== scopedControls.join("\n")) {
		failures.push("the per-function payload roots moved: derived "
			+ `[${scoped.join(", ")}], control says [${scopedControls.join(", ")}] — a root that appears `
			+ "carries a whole function's reads into the join, and one that disappears takes them out");
	}

	for (const direction of ["captured_without_consumer", "consumed_without_producer"]) {
		const rows = ledger[direction] || [];
		for (const row of rows) {
			if (typeof row.reason === "string" && row.reason.trim() !== "") continue;
			failures.push(`${direction} account ${joinKey(row)} carries no reason — the ledger is read by `
				+ "people, and an entry nobody had to justify is a permanent exemption nobody reviewed");
		}
	}
	failures.push(...ledgerFailures(
		JOIN_LEDGER_NAME,
		"captured field",
		join.captured_without_consumer.map(joinKey),
		new Set((ledger.captured_without_consumer || []).map(joinKey)),
		"the export writes this field and no import-side read or restore rule names it, which is the "
			+ "shape every strike in this class had: delete the capture, write the consumer, or record "
			+ "what accounts for it",
		"that field now has a consumer. That is right if one was written (delete the entry), and wrong "
			+ "if the capture was deleted instead while the account stayed as standing permission",
	));
	failures.push(...ledgerFailures(
		JOIN_LEDGER_NAME,
		"consumed field",
		join.consumed_without_producer.map(joinKey),
		new Set((ledger.consumed_without_producer || []).map(joinKey)),
		"the import reads this field and no capture-side write produces it, which is the shape of a "
			+ "restore arm waiting on a payload nobody exports",
		"that read now has a producer, or the read is gone — either way the account no longer describes "
			+ "the source, and left standing it would cover the next unproduced read of that field",
	));

	return failures;
}

export function checkControls(artifact, ledger = accounted) {
	const failures = [];
	const { counts } = artifact;

	const LEXER_FLOOR = "a lexer that desyncs returns few rows, not zero, so the floor is the control";
	const WALK_FLOOR = "a walk that stops descending examines nothing and finds nothing, which is the "
		+ "same output as a tree with nothing to find — the floor is what separates them";
	const floors = [
		["restore_rules", counts.restore_rules, MIN_RESTORE_RULES, LEXER_FLOOR],
		["types_gated_rules", counts.types_gated_rules, MIN_TYPES_GATED_RULES, LEXER_FLOOR],
		["handler_categories", counts.handler_categories, MIN_HANDLER_CATEGORIES, LEXER_FLOOR],
		["handler_fields", counts.handler_fields, MIN_HANDLER_FIELDS, LEXER_FLOOR],
		["direct_writes", counts.direct_writes, MIN_DIRECT_WRITES, LEXER_FLOOR],
		["receiver_writes", counts.receiver_writes, MIN_RECEIVER_WRITES, LEXER_FLOOR],
		["reachability_considered", counts.reachability_considered, MIN_REACHABILITY_CONSIDERED, WALK_FLOOR],
		["reachability_evaluated", counts.reachability_evaluated, MIN_REACHABILITY_EVALUATED, WALK_FLOOR],
	];
	for (const [name, actual, floor, why] of floors) {
		if (!(actual >= floor)) failures.push(`${name} extracted ${actual}, floor is ${floor} — ${why}`);
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

	const reachability = artifact.reachability;
	failures.push(...ledgerFailures(
		REACHABILITY_LEDGER_NAME,
		"return-dominated write",
		reachability.return_dominated.map(returnDominatedKey),
		new Set(ledger.return_dominated.map(returnDominatedKey)),
		"a write the pipeline cannot reach is a candidate silent loss, so the derivation refuses to write "
			+ "we-set.json until someone has looked at it: report the finding, then record what accounts for it",
		"that write is no longer return-dominated in that function. That is right if it was fixed (delete "
			+ "the entry), and wrong if it moved to another function (move the entry) — the key ignores line "
			+ "so a shift within the function will never produce this, only a real change will",
	));

	const skippedKeys = reachability.skipped.map(skippedKey);
	if (new Set(skippedKeys).size !== skippedKeys.length) {
		failures.push("two refused scopes share one ledger key — one account would silently cover both, and "
			+ "fixing either would leave the other's refusal green. A closure's refusal is recorded under its "
			+ "enclosing function's name, which is how two scopes collide");
	}
	failures.push(...ledgerFailures(
		REACHABILITY_LEDGER_NAME,
		"refused function scope",
		skippedKeys,
		new Set(ledger.skipped_functions.map(skippedKey)),
		"a function the arm refuses to analyze contributes zero findings, which is indistinguishable from "
			+ "a clean one: record the refusal and its cause, or the arm's silence there reads as coverage",
		"the arm no longer refuses that scope. That is right if the goto went away, wrong if the function "
			+ "was renamed or deleted (move the entry), and actively wrong if the goto detection broke — "
			+ "check which before deleting, because a lost refusal licenses rows from unanalyzable code",
	));

	const alias = artifact.handler_captures.find(row => row.category === "loader-1x1");
	const target = artifact.handler_captures.find(row => row.category === "loader");
	if (!alias || !target || alias.fields.join(",") !== target.fields.join(",")) {
		failures.push("the loader-1x1 = loader alias did not resolve — an aliased handler contributes no "
			+ "fields, which reads as a category the pipeline captures nothing for");
	}

	return failures;
}

function main() {
	const artifact = assemble(loadSources());

	const failures = [...checkControls(artifact), ...checkJoinControls(artifact)];
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
		+ `WE-SET ${c.we_set} properties, ${c.reachability_evaluated}/${c.reachability_considered} write sites `
		+ `reachability-evaluated with ${c.return_dominated_writes} return-dominated `
		+ `(${artifact.reachability.skipped.length} function scopes refused); JOIN ${c.entity_captures} `
		+ `entity captures and ${c.handler_fields} specific_data captures against ${c.entity_reads} + `
		+ `${c.specific_data_reads} import-side reads — ${c.captured_without_consumer} captured without a `
		+ `consumer, ${c.consumed_without_producer} consumed without a producer`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
