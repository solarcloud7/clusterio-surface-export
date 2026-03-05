const fs = require("fs");
const file = "docker/seed-data/external_plugins/surface_export/web/utils.js";
let content = fs.readFileSync(file, "utf8");

// Fix the broken key line: "key: ," → correct template literal
const broken = "\t\t\t\tkey: ,";
const fixed = "\t\t\t\tkey: `fluid:thermal:${group.baseName}`,";

if (!content.includes(broken)) {
	console.error("broken line not found");
	process.exit(1);
}
content = content.replace(broken, fixed);
fs.writeFileSync(file, content);
console.log("Done");
