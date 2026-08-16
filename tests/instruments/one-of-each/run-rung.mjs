#!/usr/bin/env node
// one-of-each sweep — the per-type verdict table for one real transfer of the banked coverage fixture
//
// requires: the cluster up with oneofeach-fixture-v1 on host-1, host-2 able to receive, debug_mode
//           writable on BOTH hosts (the payload is read from the source's own debug_source_platform
//           dump, the gate verdict from the destination's own debug_import_result)
// produces: a CLONE of the fixture transferred host-1 -> host-2 through the production path, and one
//           row per STAGED TYPE from universe.json carrying CAPTURED/PARTIAL/ABSENT (payload),
//           PASS/REFUSED/UNKNOWN (gate, read before any destination read), and RESTORED/WRONG/LOST
//           (destination physical read) with the source and destination samples behind each; plus the
//           payload's own property_findings, the fixture-vs-clone staging delta, and a JSON report at
//           ci-artifacts/one-of-each-sweep-report.json
// does not: touch the banked fixture (it is read, cloned, and never transferred or deleted); read the
//           destination at all before the gate verdict is adjudicated (every destination read passes
//           through a latch that throws, so the ordering cannot be lost by moving a line); resolve any
//           destination entity by source unit_number (unit numbers do not survive a transfer); key any
//           row on a payload type; write to a segmented unit (a write wakes it); grade a fidelity
//           verdict as a test failure — LOST/WRONG/ABSENT rows are MEASUREMENTS, and only the
//           infrastructure assertions (clone, gate, table completeness, quiescent hostiles, zero
//           leftovers) can turn this rung red

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	REPO_ROOT, createBatchLifecycle, docker, instanceIds, lua as luaRaw, rcon, readContainerJson, sleep, HOSTS,
} from "../../lab-gallery/batch-lifecycle.mjs";
import { buildTable, completeness, createGateLatch, tallyVerdicts } from "./sweep-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const UNIVERSE = JSON.parse(readFileSync(path.join(here, "universe.json"), "utf8"));
const TYPES = UNIVERSE.entries.map(entry => entry.type);

const FIXTURE = "oneofeach-fixture-v1";
const SOURCE_HOST = 1;
const DEST_HOST = 2;
const RUN_TAG = Date.now().toString(36);
const CLONE = `oneofeach-sweep-${RUN_TAG}`;
const PAGE = 400;
const CLONE_WAIT_MS = 300_000;
const SETTLE_MS = 4000;
const REPORT_PATH = path.join(REPO_ROOT, "ci-artifacts", "one-of-each-sweep-report.json");

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip", markerPrefix: "oneofeach-sweep",
});
const latch = createGateLatch();

const say = (...args) => console.log(...args);
const problems = [];
function infraFail(message) {
	problems.push(message);
	process.exitCode = 1;
	say(`  INFRA-FAIL ${message}`);
}
function pass(message) {
	say(`  PASS ${message}`);
}

function lua(host, body) {
	const answer = luaRaw(host, body);
	if (answer === null || typeof answer !== "object") {
		throw new Error(`lua returned no object from host ${host}: ${JSON.stringify(answer)}`);
	}
	if (answer.success !== true) throw new Error(`lua failed on host ${host}: ${answer.error ?? JSON.stringify(answer)}`);
	return answer;
}

function luaList(value) {
	if (Array.isArray(value)) return value;
	if (value === null || value === undefined) return [];
	return Object.values(value);
}

function platformLua(name) {
	return "local p\n"
		+ "for _, pl in pairs(game.forces.player.platforms) do\n"
		+ `  if pl.valid and pl.name == '${name}' then p = pl end\n`
		+ "end\n"
		+ `if not (p and p.valid and p.surface and p.surface.valid) then\n`
		+ `  return { success = false, error = "platform '${name}' has no valid surface" }\n`
		+ "end\n"
		+ "local s = p.surface";
}

function resolvePlatform(host, name) {
	const answer = lua(host, "local hits = {}\n"
		+ "for _, pl in pairs(game.forces.player.platforms) do\n"
		+ `  if pl.valid and pl.name == '${name}' then hits[#hits + 1] = pl.index end\n`
		+ "end\n"
		+ "return { success = true, hits = hits, count = #hits }");
	const hits = luaList(answer.hits);
	if (answer.count !== 1) {
		throw new Error(`'${name}' resolves to ${answer.count} platform index(es) on host ${host} `
			+ `(${hits.join(", ") || "none"}) — the sweep keys on a unique index, never on a name`);
	}
	return hits[0];
}

function guardDestinationRead(host, what) {
	if (host === DEST_HOST) latch.require(what);
}

function readSurface(host, name) {
	guardDestinationRead(host, `the physical read of '${name}'`);
	const rows = [];
	let total = null;
	let pages = 0;
	for (let from = 1; ; from += PAGE) {
		const page = lua(host, `${platformLua(name)}\n`
			+ "local ents = s.find_entities_filtered{}\n"
			+ "local out = {}\n"
			+ `for i = ${from}, math.min(${from + PAGE - 1}, #ents) do\n`
			+ "  local e = ents[i]\n"
			+ "  if e and e.valid then\n"
			+ "    out[#out + 1] = { t = e.type, n = e.name, x = e.position.x, y = e.position.y }\n"
			+ "  end\n"
			+ "end\n"
			+ "return { success = true, total = #ents, rows = out }");
		if (total === null) total = page.total;
		if (page.total !== total) {
			throw new Error(`the surface of '${name}' on host ${host} changed size mid-read `
				+ `(${total} -> ${page.total}) — a paged read of a moving world cannot be trusted`);
		}
		rows.push(...luaList(page.rows));
		pages += 1;
		if (from + PAGE - 1 >= total) break;
	}
	if (rows.length !== total) {
		throw new Error(`paged read of '${name}' on host ${host} collected ${rows.length} row(s) for a `
			+ `surface reporting ${total} entity(ies) — the read is incomplete, not the surface`);
	}
	if (pages > 1) {
		const seen = new Set();
		const repeated = [];
		for (const row of rows) {
			const key = `${row.t}|${row.n}|${row.x}|${row.y}`;
			if (seen.has(key)) repeated.push(key);
			seen.add(key);
		}
		if (repeated.length) {
			throw new Error(`the ${pages}-page read of '${name}' on host ${host} returned ${repeated.length} `
				+ `duplicate row(s) (e.g. ${repeated[0]}) — find_entities_filtered reordered between pages, so `
				+ "the read dropped as many entities as it repeated");
		}
	}
	return rows.map(row => ({ type: row.t, name: row.n, x: row.x, y: row.y }));
}

function readSegmentedUnits(host, name) {
	guardDestinationRead(host, `the segmented-unit read of '${name}'`);
	const answer = lua(host, `${platformLua(name)}\n`
		+ "local units = {}\n"
		+ "for _, e in pairs(s.find_entities_filtered{ type = 'segmented-unit' }) do\n"
		+ "  if e.valid then\n"
		+ "    local rec = { n = e.name, x = e.position.x, y = e.position.y }\n"
		+ "    local ok, su = pcall(function() return e.segmented_unit end)\n"
		+ "    if ok and su and su.valid then\n"
		+ "      local mok, mode = pcall(function() return su.activity_mode end)\n"
		+ "      if mok then rec.mode = mode else rec.mode_read = 'threw' end\n"
		+ "    else\n"
		+ "      rec.mode_read = 'no segmented_unit'\n"
		+ "    end\n"
		+ "    units[#units + 1] = rec\n"
		+ "  end\n"
		+ "end\n"
		+ "return { success = true, units = units, asleep = defines.segmented_unit_activity_mode.asleep }");
	return { units: luaList(answer.units), asleep: answer.asleep };
}

function describeUnits(reading) {
	return reading.units.map(unit => `${unit.n}@${unit.x},${unit.y} `
		+ `mode=${unit.mode === undefined ? `UNREADABLE(${unit.mode_read})` : unit.mode}`).join(" | ");
}

function assertQuiescent(where, reading) {
	if (reading.units.length === 0) {
		say(`  NOTE  ${where} carries no segmented-unit — the wake-up confound cannot arise there, and `
			+ "the segmented-unit row below reports what happened to it");
		return;
	}
	const describe = describeUnits(reading);
	const awake = reading.units.filter(unit => unit.mode !== undefined && unit.mode !== reading.asleep);
	const unreadable = reading.units.filter(unit => unit.mode === undefined);
	if (awake.length > 0) {
		infraFail(`${where} carries ${awake.length} segmented-unit(s) that READ as not asleep `
			+ `(asleep=${reading.asleep}): ${describe} — an awake demolisher eats the platform it is on, so `
			+ "every fidelity row measured beside it describes a confound, not a transfer");
		return;
	}
	if (unreadable.length > 0) {
		say(`  NOTE  ${where}: ${unreadable.length} segmented-unit(s) whose activity_mode could not be read `
			+ `(${describe}) — the position check below is what carries the quiescence verdict for those`);
		return;
	}
	pass(`${where}: ${reading.units.length} segmented-unit(s) asleep (${describe})`);
}

function assertUnitsHeldPosition(before, after) {
	if (before.units.length === 0 || after.units.length === 0) {
		say("  NOTE  a segmented-unit position comparison needs a head on both sides "
			+ `(clone ${before.units.length}, destination ${after.units.length}) — not measured`);
		return;
	}
	for (const head of after.units) {
		const twin = before.units.filter(unit => unit.n === head.n)
			.map(unit => ({ unit, drift: Math.hypot(unit.x - head.x, unit.y - head.y) }))
			.sort((a, b) => a.drift - b.drift)[0];
		if (!twin) {
			infraFail(`the destination carries a ${head.n} the clone never had — the position comparison `
				+ "cannot pair it, and an unpaired hostile is a confound");
			continue;
		}
		if (twin.drift > 1.0) {
			infraFail(`the arrived ${head.n} sits ${twin.drift.toFixed(3)} tiles from where the clone `
				+ `carried it (${twin.unit.x},${twin.unit.y} -> ${head.x},${head.y}) — it moved, so it was `
				+ "awake during the import whatever activity_mode reads");
		} else {
			pass(`the arrived ${head.n} is ${twin.drift.toFixed(3)} tiles from its captured clone position — `
				+ "it never moved");
		}
	}
}

function readPayload(marker) {
	const dumps = L.filesNewerThanMarker(SOURCE_HOST, marker, `debug_source_platform_${CLONE}_*.json`);
	if (dumps.length === 0) {
		throw new Error(`the source wrote no debug_source_platform dump for '${CLONE}' — the CAPTURED column `
			+ "would otherwise be read off the destination, which is the importer grading its own input");
	}
	return { path: dumps.at(-1), payload: readContainerJson(SOURCE_HOST, dumps.at(-1)) };
}

function printTable(table) {
	const width = Math.max(...table.rows.map(row => row.type.length));
	say("\ntype".padEnd(width) + "  cells  CAPTURED   GATE      RESTORED   detail");
	say("-".repeat(width + 48));
	for (const row of table.rows) {
		const detail = [];
		if (row.capture === "PARTIAL") detail.push(`payload ${row.capturedCells}/${row.staged}`);
		if (row.gateRefusedCells > 0) detail.push(`gate refused ${row.gateRefusedCells}`);
		if (row.wrongCells > 0) detail.push(`wrong: ${row.substitutions.join("; ")}`);
		if (row.lostCells > 0) detail.push(`lost: ${row.lostSample.join("; ")}`);
		if (row.staged === 0 && row.stagedOnFixture > 0) {
			detail.push(`on the fixture as ${row.stagedOnFixture} cell(s), absent from the clone`);
		}
		if (row.restore === "RESTORED" && row.maxDrift > 0.001) detail.push(`drift ${row.maxDrift.toFixed(3)}`);
		if (detail.length === 0 && row.staged > 0) detail.push(row.sourceSample.join(" "));
		say(`${row.type.padEnd(width)}  ${String(row.staged).padStart(5)}  ${row.capture.padEnd(9)}  `
			+ `${row.gate.padEnd(8)}  ${row.restore.padEnd(9)}  ${detail.join(" | ")}`);
	}
}

function printTally(table) {
	for (const column of ["capture", "gate", "restore"]) {
		const tally = [...tallyVerdicts(table.rows, column).entries()].sort();
		say(`  ${column.toUpperCase().padEnd(8)} ${tally.map(([verdict, count]) => `${verdict}=${count}`).join("  ")}`);
	}
}

function printPropertyFindings(payload) {
	const findings = luaList(payload.property_findings);
	if (findings.length === 0) {
		say("  the payload carries property_findings = [] — the source-side census flagged no property "
			+ "that failed to reach the payload on this export");
		return { total: 0, byProperty: {} };
	}
	const byProperty = {};
	for (const finding of findings) {
		const key = `${finding.property}:${finding.kind}`;
		byProperty[key] = (byProperty[key] || 0) + 1;
	}
	say(`  the payload carries ${findings.length} property finding(s) from the source-side census `
		+ "(property-level, NOT the entity-level CAPTURED column above — the two cannot confirm each other):");
	for (const key of Object.keys(byProperty).sort()) say(`    ${key} = ${byProperty[key]}`);
	for (const finding of findings.slice(0, 12)) {
		say(`    ${finding.kind} ${finding.property} on ${finding.entity_name} `
			+ `(${finding.entity_type}) @${finding.position && finding.position.x},${finding.position && finding.position.y} `
			+ `engine=${finding.engine_value}`);
	}
	return { total: findings.length, byProperty };
}

const CLONE_STABLE_SAMPLES = 3;

async function waitForClone() {
	const deadline = Date.now() + CLONE_WAIT_MS;
	let previous = -1;
	let stable = 0;
	let last = null;
	while (Date.now() < deadline) {
		await sleep(3000);
		last = lua(SOURCE_HOST, "local present, entities = false, 0\n"
			+ "for _, pl in pairs(game.forces.player.platforms) do\n"
			+ `  if pl.valid and pl.name == '${CLONE}' then\n`
			+ "    present = true\n"
			+ "    if pl.surface and pl.surface.valid then entities = pl.surface.count_entities_filtered{} end\n"
			+ "  end\n"
			+ "end\n"
			+ "return { success = true, present = present, entities = entities, "
			+ "jobs = table_size(storage.async_jobs or {}) }");
		if (last.present !== true || last.jobs > 0) { stable = 0; previous = -1; continue; }
		stable = last.entities === previous ? stable + 1 : 0;
		previous = last.entities;
		if (stable >= CLONE_STABLE_SAMPLES - 1 && last.entities > 0) return last;
	}
	throw new Error(`the clone '${CLONE}' never settled on host ${SOURCE_HOST} within ${CLONE_WAIT_MS / 1000}s `
		+ `(last read ${JSON.stringify(last)}) — clone_platform runs the full export/import pipeline locally, `
		+ "and a clone that never settles leaves nothing to transfer");
}

async function main() {
	say(`=== one-of-each sweep: ${TYPES.length} staged types across one real transfer (clone '${CLONE}') ===`);
	const ids = instanceIds();
	const previousDebug = {};
	const report = {
		schema: "one-of-each/sweep-report@1",
		pin: UNIVERSE.application_version,
		fixture: FIXTURE,
		clone: CLONE,
		route: `${HOSTS[SOURCE_HOST].instance} -> ${HOSTS[DEST_HOST].instance}`,
		tolerance_tiles: 0.5,
	};

	try {
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			previousDebug[host] = lua(host, "return { success = true, debug = (storage.surface_export_config "
				+ "and storage.surface_export_config.debug_mode) == true }").debug === true;
			lua(host, "remote.call('surface_export', 'configure', { debug_mode = true }) return { success = true }");
		}
		say(`  debug_mode armed on both hosts (was ${JSON.stringify(previousDebug)})`);

		const preflight = lua(SOURCE_HOST, "return { success = true, players = #game.connected_players, "
			+ "paused = game.tick_paused == true }");
		if (preflight.players > 0) {
			infraFail(`${preflight.players} player(s) are connected — this rung clones and transfers, which `
				+ "evacuates anyone aboard");
			return;
		}

		say("\n=== FIXTURE: read the banked platform (read-only; it is never transferred or deleted) ===");
		const fixtureIndex = resolvePlatform(SOURCE_HOST, FIXTURE);
		const fixtureRows = readSurface(SOURCE_HOST, FIXTURE);
		const fixtureTypes = new Set(fixtureRows.map(row => row.type));
		say(`  ${FIXTURE} is platform index ${fixtureIndex} with ${fixtureRows.length} entity(ies) over `
			+ `${fixtureTypes.size} engine type(s)`);
		assertQuiescent(`the fixture ${FIXTURE}`, readSegmentedUnits(SOURCE_HOST, FIXTURE));

		say("\n=== CLONE: clone_platform runs the full export/import pipeline locally ===");
		const queued = lua(SOURCE_HOST,
			`local r = remote.call('surface_export', 'clone_platform', ${fixtureIndex}, '${CLONE}')\n`
			+ "r.success = r.success == true\n"
			+ "return r");
		say(`  clone queued: job_id=${queued.job_id} entities=${queued.entity_count} from `
			+ `'${queued.source_platform}'`);
		const settled = await waitForClone();
		pass(`the clone settled with ${settled.entities} entity(ies) and no async job in flight`);
		await sleep(SETTLE_MS);

		const cloneIndex = resolvePlatform(SOURCE_HOST, CLONE);
		const sourceRows = readSurface(SOURCE_HOST, CLONE);
		say(`  clone is platform index ${cloneIndex} with ${sourceRows.length} entity(ies)`);
		if (sourceRows.length === 0) {
			infraFail("the clone carries no entities — every row below would read NOT_STAGED for a rig reason");
			return;
		}
		const cloneUnits = readSegmentedUnits(SOURCE_HOST, CLONE);
		assertQuiescent(`the clone ${CLONE}`, cloneUnits);

		say(`\n=== TRANSFER: host ${SOURCE_HOST} -> host ${DEST_HOST} through the production path ===`);
		const destMarker = L.dropMarker(DEST_HOST, "transfer");
		const sourceMarker = L.dropMarker(SOURCE_HOST, "export");
		rcon(SOURCE_HOST, `/transfer-platform ${cloneIndex} ${ids[DEST_HOST]}`);
		const imported = await L.waitForImportResult(DEST_HOST, destMarker);

		const gate = latch.adjudicate(imported.result);
		report.gate = {
			path: imported.path,
			validation_success: imported.result.validation_success === true,
			platform_name: imported.result.platform_name,
			total_entities: imported.result.total_entities,
		};
		if (gate.success) {
			pass(`the exact gate passed (${imported.path.split("/").at(-1)}, `
				+ `platform=${imported.result.platform_name}, ${imported.result.total_entities} entities carried)`);
		} else {
			infraFail("the transfer did not pass the exact gate — the destination is not read at all, because "
				+ "a read after a rollback describes a discarded import, not a restoration: "
				+ `${JSON.stringify(imported.result).slice(0, 600)}`);
		}

		say("\n=== PAYLOAD: what the export actually carried ===");
		const { path: payloadPath, payload } = readPayload(sourceMarker);
		const payloadRows = luaList(payload.entities);
		say(`  ${payloadPath.split("/").at(-1)}: ${payloadRows.length} entity record(s)`);
		report.property_findings = printPropertyFindings(payload);

		let destRows = null;
		if (gate.success) {
			say("\n=== DESTINATION: physical read, taken only after the gate was adjudicated ===");
			destRows = readSurface(DEST_HOST, CLONE);
			say(`  the arrived '${CLONE}' carries ${destRows.length} entity(ies)`);
			const destUnits = readSegmentedUnits(DEST_HOST, CLONE);
			assertQuiescent(`the arrived ${CLONE}`, destUnits);
			assertUnitsHeldPosition(cloneUnits, destUnits);
		} else {
			say("\n=== DESTINATION: NOT READ (the gate failed) — the RESTORED column reads NOT_MEASURED, and "
				+ "the CAPTURED and GATE columns below still stand on their own evidence ===");
		}

		const table = buildTable({
			types: TYPES,
			sourceRows,
			payloadRows,
			gate: (imported.result.validation_result || {}),
			destRows,
			fixtureRows,
		});
		const gateSummary = {
			refusedTotal: table.gateSummary.refusedTotal,
			detailedTotal: table.gateSummary.detailedTotal,
			detailCapped: table.gateSummary.detailCapped,
			byType: Object.fromEntries(table.gateSummary.byType),
			samples: table.gateSummary.samples.slice(0, 20),
		};
		const verdict = completeness(table.rows, TYPES);

		say(`\n=== PER-TYPE VERDICT TABLE (${table.rows.length} staged types; fidelity rows are `
			+ "MEASUREMENTS, not failures) ===");
		printTable(table);
		say("\n=== TALLY ===");
		printTally(table);

		say(`  gate detail: ${gateSummary.refusedTotal} entity(ies) refused at the destination, `
			+ `${gateSummary.detailedTotal} detailed`
			+ (gateSummary.detailCapped ? " — DETAIL CAPPED, so every unnamed type reads UNKNOWN, not PASS" : ""));
		if (table.unkeyedSourceTypes.length) {
			say(`  engine types on the clone that are not staged types (no row, by design): `
				+ table.unkeyedSourceTypes.join(", "));
		}
		if (table.unkeyedDestTypes.length) {
			say(`  engine types at the destination that are not staged types (no row, by design): `
				+ table.unkeyedDestTypes.join(", "));
		}
		const fixtureOnly = table.rows.filter(row => row.staged === 0 && row.stagedOnFixture > 0);
		if (fixtureOnly.length) {
			say(`  the CLONE lost ${fixtureOnly.length} type(s) the fixture carries — every row below them `
				+ `measures the second transfer only: ${fixtureOnly.map(row => row.type).join(", ")}`);
		}

		report.counts = {
			fixture_entities: fixtureRows.length,
			clone_entities: sourceRows.length,
			payload_entities: payloadRows.length,
			destination_entities: destRows === null ? null : destRows.length,
			staged_types: table.rows.filter(row => row.staged > 0).length,
		};
		report.tally = Object.fromEntries(["capture", "gate", "restore"].map(column =>
			[column, Object.fromEntries(tallyVerdicts(table.rows, column))]));
		report.gate_detail = gateSummary;
		report.unkeyed_source_types = table.unkeyedSourceTypes;
		report.unkeyed_destination_types = table.unkeyedDestTypes;
		report.completeness = verdict;
		report.rows = table.rows;

		if (!verdict.ok) {
			infraFail("the verdict table is INCOMPLETE — a row that reports nothing is a silent row, never a "
				+ `pass: missing=[${verdict.missing.join(", ")}] extra=[${verdict.extra.join(", ")}] `
				+ `duplicated=[${verdict.duplicates.join(", ")}] unreadable=[${verdict.incomplete.join("; ")}]`);
		} else {
			pass(`every one of the ${TYPES.length} staged types reports exactly one verdict in all three columns`);
		}
	} finally {
		try {
			mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
			writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, "\t")}\n`);
			say(`\nreport: ${REPORT_PATH}`);
		} catch (error) {
			console.error(error.stack || error.message);
			infraFail(`the JSON report could not be written to ${REPORT_PATH}: ${error.message}`);
		}

		say("\n=== SWEEP ===");
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			try {
				const swept = lua(host, "local deleted = 0\n"
					+ "for _, pl in pairs(game.forces.player.platforms) do\n"
					+ `  if pl.valid and pl.name == '${CLONE}' then\n`
					+ "    pcall(remote.call, 'surface_export', 'unlock_platform', pl.index)\n"
					+ "    if pl.surface and pl.surface.valid then game.delete_surface(pl.surface) end\n"
					+ "    deleted = deleted + 1\n"
					+ "  end\n"
					+ "end\n"
					+ "return { success = true, deleted = deleted }");
				say(`  host ${host}: delete_surface issued for ${swept.deleted} platform(s)`);
			} catch (error) {
				console.error(error.stack || error.message);
				infraFail(`sweep on host ${host} threw: ${error.message} — hand-clean with `
					+ "tools/tests/cleanup-test-surfaces.ps1 (prefix oneofeach-sweep- is in its sweep list)");
			}
		}
		await sleep(SETTLE_MS);
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			try {
				const left = lua(host, "local n = 0\n"
					+ "for _, pl in pairs(game.forces.player.platforms) do\n"
					+ `  if pl.valid and pl.name == '${CLONE}' then n = n + 1 end\n`
					+ "end\n"
					+ `local fixture = 0\n`
					+ "for _, pl in pairs(game.forces.player.platforms) do\n"
					+ `  if pl.valid and pl.name == '${FIXTURE}' then fixture = fixture + 1 end\n`
					+ "end\n"
					+ "return { success = true, leftover = n, fixture = fixture, "
					+ "paused = game.tick_paused == true }");
				if (left.leftover !== 0) infraFail(`sweep left ${left.leftover} '${CLONE}' on host ${host}`);
				else say(`  host ${host}: zero leftovers`);
				if (host === SOURCE_HOST && left.fixture !== 1) {
					infraFail(`host ${host} carries ${left.fixture} '${FIXTURE}' platform(s) after the run — the `
						+ "banked fixture must survive this rung untouched");
				}
				if (left.paused === true) infraFail(`host ${host} was left tick-paused`);
			} catch (error) {
				console.error(error.stack || error.message);
				infraFail(`leftover check on host ${host} threw: ${error.message} — treating as a leftover`);
			}
		}
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			if (previousDebug[host] === undefined) continue;
			try {
				lua(host, `remote.call('surface_export', 'configure', { debug_mode = ${previousDebug[host]} }) `
					+ "return { success = true }");
				say(`  host ${host}: debug_mode restored to ${previousDebug[host]}`);
			} catch (error) {
				console.error(error.stack || error.message);
				infraFail(`debug_mode restore on host ${host} threw: ${error.message}`);
			}
		}
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			try {
				docker(["exec", HOSTS[host].container, "sh", "-c", "rm -f /tmp/oneofeach-sweep-*"]);
			} catch (error) {
				console.error(error.stack || error.message);
				infraFail(`marker cleanup on host ${host} threw: ${error.message}`);
			}
		}
	}
}

main().then(() => {
	if (problems.length) {
		say(`\n=== one-of-each sweep: ${problems.length} INFRASTRUCTURE FAILURE(S) — the rig broke, which says `
			+ "nothing about fidelity ===");
		for (const problem of problems) say(`  - ${problem}`);
		process.exitCode = 1;
	} else {
		say("\n=== one-of-each sweep: infrastructure GREEN (clone, gate, complete table, quiescent hostiles, "
			+ "zero leftovers) — read the table above for the fidelity measurement ===");
	}
}).catch(error => {
	console.error(`one-of-each sweep: fatal — ${error && error.stack ? error.stack : error}`);
	process.exitCode = 1;
});
