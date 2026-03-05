const fs = require("fs");
const file = "docker/seed-data/external_plugins/surface_export/web/TransactionLogsTab.jsx";
let content = fs.readFileSync(file, "utf8");

// ── Replace buildFlowTimelineRows ────────────────────────────────────────────
const oldFnStart = "function buildFlowTimelineRows(rows) {";
const oldFnEnd = "\n}\n\nexport default function TransactionLogsTab";
const fnStart = content.indexOf(oldFnStart);
const fnEnd = content.indexOf(oldFnEnd, fnStart);
if (fnStart === -1 || fnEnd === -1) { console.error("fn bounds not found", fnStart, fnEnd); process.exit(1); }

const newFn = `function buildGanttRows(events, detailedSummary) {
\t// Produce one row per named phase across all events.
\t// Each row: { key, label, isEvent, indent, startMs, endMs, durationMs, color }
\t// All times are absolute ms from transfer start (elapsedMs of first event = 0).
\tconst rows = [];
\tlet totalMs = 0;

\tfor (const event of events || []) {
\t\tconst elapsedMs = typeof event?.elapsedMs === "number" ? event.elapsedMs : null;
\t\tconst isFailure = String(event?.eventType || "").includes("failed") || String(event?.eventType || "").includes("error");
\t\tconst isSuccess = String(event?.eventType || "").includes("completed") || String(event?.eventType || "").includes("success");
\t\tconst color = isFailure ? "red" : isSuccess ? "green" : "blue";

\t\t// Event anchor row (marker only, no duration bar)
\t\trows.push({ key: \`event:\${event?.eventType}:\${elapsedMs}\`, label: event?.eventType || "event",
\t\t\tisEvent: true, indent: 0, startMs: elapsedMs ?? 0, endMs: elapsedMs ?? 0,
\t\t\tdurationMs: null, color });
\t\tif (elapsedMs !== null) totalMs = Math.max(totalMs, elapsedMs);

\t\t// Export sub-phases (on transfer_created)
\t\tconst exportMetrics = event?.exportMetrics
\t\t\t|| (event?.eventType === "transfer_created" ? detailedSummary?.export || null : null);
\t\tif (exportMetrics && typeof exportMetrics === "object") {
\t\t\tconst eventStart = elapsedMs ?? 0;
\t\t\tconst lockMs = Number(exportMetrics.requestExportAndLockMs ?? 0);
\t\t\tconst storeMs = Number(exportMetrics.waitForControllerStoreMs ?? 0);
\t\t\tconst asyncMs = Number(exportMetrics.instanceAsyncExportMs ?? 0);
\t\t\tconst ticks = Number(exportMetrics.instanceAsyncExportTicks ?? 0);
\t\t\t// requestExportAndLockMs and waitForControllerStoreMs are sequential sub-phases.
\t\t\t// controllerExportPrepTotalMs = lockMs + storeMs (derived, skip).
\t\t\t// instanceAsyncExportMs starts after prep.
\t\t\tlet cursor = eventStart;
\t\t\tif (lockMs > 0) {
\t\t\t\trows.push({ key: \`export:lock:\${eventStart}\`, label: "Queue + lock",
\t\t\t\t\tisEvent: false, indent: 1, startMs: cursor, endMs: cursor + lockMs,
\t\t\t\t\tdurationMs: lockMs, color: "blue" });
\t\t\t\ttotalMs = Math.max(totalMs, cursor + lockMs);
\t\t\t\tcursor += lockMs;
\t\t\t}
\t\t\tif (storeMs > 0) {
\t\t\t\trows.push({ key: \`export:store:\${eventStart}\`, label: "Wait for store",
\t\t\t\t\tisEvent: false, indent: 1, startMs: cursor, endMs: cursor + storeMs,
\t\t\t\t\tdurationMs: storeMs, color: "blue" });
\t\t\t\ttotalMs = Math.max(totalMs, cursor + storeMs);
\t\t\t\tcursor += storeMs;
\t\t\t}
\t\t\tif (asyncMs > 0) {
\t\t\t\tconst asyncLabel = ticks > 0 ? \`Async export (\${ticks.toLocaleString()} ticks)\` : "Async export";
\t\t\t\trows.push({ key: \`export:async:\${eventStart}\`, label: asyncLabel,
\t\t\t\t\tisEvent: false, indent: 1, startMs: cursor, endMs: cursor + asyncMs,
\t\t\t\t\tdurationMs: asyncMs, color: "blue" });
\t\t\t\ttotalMs = Math.max(totalMs, cursor + asyncMs);
\t\t\t}
\t\t}

\t\t// Import sub-phases
\t\tif (event?.importMetrics && typeof event.importMetrics === "object") {
\t\t\tconst m = event.importMetrics;
\t\t\tconst eventStart = elapsedMs ?? 0;
\t\t\tlet cursor = eventStart;
\t\t\tconst tilesMs = Number(m.tiles_ms ?? 0);
\t\t\tconst tilesCount = Number(m.tiles_placed ?? 0);
\t\t\tconst entitiesMs = Number(m.entities_ms ?? 0);
\t\t\tconst entitiesCount = Number(m.entities_created ?? 0);
\t\t\tconst totalImportMs = Number(m.total_ms ?? 0);
\t\t\tif (tilesMs > 0 || tilesCount > 0) {
\t\t\t\tconst label = tilesCount > 0 ? \`Tiles (\${tilesCount.toLocaleString()})\` : "Tiles";
\t\t\t\trows.push({ key: \`import:tiles:\${eventStart}\`, label,
\t\t\t\t\tisEvent: false, indent: 1, startMs: cursor, endMs: cursor + (tilesMs || 0),
\t\t\t\t\tdurationMs: tilesMs || null, color: "blue" });
\t\t\t\ttotalMs = Math.max(totalMs, cursor + (tilesMs || 0));
\t\t\t\tcursor += tilesMs;
\t\t\t}
\t\t\tif (entitiesMs > 0 || entitiesCount > 0) {
\t\t\t\tconst label = entitiesCount > 0 ? \`Entities (\${entitiesCount.toLocaleString()})\` : "Entities";
\t\t\t\trows.push({ key: \`import:entities:\${eventStart}\`, label,
\t\t\t\t\tisEvent: false, indent: 1, startMs: cursor, endMs: cursor + (entitiesMs || 0),
\t\t\t\t\tdurationMs: entitiesMs || null, color: "blue" });
\t\t\t\ttotalMs = Math.max(totalMs, cursor + (entitiesMs || 0));
\t\t\t\tcursor += entitiesMs;
\t\t\t}
\t\t\tif (totalImportMs > 0) {
\t\t\t\t// Import total spans from event start
\t\t\t\trows.push({ key: \`import:total:\${eventStart}\`, label: "Import total",
\t\t\t\t\tisEvent: false, indent: 1, startMs: eventStart, endMs: eventStart + totalImportMs,
\t\t\t\t\tdurationMs: totalImportMs, color: "blue" });
\t\t\t\ttotalMs = Math.max(totalMs, eventStart + totalImportMs);
\t\t\t}
\t\t}

\t\t// Transfer-level phases (transmission, validation, cleanup)
\t\tif (typeof event?.transmissionMs === "number" && event.transmissionMs > 0) {
\t\t\tconst eventStart = elapsedMs ?? 0;
\t\t\trows.push({ key: \`phase:transmission:\${eventStart}\`, label: "Transmission",
\t\t\t\tisEvent: false, indent: 1, startMs: eventStart - event.transmissionMs, endMs: eventStart,
\t\t\t\tdurationMs: event.transmissionMs, color: "blue" });
\t\t\ttotalMs = Math.max(totalMs, eventStart);
\t\t}
\t\tif (typeof event?.validationMs === "number" && event.validationMs > 0) {
\t\t\tconst eventStart = elapsedMs ?? 0;
\t\t\trows.push({ key: \`phase:validation:\${eventStart}\`, label: "Validation",
\t\t\t\tisEvent: false, indent: 1, startMs: eventStart - event.validationMs, endMs: eventStart,
\t\t\t\tdurationMs: event.validationMs, color: "blue" });
\t\t\ttotalMs = Math.max(totalMs, eventStart);
\t\t}
\t\tif (event?.phases && typeof event.phases === "object") {
\t\t\tconst eventStart = elapsedMs ?? 0;
\t\t\tfor (const [k, v] of Object.entries(event.phases)) {
\t\t\t\tif (typeof v === "number" && v > 0) {
\t\t\t\t\trows.push({ key: \`phase:\${k}:\${eventStart}\`, label: humanizeMetricKey(String(k).replace(/Ms$/, "")),
\t\t\t\t\t\tisEvent: false, indent: 1, startMs: eventStart - v, endMs: eventStart,
\t\t\t\t\t\tdurationMs: v, color: "blue" });
\t\t\t\t\ttotalMs = Math.max(totalMs, eventStart);
\t\t\t\t}
\t\t\t}
\t\t}
\t}

\tconst scale = totalMs > 0 ? totalMs : 1;
\treturn {
\t\ttotalMs,
\t\trows: rows.map(row => ({
\t\t\t...row,
\t\t\tganttStartPct: Math.max(0, Math.min(100, (row.startMs / scale) * 100)),
\t\t\tganttWidthPct: row.endMs > row.startMs
\t\t\t\t? Math.max(0.8, Math.min(100 - (row.startMs / scale) * 100, ((row.endMs - row.startMs) / scale) * 100))
\t\t\t\t: 0,
\t\t\tganttMarkerPct: Math.max(0, Math.min(100, (row.endMs / scale) * 100)),
\t\t})),
\t};
}
`;

content = content.slice(0, fnStart) + newFn + content.slice(fnEnd + 2); // +2 for the leading \n

// ── Replace flowColumns ───────────────────────────────────────────────────────
const oldCols = content.indexOf("\tconst flowColumns = [");
const oldColsEnd = content.indexOf("\n\t];\n\n\tconst flowRows", oldCols);
if (oldCols === -1 || oldColsEnd === -1) { console.error("flowColumns not found", oldCols, oldColsEnd); process.exit(1); }

const newCols = `\tconst flowColumns = [
\t\t{
\t\t\ttitle: "Phase",
\t\t\tdataIndex: "label",
\t\t\tkey: "label",
\t\t\twidth: "22%",
\t\t\trender: (label, row) => row.isEvent
\t\t\t\t? <Tag color={row.color}>{label}</Tag>
\t\t\t\t: <span style={{ paddingLeft: row.indent * 16, color: "rgba(0,0,0,0.65)", fontSize: 12 }}>{label}</span>,
\t\t},
\t\t{
\t\t\ttitle: "ms",
\t\t\tdataIndex: "durationMs",
\t\t\tkey: "durationMs",
\t\t\twidth: "10%",
\t\t\trender: value => value !== null && value !== undefined ? formatFlowDurationMs(value) : "",
\t\t},
\t\t{
\t\t\ttitle: "Timeline",
\t\t\tkey: "timeline",
\t\t\trender: (_, row) => {
\t\t\t\tconst tone = row.color === "red" ? "#ff4d4f" : row.color === "green" ? "#52c41a" : "#1677ff";
\t\t\t\treturn (
\t\t\t\t\t<div className="surface-export-gantt-track" title={row.durationMs !== null ? formatFlowDurationMs(row.durationMs) : row.label}>
\t\t\t\t\t\t{row.ganttWidthPct > 0 && (
\t\t\t\t\t\t\t<span className="surface-export-gantt-bar" style={{
\t\t\t\t\t\t\t\tleft: \`\${row.ganttStartPct}%\`,
\t\t\t\t\t\t\t\twidth: \`\${row.ganttWidthPct}%\`,
\t\t\t\t\t\t\t\tbackgroundColor: tone,
\t\t\t\t\t\t\t\topacity: row.isEvent ? 0 : 0.75,
\t\t\t\t\t\t\t}} />
\t\t\t\t\t\t)}
\t\t\t\t\t\t<span className="surface-export-gantt-marker" style={{
\t\t\t\t\t\t\tleft: \`\${row.ganttMarkerPct}%\`,
\t\t\t\t\t\t\tbackgroundColor: tone,
\t\t\t\t\t\t\topacity: row.isEvent ? 1 : 0.4,
\t\t\t\t\t\t}} />
\t\t\t\t\t</div>
\t\t\t\t);
\t\t\t},
\t\t},
\t]`;

content = content.slice(0, oldCols) + newCols + content.slice(oldColsEnd + "\n\t];".length);

// ── Replace flowRows + flowTimeline useMemos ──────────────────────────────────
// We need to replace both the flowRows and flowTimeline useMemos with a single buildGanttRows call
const oldFlowRows = content.indexOf("\tconst flowRows = useMemo(");
const oldFlowTimeline = content.indexOf("\n\tconst flowTimeline = useMemo(() => buildFlowTimelineRows(flowRows), [flowRows]);");
if (oldFlowRows === -1 || oldFlowTimeline === -1) { console.error("flowRows/flowTimeline not found", oldFlowRows, oldFlowTimeline); process.exit(1); }

// Find the end of flowRows useMemo
const flowRowsEnd = content.indexOf("\n\t);\n\tconst flowTimeline", oldFlowRows);
if (flowRowsEnd === -1) { console.error("flowRowsEnd not found"); process.exit(1); }

const oldFlowTimelineEnd = oldFlowTimeline + "\n\tconst flowTimeline = useMemo(() => buildFlowTimelineRows(flowRows), [flowRows]);".length;

// Replace flowRows useMemo + flowTimeline with single gantt useMemo
const newGantt = `\tconst flowTimeline = useMemo(
\t\t() => buildGanttRows(selectedDetails?.events || [], detailedSummary),
\t\t[selectedDetails, detailedSummary]
\t)`;

content = content.slice(0, oldFlowRows) + newGantt + content.slice(oldFlowTimelineEnd);

// ── Fix render site: replace flowTimeline.rows with flowTimeline.rows, remove flowRows.length check
const oldRenderCheck = content.indexOf("flowRows.length ?");
if (oldRenderCheck !== -1) {
	// Replace flowRows.length with flowTimeline.rows.length
	content = content.replace("flowRows.length ?", "(flowTimeline?.rows?.length) ?");
}

fs.writeFileSync(file, content);
console.log("Done");

// Quick validation
console.log("buildGanttRows defined:", content.includes("function buildGanttRows("));
console.log("flowColumns defined:", content.includes("const flowColumns = ["));
console.log("flowTimeline useMemo:", content.includes("buildGanttRows(selectedDetails?.events"));
