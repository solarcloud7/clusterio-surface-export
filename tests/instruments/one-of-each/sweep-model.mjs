// sweep-model — the per-type verdict table for a one-of-each transfer sweep, and the ordering latch
// the gate-before-destination rule is enforced by
//
// requires: the vendored universe.json type list, a physical source read, a payload entity list, a
//           gate record, and a physical destination read — all as plain rows
// produces: buildTable() -> one row per STAGED TYPE carrying capture/gate/restore verdicts plus the
//           source/destination samples that justify them; completeness() -> the set-based
//           infrastructure verdict; createGateLatch() -> a destination read refuses to run until the
//           gate has been adjudicated
// does not: contact the cluster, read the payload's own type list (rows are keyed on universe types,
//           never on what the payload happened to carry), resolve any entity by unit_number, treat a
//           capped gate detail list as a PASS, or grade a fidelity verdict as a test failure

export const CELL_TOLERANCE = 0.5;
export const GATE_DETAIL_CAP = 50;

export const NOT_STAGED = "NOT_STAGED";
export const CAPTURE_VERDICTS = ["CAPTURED", "PARTIAL", "ABSENT", NOT_STAGED];
export const GATE_VERDICTS = ["PASS", "REFUSED", "UNKNOWN", NOT_STAGED];
export const RESTORE_VERDICTS = ["RESTORED", "WRONG", "LOST", NOT_STAGED];

export function distance(a, b) {
	return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
}

export function normalizeRow(row) {
	const position = row.position && typeof row.position === "object" ? row.position : row;
	return {
		type: row.type ?? row.t,
		name: row.name ?? row.n,
		x: Number(Array.isArray(position) ? position[0] : position.x),
		y: Number(Array.isArray(position) ? position[1] : position.y),
	};
}

export function normalizeRows(rows) {
	if (rows === null || rows === undefined) return [];
	const list = Array.isArray(rows) ? rows : Object.values(rows);
	return list.map(normalizeRow).filter(row => typeof row.type === "string" && typeof row.name === "string"
		&& Number.isFinite(row.x) && Number.isFinite(row.y));
}

function nearestUnconsumed(cell, pool, tolerance, predicate) {
	let best = -1;
	let bestDistance = Infinity;
	for (let index = 0; index < pool.length; index++) {
		const candidate = pool[index];
		if (candidate.consumed || !predicate(candidate.row)) continue;
		const gap = distance(cell, candidate.row);
		if (gap <= tolerance && gap < bestDistance) { best = index; bestDistance = gap; }
	}
	if (best === -1) return null;
	pool[best].consumed = true;
	return { row: pool[best].row, drift: bestDistance };
}

export function matchCells(cells, rows, tolerance = CELL_TOLERANCE) {
	const pool = rows.map(row => ({ row, consumed: false }));
	const outcomes = new Map();
	const pending = [];
	for (const cell of cells) {
		const exact = nearestUnconsumed(cell, pool, tolerance,
			row => row.type === cell.type && row.name === cell.name);
		if (exact) outcomes.set(cell, { kind: "matched", cell, drift: exact.drift });
		else pending.push(cell);
	}
	for (const cell of pending) {
		const other = nearestUnconsumed(cell, pool, tolerance, () => true);
		outcomes.set(cell, other
			? { kind: "substituted", cell, found: other.row, drift: other.drift }
			: { kind: "missing", cell });
	}
	const ordered = cells.map(cell => outcomes.get(cell));
	return {
		outcomes: ordered,
		matched: ordered.filter(entry => entry.kind === "matched"),
		substituted: ordered.filter(entry => entry.kind === "substituted"),
		missing: ordered.filter(entry => entry.kind === "missing"),
	};
}

export function groupOutcomes(outcomes) {
	const byType = new Map();
	for (const entry of outcomes) {
		const type = entry.cell.type;
		if (!byType.has(type)) byType.set(type, { outcomes: [], matched: [], substituted: [], missing: [] });
		const bucket = byType.get(type);
		bucket.outcomes.push(entry);
		if (entry.kind === "matched") bucket.matched.push(entry);
		else if (entry.kind === "substituted") bucket.substituted.push(entry);
		else bucket.missing.push(entry);
	}
	return byType;
}

const EMPTY_MATCH = { outcomes: [], matched: [], substituted: [], missing: [] };

export function captureVerdict(match, staged) {
	if (staged === 0) return NOT_STAGED;
	if (match.matched.length === staged) return "CAPTURED";
	if (match.matched.length === 0) return "ABSENT";
	return "PARTIAL";
}

export function restoreVerdict(match, staged) {
	if (staged === 0) return NOT_STAGED;
	if (match.missing.length > 0) return "LOST";
	if (match.substituted.length > 0) return "WRONG";
	return "RESTORED";
}

export function summarizeGate(gate) {
	const losses = (gate && gate.failedEntityLosses) || null;
	const detailed = normalizeRows(losses && losses.entities);
	const refusedTotal = Number(losses && losses.entity_count) || 0;
	const byType = new Map();
	for (const row of detailed) byType.set(row.type, (byType.get(row.type) || 0) + 1);
	return {
		success: gate ? gate.validation_success === true : false,
		refusedTotal,
		detailedTotal: detailed.length,
		detailCapped: refusedTotal > detailed.length,
		byType,
		samples: detailed,
	};
}

export function gateVerdictFor(type, summary, staged) {
	if (staged === 0) return NOT_STAGED;
	if (summary.byType.has(type)) return "REFUSED";
	if (summary.detailCapped) return "UNKNOWN";
	return "PASS";
}

function sample(rows, limit = 3) {
	return rows.slice(0, limit).map(row => `${row.name}@${row.x},${row.y}`);
}

export function buildTable({ types, sourceRows, payloadRows, gate, destRows, fixtureRows = [],
	tolerance = CELL_TOLERANCE }) {
	const source = normalizeRows(sourceRows);
	const payload = normalizeRows(payloadRows);
	const destination = normalizeRows(destRows);
	const fixture = normalizeRows(fixtureRows);
	const gateSummary = summarizeGate(gate);

	const byType = rows => {
		const map = new Map();
		for (const row of rows) {
			if (!map.has(row.type)) map.set(row.type, []);
			map.get(row.type).push(row);
		}
		return map;
	};
	const sourceByType = byType(source);
	const destByType = byType(destination);
	const fixtureByType = byType(fixture);

	const captureByType = groupOutcomes(matchCells(source, payload, tolerance).outcomes);
	const restoreByType = groupOutcomes(matchCells(source, destination, tolerance).outcomes);

	const rows = types.map(type => {
		const cells = sourceByType.get(type) || [];
		const captureMatch = captureByType.get(type) || EMPTY_MATCH;
		const restoreMatch = restoreByType.get(type) || EMPTY_MATCH;
		return {
			type,
			staged: cells.length,
			stagedOnFixture: (fixtureByType.get(type) || []).length,
			capture: captureVerdict(captureMatch, cells.length),
			gate: gateVerdictFor(type, gateSummary, cells.length),
			restore: restoreVerdict(restoreMatch, cells.length),
			capturedCells: captureMatch.matched.length,
			restoredCells: restoreMatch.matched.length,
			wrongCells: restoreMatch.substituted.length,
			lostCells: restoreMatch.missing.length,
			gateRefusedCells: gateSummary.byType.get(type) || 0,
			sourceSample: sample(cells),
			destinationSample: sample(destByType.get(type) || []),
			substitutions: restoreMatch.substituted.slice(0, 3).map(entry =>
				`${entry.cell.name}@${entry.cell.x},${entry.cell.y} -> ${entry.found.type}/${entry.found.name}`),
			lostSample: restoreMatch.missing.slice(0, 3).map(entry => `${entry.cell.name}@${entry.cell.x},${entry.cell.y}`),
			maxDrift: restoreMatch.matched.reduce((worst, entry) => Math.max(worst, entry.drift), 0),
		};
	});

	const known = new Set(types);
	const unkeyedSourceTypes = [...sourceByType.keys()].filter(type => !known.has(type)).sort();
	const unkeyedDestTypes = [...destByType.keys()].filter(type => !known.has(type)).sort();

	return { rows, gateSummary, unkeyedSourceTypes, unkeyedDestTypes };
}

export function completeness(rows, types) {
	const wanted = new Set(types);
	const seen = new Set();
	const duplicates = [];
	const incomplete = [];
	for (const row of rows) {
		if (seen.has(row.type)) duplicates.push(row.type);
		seen.add(row.type);
		const cells = [["capture", row.capture, CAPTURE_VERDICTS], ["gate", row.gate, GATE_VERDICTS],
			["restore", row.restore, RESTORE_VERDICTS]];
		const bad = cells.filter(([, value, allowed]) => !allowed.includes(value))
			.map(([column, value]) => `${column}=${value === undefined ? "<undefined>" : String(value)}`);
		if (bad.length) incomplete.push(`${row.type}: ${bad.join(", ")}`);
	}
	const missing = [...wanted].filter(type => !seen.has(type)).sort();
	const extra = [...seen].filter(type => !wanted.has(type)).sort();
	return {
		ok: missing.length === 0 && extra.length === 0 && duplicates.length === 0 && incomplete.length === 0,
		missing, extra, duplicates: [...new Set(duplicates)].sort(), incomplete,
	};
}

export function createGateLatch() {
	let verdict = null;
	return {
		adjudicate(gate) {
			if (gate === null || typeof gate !== "object") {
				throw new Error("gate latch: adjudicate needs the import result object");
			}
			verdict = { success: gate.validation_success === true, gate };
			return verdict;
		},
		require(what) {
			if (verdict === null) {
				throw new Error(`gate latch: ${what} was attempted before the gate verdict was adjudicated — `
					+ "a destination read taken ahead of the gate cannot tell a restoration from a rollback");
			}
			return verdict;
		},
		get adjudicated() { return verdict !== null; },
	};
}

export function tallyVerdicts(rows, column) {
	const counts = new Map();
	for (const row of rows) counts.set(row[column], (counts.get(row[column]) || 0) + 1);
	return counts;
}
