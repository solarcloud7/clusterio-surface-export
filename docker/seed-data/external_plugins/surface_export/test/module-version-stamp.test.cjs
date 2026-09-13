"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const pluginRoot = path.join(__dirname, "..");

test("version stamp agrees across package.json, module.json, and version.lua", async () => {
	const { pathToFileURL } = require("node:url");
	const { releaseChannel } = await import(pathToFileURL(path.resolve(pluginRoot, "../../../../tools/release/verify-package.mjs")));
	const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
	const mod = JSON.parse(fs.readFileSync(path.join(pluginRoot, "module", "module.json"), "utf8"));
	const stamp = fs.readFileSync(path.join(pluginRoot, "module", "version.lua"), "utf8");
	releaseChannel(pkg.version);

	assert.equal(mod.version, pkg.version,
		"module.json version drifted from package.json — only the bump scripts may write these");
	assert.equal(stamp.trim(), `return "${pkg.version}"`,
		"module/version.lua stamp drifted from package.json — only Update-ModuleVersionStamp may write it");
});
