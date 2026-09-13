import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export function stagePackage(source, destination) {
	source = resolve(source); destination = resolve(destination);
	assert.ok(!destination.startsWith(source + sep) && destination !== source, "package stage must be outside its source");
	assert.ok(!existsSync(destination), "package stage must be new");
	const manifest = JSON.parse(readFileSync(resolve(source, "dist/web/manifest.json"), "utf8"));
	assert.equal(typeof manifest?.["surface_export.js"], "string", "web entry missing");
	const assets = new Set(Object.values(manifest));
	for (const name of assets) {
		assert.match(name, /^static\/[A-Za-z0-9_./-]+$/);
		assert.ok(!name.split("/").some(part => part === "." || part === ".."), "unsafe web asset");
		assert.ok(lstatSync(resolve(source, "dist/web", name)).isFile(), `missing web asset: ${name}`);
	}
	cpSync(source, destination, { recursive: true, filter(path) {
		const name = relative(source, path).split(sep).join("/");
		if (name.split("/").includes("node_modules")) return false;
		if (!name.startsWith("dist/web/")) return true;
		const asset = name.slice("dist/web/".length);
		return asset === "manifest.json" || asset === ".prepare-build-stamp" || assets.has(asset)
			|| [...assets].some(file => file.startsWith(asset + "/"));
	} });
}
