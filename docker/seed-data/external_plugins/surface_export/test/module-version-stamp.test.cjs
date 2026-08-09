"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.join(__dirname, "..");

test("version stamp agrees across package.json, module.json, and version.lua", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
	const mod = JSON.parse(fs.readFileSync(path.join(pluginRoot, "module", "module.json"), "utf8"));
	const stamp = fs.readFileSync(path.join(pluginRoot, "module", "version.lua"), "utf8");

	const match = stamp.match(/^return "(\d+\.\d+\.\d+)"\s*$/m);
	assert.ok(match, "module/version.lua must contain a line of the form: return \"X.Y.Z\"");

	assert.equal(mod.version, pkg.version,
		"module.json version drifted from package.json — only the bump scripts may write these");
	assert.equal(match[1], pkg.version,
		"module/version.lua stamp drifted from package.json — only Update-ModuleVersionStamp may write it");
});
