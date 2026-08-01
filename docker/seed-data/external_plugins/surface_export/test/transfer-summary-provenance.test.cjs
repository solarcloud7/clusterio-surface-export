"use strict";

// getTransferSummaries merges TWO stores that are NOT equivalent, and the difference decides whether
// a caller's transfer will actually be refused:
//
//   activeTransfers            in-memory. The ONLY store transferPlatform's retry guard consults
//                              (transfer-orchestrator.ts:89-118). CLEARED by a controller restart.
//   persistedTransactionLogs   on-disk. RELOADED at every controller boot. The guard never reads it.
//
// So the merged view is a strict superset of what would be refused, and the advertised remedy for a
// colliding ID — restart the controller — clears the half that refuses and reloads the half that
// does not. Before `registrySource`, both branches emitted identical key sets: a preflight built on
// this query would report a collision, watch the operator correctly restart, and then report the
// same collision forever. These tests pin the discriminator that makes the two distinguishable.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Module = require("node:module");
const originalLoad = Module._load;
class NoopMetric {
	labels() { return this; }
	inc() {}
	observe() {}
}
Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			escapeString: (value) => String(value),
			safeOutputFile: async (file, data) => fs.writeFileSync(file, data),
			wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			Counter: NoopMetric,
			Histogram: NoopMetric,
		};
	}
	if (request === "@clusterio/controller") {
		return { BaseControllerPlugin: class {} };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const distNode = path.join(__dirname, "..", "dist", "node");
const { TransactionLogger } = require(path.join(distNode, "lib", "transaction-logger.js"));

const ACTIVE_ID = "2:001_alpha";
const PERSISTED_ID = "2:002_beta";
const BOTH_ID = "2:003_gamma";

function makeLogger({ active = [], persisted = [] } = {}) {
	const plugin = {
		activeTransfers: new Map(active.map(entry => [entry.transferId, {
			platformName: entry.platformName || "pad",
			sourceInstanceId: 2,
			targetInstanceId: 1,
			status: entry.status || "completed",
			startedAt: entry.startedAt || 1_000,
			exportId: null,
		}])),
		persistedTransactionLogs: persisted.map(entry => ({
			transferId: entry.transferId,
			savedAt: entry.startedAt || 2_000,
			events: [],
			transferInfo: {
				platformName: entry.platformName || "pad",
				operationType: "transfer",
				sourceInstanceId: 2,
				targetInstanceId: 1,
				status: entry.status || "completed",
				startedAt: entry.startedAt || 2_000,
			},
		})),
		platformStorage: new Map(),
		transactionLogs: new Map(),
		// buildTransferInfo resolves display names through the platform tree for any transfer whose
		// own *InstanceName is unset (transaction-logger.ts:28,30).
		platformTree: { resolveInstanceName: (id) => `instance-${id}` },
		logger: { info() {}, error() {}, warn() {} },
	};
	return new TransactionLogger(plugin);
}

const byId = (summaries) => new Map(summaries.map(s => [s.transferId, s]));

test("an in-memory transfer is stamped registrySource 'active'", () => {
	const summaries = makeLogger({ active: [{ transferId: ACTIVE_ID }] }).getTransferSummaries();
	assert.equal(byId(summaries).get(ACTIVE_ID).registrySource, "active",
		"an activeTransfers entry WILL refuse a same-ID retry — a caller must be able to see that");
});

test("a persisted-only transfer is stamped registrySource 'persisted'", () => {
	const summaries = makeLogger({ persisted: [{ transferId: PERSISTED_ID }] }).getTransferSummaries();
	assert.equal(byId(summaries).get(PERSISTED_ID).registrySource, "persisted",
		"the retry guard never reads the persisted log, so this ID is history, not a blocker — and a "
		+ "controller restart would NOT remove it");
});

test("an ID in BOTH stores is stamped 'active' — active wins, and that is the answer that matters", () => {
	const logger = makeLogger({
		active: [{ transferId: BOTH_ID, status: "completed" }],
		persisted: [{ transferId: BOTH_ID, status: "completed" }],
	});
	const summaries = logger.getTransferSummaries();
	assert.equal(summaries.filter(s => s.transferId === BOTH_ID).length, 1, "the merge must dedupe");
	assert.equal(byId(summaries).get(BOTH_ID).registrySource, "active",
		"if it is live it will refuse, regardless of also being on disk. Reporting 'persisted' here "
		+ "would tell an operator no action is needed while the run is about to be refused.");
});

test("the two branches are distinguishable in one merged result", () => {
	// The whole point: before this field, these two entries were indistinguishable.
	const logger = makeLogger({
		active: [{ transferId: ACTIVE_ID }],
		persisted: [{ transferId: PERSISTED_ID }],
	});
	const map = byId(logger.getTransferSummaries());
	assert.equal(map.size, 2);
	assert.notEqual(map.get(ACTIVE_ID).registrySource, map.get(PERSISTED_ID).registrySource);
});

test("registrySource does NOT ride on buildTransferSummary", () => {
	// buildTransferSummary also builds the SurfaceExportTransferUpdateEvent payload, where every entry
	// is active by construction. Stamping there would put a constant on the wire and drag the field
	// into the event's schema contract for no information.
	const logger = makeLogger();
	const built = logger.buildTransferSummary("2:004_delta", {
		platformName: "pad", sourceInstanceId: 2, targetInstanceId: 1,
		status: "completed", startedAt: 1_000, exportId: null,
	}, null);
	assert.equal(built.registrySource, undefined,
		"the stamp belongs to the merge, not to the per-transfer builder");
});
