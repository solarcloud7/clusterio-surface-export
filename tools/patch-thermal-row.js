const fs = require("fs");
const file = "docker/seed-data/external_plugins/surface_export/web/utils.js";
let content = fs.readFileSync(file, "utf8");

const EOL = content.includes("\r\n") ? "\r\n" : "\n";

const startMarker = `\t// High-temp with thermal energy: show aggregate row (volume) + thermal detail row (energy)${EOL}`;
const endMarker = `\t\t} else if (group.buckets.length === 1) {`;

const start = content.indexOf(startMarker);
const end = content.indexOf(endMarker);
if (start === -1 || end === -1) {
	console.error("markers not found", { start, end });
	process.exit(1);
}

const newBlock =
	`\t// High-temp with thermal energy: single row — icon+name + "High-temp (V\u00D7T)" label,${EOL}` +
	`\t// showing thermal energy values directly. The volume aggregate row is redundant.${EOL}` +
	`\t\t\tconst expEnergy = aggregate.expectedEnergy;${EOL}` +
	`\t\t\tconst actEnergy = aggregate.actualEnergy;${EOL}` +
	`\t\t\tconst energyDelta = actEnergy - expEnergy;${EOL}` +
	`\t\t\tconst energyPrecision = expEnergy > 0 ? (actEnergy / expEnergy) * 100 : 100;${EOL}` +
	`\t\t\trows.push({${EOL}` +
	`\t\t\t\tkey: \`fluid:thermal:\${group.baseName}\`,${EOL}` +
	`\t\t\t\tname: group.baseName,${EOL}` +
	`\t\t\t\ttempDisplay: "High-temp (V\u00D7T)",${EOL}` +
	`\t\t\t\tcategory,${EOL}` +
	`\t\t\t\texpected: expEnergy,${EOL}` +
	`\t\t\t\tactual: actEnergy,${EOL}` +
	`\t\t\t\tdelta: energyDelta,${EOL}` +
	`\t\t\t\tpreservedPct: energyPrecision,${EOL}` +
	`\t\t\t\tisGroup: true,${EOL}` +
	`\t\t\t\tisThermalSummary: true,${EOL}` +
	`\t\t\t\tstatus: energyPrecision >= 99.0 ? "Thermal match" : "Thermal drift",${EOL}` +
	`\t\t\t\treconciled: true,${EOL}` +
	`\t\t\t});${EOL}` +
	`\t\t} else if (group.buckets.length === 1) {`;

content = content.slice(0, start) + newBlock + content.slice(end + endMarker.length);
fs.writeFileSync(file, content);
console.log("Done");
