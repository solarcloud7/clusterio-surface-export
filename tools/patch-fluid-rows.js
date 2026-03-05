const fs = require("fs");

// ── utils.js: rewrite buildFluidInventoryRows to produce flat rows ──────────
{
	const file = "docker/seed-data/external_plugins/surface_export/web/utils.js";
	const content = fs.readFileSync(file, "utf8");

	const start = content.indexOf("export function buildFluidInventoryRows");
	const end = content.indexOf("\nexport function findLatestEvent", start);
	if (start === -1 || end === -1) {
		console.error("Could not find buildFluidInventoryRows bounds in utils.js");
		process.exit(1);
	}

	const newFn = `export function buildFluidInventoryRows(expectedMap, actualMap, highTempThreshold = 10000, highTempAggregates = {}) {
\tconst expected = expectedMap || {};
\tconst actual = actualMap || {};
\tconst aggregates = highTempAggregates || {};
\tconst threshold = Number.isFinite(Number(highTempThreshold)) ? Number(highTempThreshold) : 10000;
\tconst keys = new Set([ ...Object.keys(expected), ...Object.keys(actual) ]);
\tconst groups = new Map();

\tfor (const fluidKey of keys) {
\t\tconst expectedValue = Number(expected[fluidKey] || 0);
\t\tconst actualValue = Number(actual[fluidKey] || 0);
\t\tconst delta = actualValue - expectedValue;
\t\tconst parsed = parseFluidTemperatureKey(fluidKey);
\t\tconst isHighTemp = parsed.temperatureC !== null && parsed.temperatureC >= threshold;
\t\tconst baseName = parsed.baseName || fluidKey;

\t\tif (!groups.has(baseName)) {
\t\t\tgroups.set(baseName, {
\t\t\t\tbaseName,
\t\t\t\texpected: 0,
\t\t\t\tactual: 0,
\t\t\t\thasHighTempBucket: false,
\t\t\t\tbuckets: [],
\t\t\t});
\t\t}

\t\tconst group = groups.get(baseName);
\t\tgroup.expected += expectedValue;
\t\tgroup.actual += actualValue;
\t\tgroup.hasHighTempBucket = group.hasHighTempBucket || isHighTemp;
\t\tgroup.buckets.push({
\t\t\tfluidKey,
\t\t\ttempBucket: parsed.temperatureC === null ? null : \`\${formatNumeric(parsed.temperatureC, 1)}\u00B0C\`,
\t\t\tcategory: isHighTemp ? "High-temp" : "Normal",
\t\t\texpected: expectedValue,
\t\t\tactual: actualValue,
\t\t\tdelta,
\t\t\tpreservedPct: expectedValue > 0 ? (actualValue / expectedValue) * 100 : null,
\t\t});
\t}

\tconst rows = [];
\tfor (const group of groups.values()) {
\t\tconst delta = group.actual - group.expected;
\t\tconst category = group.hasHighTempBucket ? "High-temp" : "Normal";
\t\tconst aggregate = aggregates[group.baseName];
\t\tconst reconciledHighTemp = category === "High-temp"
\t\t\t? Boolean(aggregate?.reconciled ?? Math.abs(delta) <= 1)
\t\t\t: false;
\t\tconst hasThermalData = aggregate && aggregate.expectedEnergy > 0;

\t\tif (category === "High-temp" && reconciledHighTemp && hasThermalData) {
\t\t\t// High-temp with thermal energy: show aggregate row (volume) + thermal detail row (energy)
\t\t\tconst expEnergy = aggregate.expectedEnergy;
\t\t\tconst actEnergy = aggregate.actualEnergy;
\t\t\tconst energyDelta = actEnergy - expEnergy;
\t\t\tconst energyPrecision = expEnergy > 0 ? (actEnergy / expEnergy) * 100 : 100;
\t\t\t// Aggregate (volume) row — shows fluid icon + name + "Verified (thermal)" status
\t\t\trows.push({
\t\t\t\tkey: \`fluid:group:\${group.baseName}\`,
\t\t\t\tname: group.baseName,
\t\t\t\ttempDisplay: null,
\t\t\t\tcategory,
\t\t\t\texpected: group.expected,
\t\t\t\tactual: group.actual,
\t\t\t\tdelta,
\t\t\t\tpreservedPct: group.expected > 0 ? (group.actual / group.expected) * 100 : null,
\t\t\t\tisGroup: true,
\t\t\t\tstatus: "Verified (thermal)",
\t\t\t\treconciled: true,
\t\t\t});
\t\t\t// Thermal energy child row — indented, no icon
\t\t\trows.push({
\t\t\t\tkey: \`fluid:thermal:\${group.baseName}\`,
\t\t\t\tname: group.baseName,
\t\t\t\ttempDisplay: "Thermal (V\u00D7T)",
\t\t\t\tcategory,
\t\t\t\texpected: expEnergy,
\t\t\t\tactual: actEnergy,
\t\t\t\tdelta: energyDelta,
\t\t\t\tpreservedPct: energyPrecision,
\t\t\t\tisGroup: false,
\t\t\t\tisThermalSummary: true,
\t\t\t\tstatus: energyPrecision >= 99.0 ? "Thermal match" : "Thermal drift",
\t\t\t\treconciled: true,
\t\t\t});
\t\t} else if (group.buckets.length === 1) {
\t\t\t// Single bucket — flat row: icon + name + temperature inline
\t\t\tconst bucket = group.buckets[0];
\t\t\tconst absDelta = Math.abs(bucket.delta);
\t\t\tlet status;
\t\t\tif (category === "High-temp" && reconciledHighTemp) {
\t\t\t\tstatus = absDelta > 0.0001 ? "Bucket drift (reconciled)" : "Match";
\t\t\t} else {
\t\t\t\tstatus = absDelta > 0.0001 ? "Mismatch" : "Match";
\t\t\t}
\t\t\trows.push({
\t\t\t\tkey: \`fluid:bucket:\${bucket.fluidKey}\`,
\t\t\t\tname: group.baseName,
\t\t\t\ttempDisplay: bucket.tempBucket,
\t\t\t\tcategory,
\t\t\t\texpected: bucket.expected,
\t\t\t\tactual: bucket.actual,
\t\t\t\tdelta: bucket.delta,
\t\t\t\tpreservedPct: bucket.preservedPct,
\t\t\t\tisGroup: true,
\t\t\t\tstatus,
\t\t\t\treconciled: category === "High-temp" ? reconciledHighTemp : absDelta <= 0.0001,
\t\t\t});
\t\t} else {
\t\t\t// Multiple normal-temp buckets — aggregate row + per-bucket rows
\t\t\tconst groupStatus = Math.abs(delta) <= 0.0001 ? "Match" : "Mismatch";
\t\t\trows.push({
\t\t\t\tkey: \`fluid:group:\${group.baseName}\`,
\t\t\t\tname: group.baseName,
\t\t\t\ttempDisplay: null,
\t\t\t\tcategory,
\t\t\t\texpected: group.expected,
\t\t\t\tactual: group.actual,
\t\t\t\tdelta,
\t\t\t\tpreservedPct: group.expected > 0 ? (group.actual / group.expected) * 100 : null,
\t\t\t\tisGroup: true,
\t\t\t\tstatus: groupStatus,
\t\t\t\treconciled: Math.abs(delta) <= 0.0001,
\t\t\t});
\t\t\tconst sortedBuckets = [...group.buckets]
\t\t\t\t.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.fluidKey.localeCompare(b.fluidKey));
\t\t\tfor (const bucket of sortedBuckets) {
\t\t\t\tconst absDelta = Math.abs(bucket.delta);
\t\t\t\trows.push({
\t\t\t\t\tkey: \`fluid:bucket:\${bucket.fluidKey}\`,
\t\t\t\t\tname: group.baseName,
\t\t\t\t\ttempDisplay: bucket.tempBucket,
\t\t\t\t\tcategory,
\t\t\t\t\texpected: bucket.expected,
\t\t\t\t\tactual: bucket.actual,
\t\t\t\t\tdelta: bucket.delta,
\t\t\t\t\tpreservedPct: bucket.preservedPct,
\t\t\t\t\tisGroup: false,
\t\t\t\t\tstatus: absDelta > 0.0001 ? "Mismatch" : "Match",
\t\t\t\t\treconciled: absDelta <= 0.0001,
\t\t\t\t});
\t\t\t}
\t\t}
\t}

\trows.sort((a, b) => {
\t\t// Keep thermal child rows immediately after their group row
\t\tif (a.isThermalSummary || (!a.isGroup && !a.isThermalSummary)) return 0;
\t\treturn Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name);
\t});
\t// Stable sort: group rows first by delta, then thermal/bucket rows follow their group
\tconst grouped = [];
\tconst seen = new Set();
\tconst allGroupKeys = rows.filter(r => r.isGroup).map(r => r.name);
\tfor (const groupRow of rows.filter(r => r.isGroup).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name))) {
\t\tif (seen.has(groupRow.name)) continue;
\t\tseen.add(groupRow.name);
\t\tgrouped.push(groupRow);
\t\tfor (const child of rows.filter(r => !r.isGroup && r.name === groupRow.name)) {
\t\t\tgrouped.push(child);
\t\t}
\t}
\treturn grouped;
}
`;

	const newContent = content.slice(0, start) + newFn + content.slice(end);
	fs.writeFileSync(file, newContent);
	console.log("utils.js updated");
}
