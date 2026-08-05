"use strict";

/**
 * Controller export-storage eviction and durability.
 *
 * Both properties below were completely uncovered before this file: nothing exercised
 * `cleanupOldExports` or `max_storage_size`, and the only assertion on `persistStorage` anywhere was
 * the refusal path in `persistence-read-failure.test.cjs`. So "the cap works" and "what we write is
 * what we can read back" were beliefs, not tests.
 *
 * The write-count assertion is the regression guard for the ENOENT race: `cleanupOldExports` used to
 * fire an unawaited `persistStorage()` while its only caller awaited another one on the next line,
 * which collided on safeOutputFile's shared temp path once per export.
 */

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
			// Counts AND writes: the round-trip test needs real bytes on disk, the eviction test
			// needs to know whether a write happened at all.
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

/** Canonical `instanceId:sourceExportId` keys, so loadStorage's legacy migration path stays out of it. */
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
			timestamp: 1000 + i, // ascending: higher = newer
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
	// The regression guard. Restoring the fire-and-forget persistStorage() inside cleanupOldExports
	// makes writeCount 1 here and re-opens the shared-temp-path race with the caller's own await.
	const plugin = makePlugin();
	seed(plugin, 5);
	writeCount = 0;

	plugin.cleanupOldExports(3);
	// Let any unawaited promise the method might have started reach its write.
	await new Promise(resolve => setImmediate(resolve));

	assert.equal(writeCount, 0, "cleanupOldExports must not persist; handlePlatformExport does it next");
});

test("what persistStorage writes is what loadStorage reads back", async () => {
	// The round-trip nobody was asserting. A layout change that broke read/write agreement would
	// previously have been caught only by a live cluster losing its exports across a restart.
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
	// Before the counter, a controller that had stopped persisting entirely logged the same single
	// line per export forever and looked exactly like one that hiccuped once.
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
