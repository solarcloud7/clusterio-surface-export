import { readFileSync } from "node:fs";
import { join } from "node:path";

const rootPath = () => new URL("../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function parseCountKey(key) {
	const bar = key.indexOf("|");
	if (bar === -1) return { name: key, quality: "normal" };
	return { name: key.slice(0, bar), quality: key.slice(bar + 1) };
}

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

export function loadTriageTable(root = rootPath()) {
	const text = readFileSync(join(root, "docs", "ENGINEERING_FAQ.md"), "utf8");
	const anchor = text.indexOf("triage a failure black box");
	if (anchor === -1) return { rows: [], unavailable: "triage question not found in docs/ENGINEERING_FAQ.md" };
	const rows = [];
	for (const line of text.slice(anchor).split(/\r?\n/)) {
		const cells = line.split("|").map(c => c.trim());
		if (cells.length >= 5 && cells[1] && !/^[-\s]+$/.test(cells[1]) && cells[1] !== "Failure signature") {
			rows.push({ signature: cells[1], knownClass: cells[2], action: cells[3] });
		}
		if (rows.length > 0 && !line.trim().startsWith("|") && line.trim() !== "") break;
	}
	return rows.length > 0 ? { rows } : { rows: [], unavailable: "no signature rows parsed from the triage table" };
}

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
			importTickSpan: bundle.gate_tick != null && bundle.started_tick != null
				? bundle.gate_tick - bundle.started_tick : null,
		},
		failureStage: stage,
		selfReport: {
			diffRows: rows,
			expectedItemTypes: Object.keys(bundle.expected?.items || {}).length,
			expectedFluidNames: Object.keys(bundle.expected?.fluids || {}).length,
		},
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
