const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const configure = require("../webpack.config.js");
const webpack = require("webpack");

async function compileDirect(config) {
	const compiler = webpack(config);
	try {
		return await new Promise((resolve, reject) => compiler.run((error, stats) => {
			if (error || stats.hasErrors()) reject(error || new Error(stats.toString()));
			else resolve(stats);
		}));
	} finally {
		await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
	}
}

test("real composed webpack builds cannot clean published assets, including on compilation failure", async t => {
	const { buildWeb } = await import("../scripts/build-web.mjs");
	const root = await fs.mkdtemp(path.join(tmpdir(), "surface-webpack-"));
	t.after(async () => {
		assert.equal(path.dirname(root), path.resolve(tmpdir()));
		await fs.rm(root, { recursive: true, force: true });
	});
	const entry = path.join(root, "entry.js"), destination = path.join(root, "published");
	const inherited = configure({}, { mode: "production" });
	const config = { ...inherited, context: root, cache: false, entry: { surface_export: entry },
		module: { rules: [] }, optimization: { minimize: false },
		plugins: inherited.plugins.filter(plugin => plugin.constructor.name !== "ModuleFederationPlugin") };
	const baseline = path.join(root, "direct-build");
	await fs.mkdir(path.join(baseline, "static"), { recursive: true });
	const cachedAsset = path.join(baseline, "static/cached.11111111.js");
	await fs.writeFile(cachedAsset, "cached client still needs this");
	await fs.writeFile(entry, 'console.log("baseline");');
	await compileDirect({ ...config, output: { ...config.output, path: baseline } });
	await assert.rejects(fs.readFile(cachedAsset), { code: "ENOENT" });
	await fs.writeFile(entry, 'console.log("first");');
	const first = await buildWeb({ config, destination });
	const firstPath = path.join(destination, first["surface_export.js"]);
	const firstBytes = await fs.readFile(firstPath);
	await fs.writeFile(entry, 'console.log("second");');
	const second = await buildWeb({ config, destination });
	assert.notEqual(second["surface_export.js"], first["surface_export.js"]);
	assert.deepEqual(await fs.readFile(firstPath), firstBytes);
	assert.ok((await fs.readFile(path.join(destination, second["surface_export.js"]), "utf8")).includes("second"));
	const manifest = await fs.readFile(path.join(destination, "manifest.json"));
	await fs.writeFile(entry, "invalid javascript {{{");
	await assert.rejects(buildWeb({ config, destination }), /ERROR/);
	assert.deepEqual(await fs.readFile(path.join(destination, "manifest.json")), manifest);
	assert.deepEqual(await fs.readFile(firstPath), firstBytes);
});
