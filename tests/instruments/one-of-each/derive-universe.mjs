#!/usr/bin/env node
// derive-universe — the one-of-each fixture's type universe and its per-type representative
//
// requires: a live instance to read prototypes.entity and the platform surface's property vector
//           from (--instance), or a previously captured dump (--dump <path>); plus the reviewed
//           residue in ephemera-exclusions.json
// produces: universe.json — one entry per type the fixture must carry, each naming the prototype
//           chosen to represent it and why, plus every excluded type with the predicate or the
//           reviewed reason that excluded it
// does not: place anything, contact the destination instance, decide what a placement will DO
//           (create_entity is the only oracle for that — see build-staging.mjs), accept a reviewed
//           exclusion without a reason, or write anything when a control fails

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EPHEMERA_PATH = path.join(here, "ephemera-exclusions.json");
const BONUS_PATH = path.join(here, "bonus-inclusions.json");
const ANNEX_PATH = path.join(here, "transient-annex.json");
const OUT_PATH = path.join(here, "universe.json");

export const SCHEMA = "one-of-each/universe@1";

export const EXPORT_SCANNER_EXCLUSIONS = ["character", "item-entity", "spider-leg"];

export const CLASSES = ["player_buildable", "script_only", "bonus", "excluded"];

const CONTROL_TYPE_COUNT = 132;
const CONTROL_PLAYER_BUILDABLE = 61;
const CONTROL_SCRIPT_ONLY = 20;
const CONTROL_BONUS = 1;
const CONTROL_UNIVERSE = 82;
const CONTROL_EPHEMERA = 18;
const CONTROL_ANNEX = 3;
const CONTROL_MEMBER = "character-corpse";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const DUMP_FILE = "oneofeach-prototypes.json";

const DUMP_LUA = `/sc local plat for _,p in pairs(game.forces.player.platforms) do `
	+ `if p.valid and p.name=='__PLATFORM__' then plat=p end end `
	+ `if not plat then rcon.print('{"error":"no platform named __PLATFORM__"}') return end `
	+ `local s=plat.surface local props={} for nm,_ in pairs(prototypes.surface_property) do props[nm]=s.get_property(nm) end `
	+ `local invidx={} local seen={} for _,v in pairs(defines.inventory) do if not seen[v] then seen[v]=true invidx[#invidx+1]=v end end `
	+ `local rows={} local errs={} for name,p in pairs(prototypes.entity) do local ok,err=pcall(function() `
	+ `local sc={} for _,c in pairs(p.surface_conditions or {}) do sc[#sc+1]={p=c.property,mn=c.min,mx=c.max} end `
	+ `local ivn,ivs=0,0 for _,idx in pairs(invidx) do local o,sz=pcall(function() return p.get_inventory_size(idx) end) `
	+ `if o and sz and sz>0 then ivn=ivn+1 ivs=ivs+sz end end `
	+ `local fb=0 local ofb,fbs=pcall(function() return p.fluidbox_prototypes end) if ofb and fbs then fb=#fbs end `
	+ `local cb=p.collision_box rows[#rows+1]={n=name,t=p.type,pl=#(p.items_to_place_this or {}),sc=sc,`
	+ `cb={cb.left_top.x,cb.left_top.y,cb.right_bottom.x,cb.right_bottom.y},tw=p.tile_width,th=p.tile_height,`
	+ `fb=fb,mi=p.module_inventory_size or 0,ivn=ivn,ivs=ivs,hd=p.hidden} end) `
	+ `if not ok then errs[#errs+1]={n=name,e=tostring(err)} end end `
	+ `helpers.write_file('${DUMP_FILE}', helpers.table_to_json({version=helpers.game_version,mods=script.active_mods,`
	+ `props=props,rows=rows,errs=errs}), false) rcon.print(helpers.table_to_json({rows=#rows,errs=#errs}))`;

export function luaTable(value) {
	if (Array.isArray(value)) return value;
	if (value === null || value === undefined) return [];
	return Object.values(value);
}

export function conditionFailure(condition, propertyVector) {
	const actual = propertyVector[condition.p];
	if (actual === undefined) return `${condition.p} is not a property of the measured surface`;
	if (condition.mn !== undefined && actual < condition.mn) {
		return `${condition.p} >= ${condition.mn} but the surface measures ${actual}`;
	}
	if (condition.mx !== undefined && actual > condition.mx) {
		return `${condition.p} <= ${condition.mx} but the surface measures ${actual}`;
	}
	return null;
}

export function conditionFailures(row, propertyVector) {
	return luaTable(row.sc).map(condition => conditionFailure(condition, propertyVector)).filter(Boolean);
}

export function featuresOf(row) {
	return {
		fluidboxes: row.fb || 0,
		inventories: row.ivn || 0,
		inventorySlots: row.ivs || 0,
		moduleSlots: row.mi || 0,
	};
}

export function richness(row) {
	const features = featuresOf(row);
	return [features.fluidboxes, features.inventories, features.inventorySlots, features.moduleSlots];
}

export function selectRepresentative(candidates, preferred = null) {
	if (candidates.length === 0) throw new Error("selectRepresentative called with no candidates");
	const prefers = row => preferred !== null && preferred.has(row.n);
	const ranked = [...candidates].sort((a, b) => {
		const left = richness(a);
		const right = richness(b);
		for (let i = 0; i < left.length; i++) {
			if (left[i] !== right[i]) return right[i] - left[i];
		}
		if (prefers(a) !== prefers(b)) return prefers(a) ? -1 : 1;
		return a.n.localeCompare(b.n);
	});
	const winner = ranked[0];
	const features = featuresOf(winner);
	const reason = candidates.length === 1
		? `the only ${winner.t} prototype in the universe`
		: `richest of ${candidates.length} ${winner.t} prototypes by (fluidboxes ${features.fluidboxes}, `
			+ `inventories ${features.inventories}, inventory slots ${features.inventorySlots}, `
			+ `module slots ${features.moduleSlots}), ahead of ${ranked[1].n}`;
	return { row: winner, reason };
}

export function groupByType(rows) {
	const byType = new Map();
	for (const row of rows) {
		if (!byType.has(row.t)) byType.set(row.t, []);
		byType.get(row.t).push(row);
	}
	return byType;
}

export function buildEntry({ type, protos, candidates, klass, propertyVector, preferred = null, note = null }) {
	const { row, reason } = selectRepresentative(candidates, preferred);
	const failures = conditionFailures(row, propertyVector);
	const parts = [reason];
	if (failures.length) {
		parts.push(`chosen regardless of surface legality — it fails ${failures.join("; ")} on the measured `
			+ "platform vector, and create_entity places it anyway");
	}
	if (note) parts.push(note);
	return {
		type, class: klass, representative: row.n, representative_reason: parts.join("; "),
		representative_surface_legal: failures.length === 0,
		representative_surface_conditions: failures,
		candidates: candidates.length, prototypes: protos.length,
		footprint: { tile_width: row.tw, tile_height: row.th, collision_box: row.cb },
		features: featuresOf(row),
	};
}

export function classifyTypes({ rows, propertyVector, ephemera, bonus = [], annex = [] }) {
	const byType = groupByType(rows);
	const ephemeraById = new Map(ephemera.map(entry => [entry.type, entry]));
	const bonusById = new Map(bonus.map(entry => [entry.type, entry]));
	const annexById = new Map(annex.map(entry => [entry.type, entry]));
	const entries = [];
	const exclusions = [];

	for (const [type, protos] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const placeable = protos.filter(row => row.pl > 0);
		const legal = placeable.filter(row => conditionFailures(row, propertyVector).length === 0);

		if (EXPORT_SCANNER_EXCLUSIONS.includes(type)) {
			exclusions.push({
				type, prototypes: protos.length, derivation: "export_scanner",
				reason: `is_exportable_entity refuses type "${type}" (entity-scanner.lua), so no payload can `
					+ "carry it and a fixture cell for it would measure the scanner, not the pipeline",
			});
			continue;
		}

		if (legal.length > 0) {
			entries.push(buildEntry({
				type, protos, candidates: placeable, klass: "player_buildable", propertyVector,
				preferred: new Set(legal.map(row => row.n)),
			}));
			continue;
		}

		if (placeable.length > 0) {
			const bonusEntry = bonusById.get(type);
			if (bonusEntry) {
				entries.push(buildEntry({
					type, protos, candidates: placeable, klass: "bonus", propertyVector, note: bonusEntry.reason,
				}));
				continue;
			}
			const failures = [...new Set(placeable.flatMap(row => conditionFailures(row, propertyVector)))];
			exclusions.push({
				type, prototypes: protos.length, derivation: "surface_conditions",
				reason: `all ${placeable.length} placeable ${type} prototype(s) fail a surface condition on the `
					+ `measured platform vector: ${failures.join("; ")}`,
			});
			continue;
		}

		const annexed = annexById.get(type);
		if (annexed) {
			exclusions.push({
				type, prototypes: protos.length, derivation: "transient_annex",
				reason: annexed.reason, measurement: annexed.measurement,
			});
			continue;
		}

		const reviewed = ephemeraById.get(type);
		if (reviewed) {
			exclusions.push({
				type, prototypes: protos.length, derivation: "ephemera", reason: reviewed.reason,
			});
			continue;
		}

		entries.push(buildEntry({
			type, protos, candidates: protos, klass: "script_only", propertyVector,
		}));
	}

	return { entries, exclusions, typeCount: byType.size };
}

export function loadEphemera(raw, rows) {
	const byType = groupByType(rows);
	const entries = [];
	for (const entry of raw.entries || []) {
		if (!entry.type) throw new Error(`ephemera entry without a type: ${JSON.stringify(entry)}`);
		if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
			throw new Error(`ephemera entry ${entry.type} has no reason — an exclusion the derivation does not `
				+ "produce is a judgement, and an unreasoned judgement is indistinguishable from a mistake");
		}
		const protos = byType.get(entry.type);
		if (!protos) throw new Error(`ephemera entry ${entry.type} names a type that does not exist at this pin`);
		if (protos.some(row => row.pl > 0)) {
			throw new Error(`ephemera entry ${entry.type} names a PLAYER-BUILDABLE type — the reviewed list may `
				+ "only hold script-only ephemera, or it silently shrinks the buildable universe");
		}
		if (EXPORT_SCANNER_EXCLUSIONS.includes(entry.type)) {
			throw new Error(`ephemera entry ${entry.type} is already excluded by is_exportable_entity — two `
				+ "reasons for one type means one of them is unreviewed");
		}
		entries.push({ type: entry.type, reason: entry.reason });
	}
	return entries;
}

export function loadBonusInclusions(raw, rows, propertyVector) {
	const byType = groupByType(rows);
	const entries = [];
	for (const entry of raw.entries || []) {
		if (!entry.type) throw new Error(`bonus inclusion without a type: ${JSON.stringify(entry)}`);
		if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
			throw new Error(`bonus inclusion ${entry.type} has no reason — it enters the universe against the `
				+ "derivation, and an unreasoned override is indistinguishable from a mistake");
		}
		const protos = byType.get(entry.type);
		if (!protos) throw new Error(`bonus inclusion ${entry.type} names a type that does not exist at this pin`);
		const placeable = protos.filter(row => row.pl > 0);
		if (!placeable.length) {
			throw new Error(`bonus inclusion ${entry.type} names a type with no placeable prototype — a bonus cell `
				+ "is a thing create_entity builds, not a reviewed script-only residue");
		}
		if (placeable.some(row => conditionFailures(row, propertyVector).length === 0)) {
			throw new Error(`bonus inclusion ${entry.type} is already platform-legal, so the derivation carries it `
				+ "on its own — a redundant override would hide the day it stops being derived");
		}
		entries.push({ type: entry.type, reason: entry.reason });
	}
	return entries;
}

export function loadTransientAnnex(raw, rows) {
	const byType = groupByType(rows);
	const entries = [];
	for (const entry of raw.entries || []) {
		if (!entry.type) throw new Error(`transient annex entry without a type: ${JSON.stringify(entry)}`);
		if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
			throw new Error(`transient annex entry ${entry.type} has no reason — an exclusion the derivation does `
				+ "not produce is a judgement, and an unreasoned judgement is indistinguishable from a mistake");
		}
		if (typeof entry.measurement !== "string" || entry.measurement.trim().length < 20) {
			throw new Error(`transient annex entry ${entry.type} carries no measurement — a type is annexed for a `
				+ "MEASURED despawn, and an annex with no measurement is a prediction wearing a measurement's name");
		}
		const protos = byType.get(entry.type);
		if (!protos) {
			throw new Error(`transient annex entry ${entry.type} names a type that does not exist at this pin`);
		}
		if (protos.some(row => row.pl > 0)) {
			throw new Error(`transient annex entry ${entry.type} names a PLAYER-BUILDABLE type — the annex holds `
				+ "script-only transients, or it silently shrinks the buildable universe");
		}
		if (EXPORT_SCANNER_EXCLUSIONS.includes(entry.type)) {
			throw new Error(`transient annex entry ${entry.type} is already excluded by is_exportable_entity — two `
				+ "reasons for one type means one of them is unreviewed");
		}
		entries.push({ type: entry.type, reason: entry.reason, measurement: entry.measurement });
	}
	return entries;
}

export function assemble({ dump, ephemeraRaw, bonusRaw = { entries: [] }, annexRaw = { entries: [] } }) {
	const rows = dump.rows;
	const ephemera = loadEphemera(ephemeraRaw, rows);
	const bonus = loadBonusInclusions(bonusRaw, rows, dump.props);
	const annex = loadTransientAnnex(annexRaw, rows);

	const ephemeraTypes = new Set(ephemera.map(entry => entry.type));
	const doubled = annex.filter(entry => ephemeraTypes.has(entry.type)).map(entry => entry.type);
	if (doubled.length) {
		throw new Error(`[${doubled}] are in both the reviewed ephemera list and the transient annex — two `
			+ "reasons for one exclusion means one of them is unreviewed");
	}

	const { entries, exclusions, typeCount } = classifyTypes({
		rows, propertyVector: dump.props, ephemera, bonus, annex,
	});

	const counts = {
		prototypes: rows.length,
		types: typeCount,
		universe: entries.length,
		player_buildable: entries.filter(entry => entry.class === "player_buildable").length,
		script_only: entries.filter(entry => entry.class === "script_only").length,
		bonus: entries.filter(entry => entry.class === "bonus").length,
		excluded: exclusions.length,
	};
	for (const derivation of ["export_scanner", "surface_conditions", "ephemera", "transient_annex"]) {
		counts[`excluded_${derivation}`] = exclusions.filter(row => row.derivation === derivation).length;
	}

	return {
		schema: SCHEMA,
		application_version: dump.version,
		mods: dump.mods,
		property_vector: dump.props,
		export_scanner_exclusions: EXPORT_SCANNER_EXCLUSIONS,
		counts,
		entries,
		exclusions,
	};
}

export function checkControls(artifact) {
	const failures = [];
	const { counts } = artifact;

	const exact = [
		["types", counts.types, CONTROL_TYPE_COUNT],
		["player_buildable", counts.player_buildable, CONTROL_PLAYER_BUILDABLE],
		["script_only", counts.script_only, CONTROL_SCRIPT_ONLY],
		["bonus", counts.bonus, CONTROL_BONUS],
		["universe", counts.universe, CONTROL_UNIVERSE],
		["excluded_ephemera", counts.excluded_ephemera, CONTROL_EPHEMERA],
		["excluded_transient_annex", counts.excluded_transient_annex, CONTROL_ANNEX],
	];
	for (const [name, actual, expected] of exact) {
		if (actual !== expected) {
			failures.push(`${name} derived ${actual}, the measured control is ${expected} — a mod change moves `
				+ "these legitimately, but a derivation bug moves them too, so review before re-pinning");
		}
	}

	if (counts.universe + counts.excluded !== counts.types) {
		failures.push(`universe ${counts.universe} + excluded ${counts.excluded} is not the ${counts.types} types `
			+ "at this pin — a type was classified twice or lost, which no per-count control would catch");
	}

	if (!artifact.entries.some(entry => entry.type === CONTROL_MEMBER)) {
		failures.push(`${CONTROL_MEMBER} is not in the universe — it is the founding blind spot this fixture `
			+ "exists to close, and a classification that drops it would look exactly like a passing run");
	}

	const excluded = artifact.exclusions.filter(row => row.derivation === "export_scanner").map(row => row.type);
	if (excluded.sort().join(",") !== [...EXPORT_SCANNER_EXCLUSIONS].sort().join(",")) {
		failures.push(`export_scanner excluded [${excluded}] — is_exportable_entity refuses exactly `
			+ `[${EXPORT_SCANNER_EXCLUSIONS}]`);
	}

	for (const entry of artifact.entries) {
		if (!entry.representative) failures.push(`${entry.type} entered the universe with no representative`);
		if (!entry.representative_reason) failures.push(`${entry.type} names a representative with no reason`);
	}
	for (const row of artifact.exclusions) {
		if (!row.reason) failures.push(`${row.type} was excluded with no reason`);
	}

	return failures;
}

function readDump(argv) {
	const dumpArg = argv.indexOf("--dump");
	if (dumpArg !== -1) return JSON.parse(readFileSync(argv[dumpArg + 1], "utf8"));

	const instanceArg = argv.indexOf("--instance");
	const instance = instanceArg !== -1 ? argv[instanceArg + 1] : "clusterio-host-1-instance-1";
	const platformArg = argv.indexOf("--platform");
	const platform = platformArg !== -1 ? argv[platformArg + 1] : "lab-omnibus-state-v1";
	const hostArg = argv.indexOf("--host");
	const container = hostArg !== -1 ? `surface-export-host-${argv[hostArg + 1]}` : "surface-export-host-1";

	const command = DUMP_LUA.replaceAll("__PLATFORM__", platform);
	const printed = execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", instance, command, "--config", CTL_CONFIG],
	{ encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }).trim();
	const summary = JSON.parse(printed.split(/\r?\n/).filter(Boolean).at(-1));
	if (summary.error) throw new Error(`dump refused: ${summary.error}`);
	if (summary.errs > 0) throw new Error(`${summary.errs} prototype(s) threw during the dump`);

	const raw = execFileSync("docker", ["exec", container, "cat",
		`/clusterio/data/instances/${instance}/script-output/${DUMP_FILE}`],
	{ encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(raw);
}

function main() {
	const dump = readDump(process.argv);
	const ephemeraRaw = JSON.parse(readFileSync(EPHEMERA_PATH, "utf8"));
	const bonusRaw = JSON.parse(readFileSync(BONUS_PATH, "utf8"));
	const annexRaw = JSON.parse(readFileSync(ANNEX_PATH, "utf8"));
	const artifact = assemble({ dump, ephemeraRaw, bonusRaw, annexRaw });

	const failures = checkControls(artifact);
	if (failures.length) {
		console.error("derive-universe CONTROL FAILURE — refusing to write universe.json:");
		for (const failure of failures) console.error(`  ${failure}`);
		process.exit(1);
	}

	writeFileSync(OUT_PATH, JSON.stringify(artifact, null, "\t") + "\n");
	const c = artifact.counts;
	console.log(`wrote ${OUT_PATH}: ${c.universe} types in the universe at pin ${artifact.application_version} `
		+ `(${c.player_buildable} player-buildable + ${c.script_only} script-only + ${c.bonus} bonus), out of `
		+ `${c.types} types over ${c.prototypes} prototypes; excluded ${c.excluded} = `
		+ `${c.excluded_surface_conditions} surface-conditions + ${c.excluded_ephemera} ephemera + `
		+ `${c.excluded_transient_annex} transient-annex + ${c.excluded_export_scanner} export-scanner`);
	const illegal = artifact.entries.filter(entry => entry.representative_surface_legal === false);
	console.log(`${illegal.length} representative(s) are surface-ILLEGAL at this pin and were chosen anyway: `
		+ illegal.map(entry => `${entry.type}=${entry.representative}`).join(", "));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
