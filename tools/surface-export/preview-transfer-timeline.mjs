#!/usr/bin/env node
// Render the Transfer Flow waterfall to a standalone HTML file — no cluster, no controller, no
// webpack, no docker.
//
// Why this exists: the Transaction Logs tab can only be seen by deploying the web bundle to the
// controller, which rebuilds dist/ from the canonical checkout and bounces the controller. That is
// exactly the operation the working-hygiene rule forbids while another agent owns that checkout, and
// it is a slow loop besides. The timeline is a PURE function of recorded events
// (shared/transfer-timeline.ts), so it can be rendered from banked data by itself.
//
// The colours and bar geometry mirror web/TransactionLogsTab.tsx. This is a debugging lens, not a
// second implementation: the row set, the widths and the attribution all come from the SAME builder
// the browser calls, so a preview that looks wrong means the builder is wrong.
//
//   node tools/surface-export/preview-transfer-timeline.mjs                    # bundled fixtures
//   node tools/surface-export/preview-transfer-timeline.mjs --log <txlogs.json>  # any real log
//   node tools/surface-export/preview-transfer-timeline.mjs --out timeline.html
//
// To pull a live log without touching the plugin source (read-only, safe on a busy checkout):
//   docker cp surface-export-controller:/clusterio/data/database/surface_export_transaction_logs.json .

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "../../docker/seed-data/external_plugins/surface_export");
const BUILDER = path.join(PLUGIN, "dist/node/shared/transfer-timeline.js");

if (!existsSync(BUILDER)) {
	console.error(`Timeline builder not built: ${BUILDER}\n`
		+ "Build it first (isolated container, never in the live plugin dir):\n"
		+ "  ./tools/clusterio/build-plugin.ps1 node");
	process.exit(1);
}
const { buildTransferTimeline, describeAttribution } = createRequire(import.meta.url)(BUILDER);

const argv = process.argv.slice(2);
const argOf = name => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : null;
};
const logPath = argOf("--log");
const outPath = argOf("--out") || path.join(PLUGIN, "dist/transfer-timeline-preview.html");

// Two accepted inputs: the bundled fixture list, or a raw controller transaction-log dump.
let cases;
if (logPath) {
	const raw = JSON.parse(readFileSync(logPath, "utf8"));
	const entries = Array.isArray(raw) ? raw : (raw.transactionLogs || []);
	cases = entries
		.filter(e => (e.events || []).length > 1)
		.slice(-12)
		.reverse()
		.map(e => ({
			label: e.transferId,
			platformName: e.transferInfo?.platformName ?? "?",
			artifactSizeBytes: e.transferInfo?.artifactSizeBytes ?? null,
			events: e.events || [],
		}));
} else {
	cases = JSON.parse(readFileSync(path.join(PLUGIN, "test/fixtures/real-transfer-timelines.json"), "utf8"));
}
if (!cases.length) {
	console.error("No transfers with events found in the input.");
	process.exit(1);
}

const COLORS = {
	red: "#ff4d4f", green: "#52c41a", blue: "#1890ff",
	tiles: "#36cfc9", entities: "#1890ff", belts: "#40a9ff", state: "#597ef7",
	inventories: "#2f54eb", validation: "#85a5ff", fluids: "#08979c",
	transmission: "#13c2c2", cleanup: "#73d13d",
	delivery: "#1d39c4", queue: "#adc6ff",
	destImport: "#0958d9", residual: "#faad14",
	exportPrep: "#bae0ff", exportQueue: "#91caff", exportAsync: "#69c0ff", exportStore: "#4096ff",
};
const fmt = ms => (ms == null ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

function renderCase(testCase) {
	const { totalMs, rows, attribution } = buildTransferTimeline(testCase.events, null);
	const scale = totalMs > 0 ? totalMs : 1;
	const kb = testCase.artifactSizeBytes ? `${Math.round(testCase.artifactSizeBytes / 1024)} KB` : "";

	const bars = rows.map(row => {
		const color = COLORS[row.color] || COLORS.blue;
		const startPct = Math.max(0, Math.min(100, (row.startMs / scale) * 100));
		const widthPct = row.endMs > row.startMs
			? Math.max(0.8, Math.min(100 - startPct, ((row.endMs - row.startMs) / scale) * 100))
			: 0;
		const tip = esc([`${row.label}${row.durationMs != null ? ` — ${fmt(row.durationMs)}` : ""}`, row.note]
			.filter(Boolean).join("\n"));
		const bg = row.kind === "tickDerived"
			? `repeating-linear-gradient(135deg, ${color} 0 4px, transparent 4px 8px); border:1px solid ${color}`
			: color;
		const mark = row.isEvent
			? `<span class="marker" style="left:${startPct}%;background:${color}" title="${tip}"></span>`
			: `<span class="bar" style="left:${startPct}%;width:${widthPct}%;background:${bg}" title="${tip}"></span>`;
		return `<div class="row">
			<div class="label" style="padding-left:${4 + row.indent * 14}px${row.isEvent ? ";font-weight:600" : ""}${row.kind === "residual" ? ";color:#d48806" : ""}" title="${tip}">${esc(row.label)}</div>
			<div class="track">${mark}</div>
			<div class="time">${fmt(row.durationMs)}</div>
		</div>`;
	}).join("\n");

	// Same wording as the browser tab — describeAttribution is the single source for it.
	const notice = describeAttribution(attribution);
	const warn = notice ? `<div class="warn"><b>${esc(notice.headline)}.</b> ${esc(notice.detail)}</div>` : "";

	return `<section>
		<h2>${esc(testCase.platformName || testCase.label)} <small>${esc(testCase.label)} · ${kb} · total ${fmt(totalMs)}</small></h2>
		${warn}
		<div class="timeline">${bars}
			<div class="axis"><span>0</span><span>${fmt(totalMs)}</span></div>
		</div>
	</section>`;
}

const html = `<!doctype html>
<meta charset="utf-8"><title>Transfer Flow timeline preview</title>
<style>
	body { background:#141414; color:#e6e6e6; font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; margin:24px auto; max-width:1100px; }
	h1 { font-size:18px; } h2 { font-size:14px; margin:28px 0 8px; border-bottom:1px solid #303030; padding-bottom:6px; }
	small { color:#8c8c8c; font-weight:400; }
	.legend { color:#8c8c8c; font-size:12px; margin-bottom:8px; }
	.legend b { color:#e6e6e6; }
	.warn { background:#2b2111; border:1px solid #594214; color:#ffd591; padding:8px 12px; border-radius:4px; margin-bottom:10px; }
	.timeline { border:1px solid #303030; border-radius:4px; padding:8px; background:#1f1f1f; }
	.row { display:flex; align-items:center; height:22px; }
	.label { width:290px; flex:none; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
	.track { position:relative; flex:1; height:14px; background:#141414; border-radius:2px; }
	.bar { position:absolute; top:2px; height:10px; border-radius:2px; }
	.marker { position:absolute; top:0; width:2px; height:14px; }
	.time { width:64px; flex:none; text-align:right; color:#8c8c8c; font-size:11px; }
	.axis { display:flex; justify-content:space-between; color:#8c8c8c; font-size:11px; margin-top:6px; padding-left:290px; }
</style>
<h1>Transfer Flow timeline — offline preview</h1>
<div class="legend">
	Solid bars are <b>wall-clock measurements</b>. Hatched bars are <b>tick-derived</b>: a game.tick
	count scaled by a nominal 60 UPS, which cannot grow when a tick runs long. Amber is
	<b>unattributed</b> wall clock. Source: ${esc(logPath || "test/fixtures/real-transfer-timelines.json")}
</div>
${cases.map(renderCase).join("\n")}
`;

writeFileSync(outPath, html);
console.log(`Rendered ${cases.length} transfer(s) -> ${outPath}`);
for (const testCase of cases) {
	const { totalMs, attribution } = buildTransferTimeline(testCase.events, null);
	console.log(`  ${String(testCase.platformName || testCase.label).slice(0, 28).padEnd(30)} `
		+ `total ${String(fmt(totalMs)).padStart(7)}  unattributed ${attribution.residualPct.toFixed(0).padStart(3)}%`);
}
