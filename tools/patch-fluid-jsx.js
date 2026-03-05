const fs = require("fs");

const file = "docker/seed-data/external_plugins/surface_export/web/TransactionLogsTab.jsx";
let content = fs.readFileSync(file, "utf8");

// Find the render block start
const start = content.indexOf("\t\trender: (_, row) => (\n\t\t\t\trow.isGroup");
if (start === -1) { console.error("start not found"); process.exit(1); }

// Find the end: scan for matching paren depth
let i = start + 20;
let depth = 0;
let foundOpen = false;
while (i < content.length) {
	if (content[i] === "(") { depth++; foundOpen = true; }
	else if (content[i] === ")") { depth--; if (foundOpen && depth === 0) break; }
	i++;
}
// i is the position of the closing ) of the render call
// The line ends with "),\n\t\t},"  — blockEnd is after "},
const blockEnd = content.indexOf("\n\t\t},", i) + "\n\t\t},".length;

const newBlock = `\t\trender: (_, row) => (
\t\t\t\trow.isGroup
\t\t\t\t\t? (
\t\t\t\t\t\t<Space size={6} align="center">
\t\t\t\t\t\t\t<div style={{ width: 20, height: 20, overflow: "hidden", flexShrink: 0, display: "inline-flex", alignItems: "flex-start", justifyContent: "flex-start" }}>
\t\t\t\t\t\t\t\t<div className={\`item-\${CSS.escape(row.name)}\`} title={row.name} style={{ imageRendering: "pixelated", transform: "scale(0.625)", transformOrigin: "top left" }} />
\t\t\t\t\t\t\t</div>
\t\t\t\t\t\t\t<Text code>{row.name}</Text>
\t\t\t\t\t\t\t{row.tempDisplay && <Text type="secondary" style={{ fontSize: 12 }}>{row.tempDisplay}</Text>}
\t\t\t\t\t\t</Space>
\t\t\t\t\t)
\t\t\t\t\t: row.isThermalSummary
\t\t\t\t\t\t? (
\t\t\t\t\t\t\t<Tooltip title="Total thermal energy: Volume \u00D7 Temperature">
\t\t\t\t\t\t\t\t<Text type="secondary" style={{ paddingLeft: 28 }}>Thermal (V\u00D7T)</Text>
\t\t\t\t\t\t\t</Tooltip>
\t\t\t\t\t\t)
\t\t\t\t\t\t: (
\t\t\t\t\t\t\t<Text type="secondary" style={{ paddingLeft: 28 }}>{row.tempDisplay ?? row.name}</Text>
\t\t\t\t\t\t)
\t\t\t),
\t\t},`;

content = content.slice(0, start) + newBlock + content.slice(blockEnd);
fs.writeFileSync(file, content);
console.log("fluidColumns render updated, block replaced at", start, "-", blockEnd);
