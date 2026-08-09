#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "../../docker/seed-data/external_plugins/surface_export");
const BUILDER = path.join(PLUGIN, "dist/node/shared/transfer-timeline.js");
const SHARED_UTILS = path.join(PLUGIN, "dist/node/shared/utils.js");

if (!existsSync(BUILDER)) {
	console.error(`Timeline builder not built: ${BUILDER}\n`
		+ "Build it first (isolated container, never in the live plugin dir):\n"
		+ "  ./tools/clusterio/build-plugin.ps1 node");
	process.exit(1);
}
const req = createRequire(import.meta.url);
const { buildTransferTimeline, describeAttribution, TIMELINE_PALETTE, tickHatch, toGanttGeometry } = req(BUILDER);
const { formatMs } = req(SHARED_UTILS);

const argv = process.argv.slice(2);
const argOf = name => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : null;
};
const logPath = argOf("--log");
const outPath = argOf("--out") || path.join(PLUGIN, "dist/transfer-timeline-preview.html");

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

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

function renderCase(testCase) {
	const timeline = buildTransferTimeline(testCase.events, null);
	const { totalMs, rows, attribution } = timeline;
	const kb = testCase.artifactSizeBytes ? `${Math.round(testCase.artifactSizeBytes / 1024)} KB` : "";

	const bars = rows.map(row => {
		const color = TIMELINE_PALETTE[row.color] || TIMELINE_PALETTE.blue;
		const { startPct, widthPct, markerPct } = toGanttGeometry(row, totalMs);
		const tip = esc([`${row.label}${row.durationMs != null ? ` — ${formatMs(row.durationMs)}` : ""}`, row.note]
			.filter(Boolean).join("\n"));
		const bg = row.kind === "tickDerived"
			? `${tickHatch(color)}; border:1px solid ${color}`
			: color;
		const isGap = row.kind === "residual" || row.kind === "detailGap";
		const mark = row.kind === "event"
			? `<span class="marker" style="left:${markerPct}%;background:${color}" title="${tip}"></span>`
			: `<span class="bar" style="left:${startPct}%;width:${widthPct}%;background:${bg}" title="${tip}"></span>`;
		return `<div class="row">
			<div class="label" style="padding-left:${4 + row.indent * 14}px${row.kind === "event" ? ";font-weight:600" : ""}${isGap ? ";color:#d48806" : ""}" title="${tip}">${esc(row.label)}</div>
			<div class="track">${mark}</div>
			<div class="time">${formatMs(row.durationMs)}</div>
		</div>`;
	}).join("\n");

	const notice = describeAttribution(attribution);
	const warn = notice ? `<div class="warn"><b>${esc(notice.headline)}.</b> ${esc(notice.detail)}</div>` : "";

	return {
		timeline,
		html: `<section>
		<h2>${esc(testCase.platformName || testCase.label)} <small>${esc(testCase.label)} · ${kb} · total ${formatMs(totalMs)}</small></h2>
		${warn}
		<div class="timeline">${bars}
			<div class="axis"><span>0</span><span>${formatMs(totalMs)}</span></div>
		</div>
	</section>`,
	};
}

const rendered = cases.map(testCase => ({ testCase, ...renderCase(testCase) }));

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
	<b>unattributed</b> wall clock; dark orange is <b>measured time with no phase detail</b>.
	Source: ${esc(logPath || "test/fixtures/real-transfer-timelines.json")}
</div>
${rendered.map(r => r.html).join("\n")}
`;

writeFileSync(outPath, html);
console.log(`Rendered ${rendered.length} transfer(s) -> ${outPath}`);
for (const { testCase, timeline } of rendered) {
	console.log(`  ${String(testCase.platformName || testCase.label).slice(0, 28).padEnd(30)} `
		+ `total ${String(formatMs(timeline.totalMs)).padStart(7)}  unattributed ${timeline.attribution.residualPct.toFixed(0).padStart(3)}%`
		+ `  detail-gap ${formatMs(timeline.attribution.detailGapMs) || "0ms"}`);
}
