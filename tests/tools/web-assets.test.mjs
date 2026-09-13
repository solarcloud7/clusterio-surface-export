import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { publishWebAssets } from "../../docker/seed-data/external_plugins/surface_export/scripts/web-assets.mjs";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "surface-web-assets-"));
	t.after(async () => {
		assert.equal(dirname(root), resolve(tmpdir()));
		await rm(root, { recursive: true, force: true });
	});
	const staging = join(root, "candidate"), destination = join(root, "published");
	for (const directory of [staging, destination]) await mkdir(join(directory, "static"), { recursive: true });
	await writeFile(join(destination, "static/old.11111111.js"), "old bytes");
	await writeFile(join(destination, "manifest.json"), JSON.stringify({ "surface_export.js": "static/old.11111111.js" }));
	const oldManifest = await readFile(join(destination, "manifest.json"), "utf8");
	return { staging, destination, oldManifest };
}

test("publishing preserves cached assets and advertises a fully emitted candidate", async t => {
	const { staging, destination } = await fixture(t);
	await writeFile(join(staging, "static/new.22222222.js"), "new bytes");
	const next = { "surface_export.js": "static/new.22222222.js" };
	await writeFile(join(staging, "manifest.json"), JSON.stringify(next));
	assert.deepEqual(await publishWebAssets(staging, destination), next);
	assert.equal(await readFile(join(destination, "static/old.11111111.js"), "utf8"), "old bytes");
	assert.equal(await readFile(join(destination, next["surface_export.js"]), "utf8"), "new bytes");
	assert.deepEqual(JSON.parse(await readFile(join(destination, "manifest.json"), "utf8")), next);
	assert.deepEqual((await readdir(destination)).sort(), ["manifest.json", "static"]);
});

for (const kind of ["missing", "collision", "unsafe path", "unhashed", "missing entry"]) {
	test(`a ${kind} candidate leaves the published manifest and assets intact`, async t => {
		const { staging, destination, oldManifest } = await fixture(t);
		let asset = "static/new.22222222.js";
		if (kind === "collision") asset = "static/old.11111111.js";
		if (kind === "unsafe path") asset = "static/../outside.22222222.js";
		if (kind === "unhashed") asset = "static/new.js";
		if (kind !== "missing") await writeFile(join(staging, asset), "changed bytes");
		await writeFile(join(staging, "manifest.json"), JSON.stringify(kind === "missing entry" ? {} : { "surface_export.js": asset }));
		await assert.rejects(publishWebAssets(staging, destination));
		assert.equal(await readFile(join(destination, "manifest.json"), "utf8"), oldManifest);
		assert.equal(await readFile(join(destination, "static/old.11111111.js"), "utf8"), "old bytes");
	});
}

test("publication retains the current and preceding manifest assets only", async t => {
	const { staging, destination } = await fixture(t);
	await writeFile(join(staging, "static/new.22222222.js"), "new bytes");
	await writeFile(join(staging, "manifest.json"), JSON.stringify({ "surface_export.js": "static/new.22222222.js" }));
	await publishWebAssets(staging, destination);
	await rm(join(staging, "static/new.22222222.js"));
	await writeFile(join(staging, "static/third.33333333.js"), "third bytes");
	await writeFile(join(staging, "manifest.json"), JSON.stringify({ "surface_export.js": "static/third.33333333.js" }));
	await publishWebAssets(staging, destination);
	assert.deepEqual((await readdir(join(destination, "static"))).sort(), ["new.22222222.js", "third.33333333.js"]);
});
