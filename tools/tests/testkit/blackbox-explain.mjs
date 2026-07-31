// testkit / blackboxExplain — decode a banked failure bundle and say what it means, offline.
//
// WHY THIS EXISTS (SC-71, the last open tooling-gap catalog item). Every gate failure banks an
// always-on black-box bundle, but every ANALYSIS of one has been a hand-written jq/Lua session,
// re-derived each time. Per the one-truth ruling, the repeated manual op becomes a testkit command.
//
// MEASUREMENT BOUNDARY, stated where it cannot be missed: a bundle carries TWO kinds of numbers.
//   * `expected`/`actual`/`diff` are the GATE'S OWN ACCOUNTING — the validator's self-report.
//   * `physical_entities`/`physical_fluid_segments` are a PHYSICAL SCAN of the destination surface
//     taken at banking time — an independent measurement.
// This tool reports both, labeled, and never presents the self-report as physical truth.
//
// TRIAGE HINT, not root cause: the known-failure-signature table lives in docs/ENGINEERING_FAQ.md
// (the one truth for triage knowledge). This module READS that table at run time and matches the
// bundle's diff signature against each row's vocabulary — it never restates the classes here. A
// matched row is a hint that the signature LOOKS like a known class; the minted self-test fixture
// itself proves the caveat (a forced-loss hook produces the same signature as the belt class).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rootPath = () => new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Split a gate count key into name + quality ("iron-plate" or "iron-plate|rare"). */
function parseCountKey(key) {
	const bar = key.indexOf("|");
	if (bar === -1) return { name: key, quality: "normal" };
	return { name: key.slice(0, bar), quality: key.slice(bar + 1) };
}

/** Length of a Lua-serialized collection: array → length, {} / keyed table → key count, absent → null. */
function countRecords(value) {
	if (Array.isArray(value)) return value.length;
	if (value && typeof value === "object") return Object.keys(value).length;
	return null;
}

function diffRows(diff, kind) {
	return Object.entries(diff || {}).map(([key, row]) => ({
		kind,
		key,
		...parseCountKey(key),
		expected: row.expected,
		actual: row.actual,
		delta: row.delta,
	}));
}

/**
 * Parse the known-failure-signature table out of ENGINEERING_FAQ.md.
 * Returns [] with a reason if the table cannot be located — a missing table must surface as
 * "triage unavailable", never as a silent "no known class matched" (that would be a vacuous miss).
 */
export function loadTriageTable(root = rootPath()) {
	const text = readFileSync(join(root, "docs", "ENGINEERING_FAQ.md"), "utf8");
	const anchor = text.indexOf("triage a failure black box");
	if (anchor === -1) return { rows: [], unavailable: "triage question not found in docs/ENGINEERING_FAQ.md" };
	const rows = [];
	for (const line of text.slice(anchor).split(/\r?\n/)) {
		const cells = line.split("|").map(c => c.trim());
		// A data row: "| signature | class | action |" → 5 cells after split (leading/trailing empty).
		if (cells.length >= 5 && cells[1] && !/^[-\s]+$/.test(cells[1]) && cells[1] !== "Failure signature") {
			rows.push({ signature: cells[1], knownClass: cells[2], action: cells[3] });
		}
		// Stop at the first non-table line after rows started (the paragraph below the table).
		if (rows.length > 0 && !line.trim().startsWith("|") && line.trim() !== "") break;
	}
	return rows.length > 0 ? { rows } : { rows: [], unavailable: "no signature rows parsed from the triage table" };
}

/**
 * Match the diff facts against one signature cell's recognized vocabulary. All recognized tokens
 * must hold, AND a stage token must be among them (a cell this matcher cannot read at all matches
 * nothing). DIRECTION RULE (review must-fix M3): a row whose cell names no direction is a LOSS
 * class — the FAQ table triages gate failures, and its only non-loss row says GAINED explicitly.
 * Without the implicit all-LOST requirement, a fluids GAIN matched the "Real fluid loss" row and
 * the printed operator action pointed the wrong way (measured on a constructed bundle).
 */
function rowMatches(signature, facts) {
	const wants = [];
	let hasStageToken = false;
	if (signature.includes("`items`")) { hasStageToken = true; wants.push(facts.stage === "items"); }
	if (signature.includes("`fluids`")) { hasStageToken = true; wants.push(facts.stage === "fluids"); }
	if (/\bone\b/.test(signature)) wants.push(facts.rowCount === 1);
	if (/\bmany\b/.test(signature)) wants.push(facts.rowCount > 1);
	if (signature.includes("LOST")) wants.push(facts.allNegative);
	if (signature.includes("GAINED")) wants.push(facts.allPositive);
	if (!signature.includes("LOST") && !signature.includes("GAINED")) wants.push(facts.allNegative);
	if (signature.includes("single-digit")) wants.push(facts.maxAbsDelta <= 9);
	return hasStageToken && wants.every(Boolean);
}

/**
 * Explain a decoded failure bundle. Pure and cluster-free; the caller supplies the parsed JSON.
 * Returns a machine-readable report; `formatExplanation` renders it for humans.
 */
export function explainBlackBox(bundle, { root } = {}) {
	const items = diffRows(bundle.diff?.items, "item");
	const fluids = diffRows(bundle.diff?.fluids, "fluid");
	const rows = [...items, ...fluids].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

	const stage = items.length > 0 && fluids.length > 0 ? "both"
		: items.length > 0 ? "items"
			: fluids.length > 0 ? "fluids" : "none";

	const deltas = rows.map(r => r.delta);
	const facts = {
		stage,
		rowCount: rows.length,
		allNegative: rows.length > 0 && deltas.every(d => d < 0),
		allPositive: rows.length > 0 && deltas.every(d => d > 0),
		maxAbsDelta: deltas.reduce((m, d) => Math.max(m, Math.abs(d)), 0),
	};

	const triageTable = loadTriageTable(root);
	let triage;
	if (triageTable.unavailable) {
		triage = { matched: false, unavailable: triageTable.unavailable };
	} else if (rows.length === 0) {
		// Distinct from "no class matched" (review must-fix M3): claiming unexplained-ness over an
		// EMPTY diff would be a positive claim the vocabulary cannot support.
		triage = { matched: false, inexpressible: "the bundle records no count mismatch at all — " +
			"the failure was not a count-diff failure; inspect the raw bundle and the transaction log" };
	} else if (stage === "both") {
		triage = { matched: false, inexpressible: "items AND fluids both mismatch — the FAQ signature " +
			"vocabulary has no combined-stage row; triage each stage by hand against the table" };
	} else {
		const hit = triageTable.rows.find(row => rowMatches(row.signature, facts));
		triage = hit
			? { matched: true, signature: hit.signature, knownClass: hit.knownClass, action: hit.action,
				caveat: "signature match is a triage HINT, not a root-cause determination — the self-test " +
					"fixture's forced-loss hook produces the same signature as a known class" }
			: { matched: false, note: "no known-class signature matched; per the FAQ this stays " +
				"unexplained until measured — never loosen the gate to make it disappear" };
	}

	const replay = bundle.replay_payload || null;
	return {
		bundle: {
			transferId: bundle.transfer_id ?? null,
			platform: bundle.platform_name ?? null,
			engineVersion: bundle.engine_version ?? null,
			modCount: Object.keys(bundle.mods || {}).length,
			gateTick: bundle.gate_tick ?? null,
			startedTick: bundle.started_tick ?? null,
			// The bundle carries no per-phase timings — those live in the controller transaction log
			// and the in-game /transaction-dashboard. The tick span is what IS measurable here.
			importTickSpan: bundle.gate_tick != null && bundle.started_tick != null
				? bundle.gate_tick - bundle.started_tick : null,
		},
		failureStage: stage,
		// The validator's self-report: the gate's own expected/actual accounting.
		selfReport: {
			diffRows: rows,
			expectedItemTypes: Object.keys(bundle.expected?.items || {}).length,
			expectedFluidNames: Object.keys(bundle.expected?.fluids || {}).length,
		},
		// Independent physical measurement taken at banking time, before the destination was discarded.
		// An EMPTY Lua table serializes as {} (object, not array), so "zero" must not decode as null.
		physicalScan: {
			destEntityCount: countRecords(bundle.physical_entities),
			destFluidSegmentCount: countRecords(bundle.physical_fluid_segments),
		},
		beltAttribution: bundle.belt_lines
			? { expectedTotal: bundle.belt_lines.expected_total, actualTotal: bundle.belt_lines.actual_total,
				delta: bundle.belt_lines.delta }
			: null,
		replay: replay
			? { present: true, schemaVersion: replay.schema_version ?? null,
				entityCount: Array.isArray(replay.entities) ? replay.entities.length : null,
				tileCount: Array.isArray(replay.tiles) ? replay.tiles.length : null }
			: { present: false },
		forceStateForces: Object.keys(bundle.force_state || {}),
		triage,
	};
}

export function explainBlackBoxFile(path, options) {
	return explainBlackBox(JSON.parse(readFileSync(path, "utf8")), options);
}

export function formatExplanation(report) {
	const lines = [];
	const b = report.bundle;
	lines.push(`failure black box — ${b.platform} (transfer ${b.transferId})`);
	lines.push(`  engine ${b.engineVersion}, ${b.modCount} mod(s), gate tick ${b.gateTick}` +
		(b.importTickSpan != null ? `, import span ${b.importTickSpan} tick(s)` : ""));
	lines.push(`  (per-phase timings are NOT in the bundle — see the controller transaction log / /transaction-dashboard)`);
	lines.push("");
	lines.push(`failed stage: ${report.failureStage}`);
	lines.push("");
	lines.push("gate self-report (the validator's own accounting), largest |delta| first:");
	if (report.selfReport.diffRows.length === 0) {
		lines.push("  (empty diff — the bundle records no count mismatch; inspect the raw bundle)");
	}
	for (const row of report.selfReport.diffRows) {
		const q = row.quality !== "normal" ? ` (${row.quality})` : "";
		lines.push(`  ${row.kind}  ${row.name}${q}: expected ${row.expected}, actual ${row.actual}  ` +
			`(${row.delta > 0 ? "GAINED" : "LOST"} ${Math.abs(row.delta)})`);
	}
	lines.push("");
	lines.push(`physical scan at banking time (independent of the gate): ` +
		`${report.physicalScan.destEntityCount} dest entities, ` +
		`${report.physicalScan.destFluidSegmentCount} fluid segment(s)`);
	if (report.beltAttribution && report.beltAttribution.delta !== 0) {
		lines.push(`belt attribution: expected ${report.beltAttribution.expectedTotal}, ` +
			`actual ${report.beltAttribution.actualTotal} (delta ${report.beltAttribution.delta})`);
	}
	lines.push(`replay payload: ${report.replay.present
		? `present (${report.replay.entityCount} entities, ${report.replay.tileCount} tiles, ` +
			`schema ${report.replay.schemaVersion}) — reimportable for a deterministic replay`
		: "ABSENT"}`);
	lines.push("");
	if (report.triage.matched) {
		lines.push(`triage (docs/ENGINEERING_FAQ.md): signature matches known class — ${report.triage.knownClass}`);
		lines.push(`  action: ${report.triage.action}`);
		lines.push(`  caveat: ${report.triage.caveat}`);
	} else if (report.triage.unavailable) {
		lines.push(`triage UNAVAILABLE: ${report.triage.unavailable}`);
	} else if (report.triage.inexpressible) {
		lines.push(`triage INEXPRESSIBLE for this bundle: ${report.triage.inexpressible}`);
	} else {
		lines.push(`triage: ${report.triage.note}`);
	}
	return lines.join("\n");
}
