"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let writeCount = 0;

const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			escapeString: (value) => String(value),
			safeOutputFile: async (file, data) => { writeCount += 1; fs.writeFileSync(file, data); },
			wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			Counter: class {},
			Histogram: class {},
		};
	}
	if (request === "@clusterio/controller") {
		return { BaseControllerPlugin: class {} };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const distNode = path.join(__dirname, "..", "dist", "node");
const { ControllerPlugin } = require(path.join(distNode, "controller.js"));

function makePlugin() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "surface-export-evict-"));
	const plugin = Object.create(ControllerPlugin.prototype);
	plugin.storagePath = path.join(dir, "surface_export_storage.json");
	plugin.storageLoadError = null;
	plugin.consecutiveStorageWriteFailures = 0;
	plugin.platformStorage = new Map();
	plugin.logger = { error() {}, info() {}, verbose() {}, warn() {} };
	plugin.subscriptions = { queueTreeBroadcast() {} };
	return plugin;
}

function seed(plugin, count) {
	for (let i = 1; i <= count; i += 1) {
		const exportId = `1:${String(i).padStart(3, "0")}`;
		plugin.platformStorage.set(exportId, {
			exportId,
			sourceExportId: String(i).padStart(3, "0"),
			platformName: `platform-${i}`,
			platformIndex: i,
			instanceId: 1,
			exportData: { payload: `body-${i}` },
			exportMetrics: null,
			timestamp: 1000 + i,
			size: 10,
		});
	}
}

test("eviction drops the OLDEST exports and keeps the cap exactly", () => {
	const plugin = makePlugin();
	seed(plugin, 5);

	plugin.cleanupOldExports(3);

	assert.equal(plugin.platformStorage.size, 3);
	assert.deepEqual([...plugin.platformStorage.keys()].sort(), ["1:003", "1:004", "1:005"]);
	assert.ok(!plugin.platformStorage.has("1:001"), "oldest by timestamp must go first");
	assert.ok(!plugin.platformStorage.has("1:002"));
});

test("eviction is a no-op when the store is at or under the cap", () => {
	const plugin = makePlugin();
	seed(plugin, 3);

	plugin.cleanupOldExports(3);
	assert.equal(plugin.platformStorage.size, 3);

	plugin.cleanupOldExports(10);
	assert.equal(plugin.platformStorage.size, 3);
});

test("eviction does NOT write — its caller owns the persist", async () => {
	const plugin = makePlugin();
	seed(plugin, 5);
	writeCount = 0;

	plugin.cleanupOldExports(3);
	await new Promise(resolve => setImmediate(resolve));

	assert.equal(writeCount, 0, "cleanupOldExports must not persist; handlePlatformExport does it next");
});

test("what persistStorage writes is what loadStorage reads back", async () => {
	const plugin = makePlugin();
	seed(plugin, 2);

	await plugin.persistStorage();

	const reloaded = Object.create(ControllerPlugin.prototype);
	reloaded.storagePath = plugin.storagePath;
	reloaded.storageLoadError = null;
	reloaded.platformStorage = new Map();
	reloaded.logger = { error() {}, info() {}, verbose() {}, warn() {} };

	await reloaded.loadStorage();

	assert.equal(reloaded.storageLoadError, null, "a file we just wrote must load cleanly");
	assert.deepEqual([...reloaded.platformStorage.keys()].sort(), ["1:001", "1:002"]);
	assert.deepEqual(
		reloaded.platformStorage.get("1:002").exportData,
		{ payload: "body-2" },
		"the payload must survive the round trip, not just the key",
	);
});

test("a repeated write failure escalates instead of repeating one identical line", async () => {
	const plugin = makePlugin();
	seed(plugin, 1);
	const errors = [];
	plugin.logger = { error: (m) => errors.push(m), info() {}, verbose() {}, warn() {} };
	plugin.storagePath = path.join(plugin.storagePath, "not-a-directory", "nope.json");

	await plugin.persistStorage();
	await plugin.persistStorage();
	await plugin.persistStorage();

	assert.equal(errors.length, 3);
	assert.doesNotMatch(errors[0], /in a row/, "the first failure must not cry wolf");
	assert.match(errors[1], /failure #2 in a row/);
	assert.match(errors[2], /failure #3 in a row/);
	assert.match(errors[2], /will survive a controller restart/);
});
