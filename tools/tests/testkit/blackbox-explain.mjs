import { readFileSync } from "node:fs";

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

export function explainBlackBox(bundle) {
	const items = diffRows(bundle.diff?.items, "item");
	const fluids = diffRows(bundle.diff?.fluids, "fluid");
	const rows = [...items, ...fluids].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

	const stage = items.length > 0 && fluids.length > 0 ? "both"
		: items.length > 0 ? "items"
			: fluids.length > 0 ? "fluids" : "none";

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
	};
}

export function explainBlackBoxFile(path) {
	return explainBlackBox(JSON.parse(readFileSync(path, "utf8")));
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
	return lines.join("\n");
}
