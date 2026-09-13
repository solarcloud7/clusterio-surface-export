import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stagePackage } from "../../tools/release/stage-package.mjs";

test("release stage excludes accumulated assets while leaving live cached files intact", t => {
	const root = mkdtempSync(join(tmpdir(), "package-stage-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "source"), output = join(root, "stage");
	mkdirSync(join(source, "dist/web/static"), { recursive: true });
	for (const file of ["current.12345678.js", "current.12345678.js.map", "old.87654321.js"])
		writeFileSync(join(source, "dist/web/static", file), file);
	writeFileSync(join(source, "dist/web/manifest.json"), JSON.stringify({
		"surface_export.js": "static/current.12345678.js", "surface_export.js.map": "static/current.12345678.js.map",
	}));
	mkdirSync(join(source, "node_modules"));
	stagePackage(source, output);
	assert.deepEqual(readdirSync(join(output, "dist/web/static")).sort(), ["current.12345678.js", "current.12345678.js.map"]);
	assert.equal(existsSync(join(output, "node_modules")), false);
	assert.equal(existsSync(join(source, "dist/web/static/old.87654321.js")), true);
	assert.throws(() => stagePackage(source, output), /must be new/);
	writeFileSync(join(source, "dist/web/manifest.json"), JSON.stringify({ "surface_export.js": "static/../escape.js" }));
	assert.throws(() => stagePackage(source, join(root, "invalid")), /unsafe web asset/);
});
