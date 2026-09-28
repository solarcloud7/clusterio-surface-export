"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyPlatform, mintedLineage, needsVerdict } = require("../dist/node/lib/lineage-classifier");
const { LineageRegistry } = require("../dist/node/lib/lineage-registry");
const { ControllerPlugin } = require("../dist/node/controller");
const messages = require("../dist/node/messages");

const I = 1, J = 2, EPOCH = "boot-now", L = "lineage:boot-old:15";
const context = (overrides = {}) => ({ instanceId: I, epoch: EPOCH, mode: "plugin_history", allowAdoption: false, ...overrides });
const facts = (overrides = {}) => ({ platformIndex: 3, platformUid: "boot-old:15", hadIdentity: true, lineage: L, generation: 0,
	hubUnitNumber: 15, surfaceIndex: 8, platformName: "ship", forceName: "player", lockKind: "startup", jobOwns: false,
	journalUidMatch: false, journalHubMatch: false, protected: false, ...overrides });
const hints = (overrides = {}) => ({ inTransit: false, historyMatch: false, duplicateLocal: false, ...overrides });
const entry = (overrides = {}) => ({ instanceId: I, generation: 0, platformName: "ship", forceName: "player", lastExportId: null,
	updatedAt: 1, source: "claim", ...overrides });
const verdictOf = (...args) => classifyPlatform(...args).verdict;

test("platforms that keep an existing lock or hold get no classification", () => {
	for (const lockKind of [null, "transfer", "export", "quarantine"]) {
		assert.equal(needsVerdict(facts({ lockKind })), false, String(lockKind));
		assert.equal(verdictOf(facts({ lockKind }), hints(), undefined, undefined, context()), "unchanged");
	}
	assert.equal(needsVerdict(facts({ lockKind: "transfer", journalUidMatch: true })), true, "a retired copy still gets a verdict");
});

test("a platform without lineage is minted silently unless a hint says it may be a retired copy", () => {
	const legacy = facts({ lineage: null, generation: null, hadIdentity: false });
	const minted = classifyPlatform(legacy, hints(), undefined, undefined, context());
	assert.deepEqual([minted.verdict, minted.lineage, minted.generation, minted.mint, minted.claim],
		["normal", mintedLineage(EPOCH, 15), 0, true, true]);
	assert.equal(verdictOf(facts({ lineage: null, generation: null }), hints(), undefined, undefined, context()), "normal");
	assert.equal(verdictOf({ ...legacy, journalHubMatch: true }, hints(), undefined, undefined, context()), "legacy_unclassified",
		"a legacy platform whose hub matches a retired record was released");
	assert.equal(verdictOf(facts({ lineage: null, generation: null, journalHubMatch: true }), hints(), undefined, undefined, context()), "normal",
		"an identified platform was quarantined by a coincidental hub number");
	assert.equal(verdictOf(facts({ lineage: null, generation: null }), hints({ historyMatch: true }), undefined, undefined, context()), "legacy_unclassified");
	assert.equal(verdictOf(facts({ lineage: null, generation: null, journalUidMatch: true }), hints(), undefined, undefined, context()), "legacy_unclassified");
	assert.equal(verdictOf(facts({ lineage: null, generation: null, protected: true }), hints(), undefined, undefined, context()), "unresolved_handoff");
	const owned = classifyPlatform(facts({ lineage: null, generation: null, jobOwns: true }), hints(), undefined, undefined, context());
	assert.equal(owned.verdict, "normal");
	assert.equal(owned.mint, undefined, "a platform owned by a Lua job was given a lineage");
	assert.equal(verdictOf(facts({ platformUid: null, hubUnitNumber: null, lineage: null, generation: null }), hints(), undefined, undefined, context()), "no_identity");
});

test("the registry decides a lineage-bearing copy", () => {
	const claim = classifyPlatform(facts(), hints(), undefined, undefined, context());
	assert.equal(claim.verdict, "normal");
	assert.equal(claim.claim, true);
	assert.equal(verdictOf(facts({ generation: 1 }), hints(), undefined, undefined, context()), "unregistered");
	assert.equal(verdictOf(facts({ generation: 2 }), hints(), entry({ generation: 2 }), undefined, context()), "normal");
	assert.equal(classifyPlatform(facts({ generation: 2 }), hints(), entry({ generation: 2 }), undefined, context()).claim, undefined);
	assert.equal(verdictOf(facts({ generation: 1 }), hints(), entry({ generation: 2 }), undefined, context()), "stale_self");
	assert.equal(verdictOf(facts({ generation: 3 }), hints(), entry({ generation: 2 }), undefined, context()), "ahead_of_registry");
	assert.equal(verdictOf(facts({ generation: 3 }), hints(), entry({ instanceId: J, generation: 2 }), undefined, context()), "ahead_of_registry");
	assert.equal(verdictOf(facts(), hints({ duplicateLocal: true }), undefined, undefined, context()), "duplicate_local");
	assert.equal(verdictOf(facts(), hints({ inTransit: true }), entry(), undefined, context()), "in_transit",
		"a copy with an unresolved transfer intent was released");
	assert.equal(verdictOf(facts({ protected: true }), hints(), entry(), undefined, context()), "unresolved_handoff");
	assert.equal(classifyPlatform(facts({ journalUidMatch: true }), hints(), undefined, undefined, context()).claim, undefined,
		"a retired copy was claimed");
});

test("another holder decides by presence; uncertainty is never absence", () => {
	const other = entry({ instanceId: J, generation: 1 });
	const pending = classifyPlatform(facts(), hints(), other, undefined, context());
	assert.deepEqual([pending.verdict, pending.presenceNeeded, pending.holderInstanceId, pending.holderGeneration], ["unverified", J, J, 1]);
	assert.equal(verdictOf(facts(), hints(), other, { state: "unknown", reason: "offline" }, context({ mode: "save_game", allowAdoption: true })), "unverified");
	assert.equal(verdictOf(facts(), hints(), other, { state: "present" }, context({ mode: "save_game", allowAdoption: true })), "duplicate");
	const kept = classifyPlatform(facts(), hints(), other, { state: "absent" }, context());
	assert.deepEqual([kept.verdict, kept.adopt], ["rollback_other", undefined], "plugin_history adopted a rolled-back copy");
	const withheld = classifyPlatform(facts(), hints(), other, { state: "absent" }, context({ mode: "save_game", allowAdoption: false }));
	assert.equal(withheld.adopt, undefined, "unresolved ownership allowed adoption");
	const adopted = classifyPlatform(facts(), hints(), other, { state: "absent" }, context({ mode: "save_game", allowAdoption: true }));
	assert.deepEqual([adopted.verdict, adopted.adopt, adopted.adoptGeneration], ["rollback_other", true, 2]);
	assert.equal(verdictOf(facts(), hints({ inTransit: true }), other, { state: "absent" }, context({ mode: "save_game", allowAdoption: true })), "in_transit");
});

test("restoring an untransferred snapshot is normal; a new epoch mints fresh lineages", () => {
	const snapshot = facts({ generation: 4, platformUid: "boot-old:15" });
	assert.equal(verdictOf(snapshot, hints(), entry({ generation: 4, source: "transfer", lastExportId: "9:x" }), undefined, context()), "normal");
	const reset = classifyPlatform(facts({ lineage: null, generation: null, hadIdentity: false, platformUid: "boot-new:15" }),
		hints(), undefined, undefined, context({ epoch: "seed-reset" }));
	assert.deepEqual([reset.verdict, reset.lineage, reset.claim], ["normal", "lineage:seed-reset:15", true],
		"a freshly reset instance was not treated as a new lineage");
});

function controllerHarness(overrides = {}) {
	const plugin = Object.create(ControllerPlugin.prototype);
	const sends = [];
	const presence = new Map();
	Object.assign(plugin, {
		logger: { info() {}, warn() {}, error() {}, verbose() {} },
		recoveryReservations: new Map([[I, { epoch: EPOCH, mode: "plugin_history", allowAdoption: false, protectedSourceIndexes: [] }]]),
		lineageRegistry: new LineageRegistry(),
		pendingTransfers: new Map(), activeTransfers: new Map(), persistedTransactionLogs: [], auditIndex: new Map(),
		isInstanceOnline: id => id !== 99,
		controller: { sendTo: async (target, message) => {
			sends.push({ target, message });
			const reply = presence.get(target.instanceId);
			if (reply instanceof Error) throw reply;
			return typeof reply === "function" ? reply(message) : reply;
		} },
		...overrides,
	});
	return { plugin, sends, presence };
}

const classify = (plugin, platforms, epoch = EPOCH) =>
	plugin.handleLineageClassifyRequest(new messages.LineageClassifyRequest({ instanceId: I, epoch, platforms }), { id: I });

test("classification needs the caller's own recovery reservation", async () => {
	const { plugin } = controllerHarness();
	await assert.rejects(plugin.handleLineageClassifyRequest(new messages.LineageClassifyRequest({ instanceId: I, epoch: EPOCH, platforms: [] }), { id: J }), /identity mismatch/);
	await assert.rejects(classify(plugin, [], "old-boot"), /session changed/);
	plugin.lineageRegistry.loadError = "registry unreadable";
	await assert.rejects(classify(plugin, []), /registry unreadable/);
});

test("claims persist only for normal verdicts and a lost presence reply quarantines", async () => {
	const { plugin, presence, sends } = controllerHarness();
	await plugin.lineageRegistry.update(draft => {
		draft.set("lineage:boot-old:16", { instanceId: J, generation: 1, platformName: "b", forceName: "player", lastExportId: "2:x", updatedAt: 1, source: "transfer" });
		draft.set("lineage:boot-old:17", { instanceId: 99, generation: 1, platformName: "c", forceName: "player", lastExportId: "2:y", updatedAt: 1, source: "transfer" });
	});
	presence.set(J, new Error("Session Closed"));
	const { verdicts } = await classify(plugin, [
		facts({ platformIndex: 3 }),
		facts({ platformIndex: 4, lineage: "lineage:boot-old:16", hubUnitNumber: 16 }),
		facts({ platformIndex: 5, lineage: "lineage:boot-old:17", hubUnitNumber: 17 }),
		facts({ platformIndex: 6, lineage: null, generation: null, hadIdentity: false, hubUnitNumber: 18, platformUid: "boot-old:18" }),
	]);
	assert.deepEqual(verdicts.map(verdict => verdict.verdict), ["normal", "unverified", "unverified", "normal"]);
	assert.match(verdicts[1].hints.presence, /Session Closed/);
	assert.match(verdicts[2].hints.presence, /offline or reconciling/);
	assert.equal(sends.length, 1, "an offline holder was asked anyway");
	assert.equal(plugin.lineageRegistry.get(L).instanceId, I);
	assert.equal(plugin.lineageRegistry.get(mintedLineage(EPOCH, 18)).generation, 0);
	assert.equal(plugin.lineageRegistry.get("lineage:boot-old:16").instanceId, J, "an unverified copy changed the registry");
});

test("a definite answer from the holder decides duplicate or rollback, and save_game adoption commits a higher generation", async () => {
	for (const [present, mode, allowAdoption, expected, holder, generation] of [
		[true, "save_game", true, "duplicate", J, 1],
		[false, "plugin_history", false, "rollback_other", J, 1],
		[false, "save_game", true, "rollback_other", I, 2],
	]) {
		const { plugin, presence } = controllerHarness();
		plugin.recoveryReservations.set(I, { epoch: EPOCH, mode, allowAdoption, protectedSourceIndexes: [] });
		await plugin.lineageRegistry.update(draft => draft.set(L, { instanceId: J, generation: 1, platformName: "ship", forceName: "player",
			lastExportId: "1:x", updatedAt: 1, source: "transfer" }));
		presence.set(J, message => ({ success: true, lineages: message.lineages.map(lineage => ({ lineage, present })) }));
		const [verdict] = (await classify(plugin, [facts()])).verdicts;
		assert.equal(verdict.verdict, expected);
		const saved = plugin.lineageRegistry.get(L);
		assert.deepEqual([saved.instanceId, saved.generation], [holder, generation]);
		if (expected === "rollback_other" && allowAdoption) assert.deepEqual([verdict.adopt, verdict.adoptGeneration, saved.source], [true, 2, "resolution"]);
	}
});

test("a malformed or partial presence reply is uncertainty", async () => {
	for (const reply of [undefined, { success: false }, { success: true }, { success: true, lineages: [{ lineage: L }] },
		{ success: true, lineages: [{ lineage: "lineage:other:1", present: false }] }]) {
		const { plugin, presence } = controllerHarness();
		plugin.recoveryReservations.set(I, { epoch: EPOCH, mode: "save_game", allowAdoption: true, protectedSourceIndexes: [] });
		await plugin.lineageRegistry.update(draft => draft.set(L, { instanceId: J, generation: 1, platformName: "ship", forceName: "player",
			lastExportId: "1:x", updatedAt: 1, source: "transfer" }));
		presence.set(J, reply);
		const [verdict] = (await classify(plugin, [facts()])).verdicts;
		assert.equal(verdict.verdict, "unverified", JSON.stringify(reply));
		assert.equal(plugin.lineageRegistry.get(L).instanceId, J);
	}
});

test("two instances loading the same generation-zero copy: exactly one claims it", async () => {
	const registry = new LineageRegistry();
	const first = controllerHarness({ lineageRegistry: registry });
	const second = controllerHarness({ lineageRegistry: registry });
	second.plugin.recoveryReservations = new Map([[J, { epoch: "boot-j", mode: "plugin_history", allowAdoption: false, protectedSourceIndexes: [] }]]);
	second.presence.set(I, { success: false, error: "Source recovery is not ready" });
	const [a, b] = await Promise.all([
		classify(first.plugin, [facts()]),
		second.plugin.handleLineageClassifyRequest(new messages.LineageClassifyRequest({ instanceId: J, epoch: "boot-j", platforms: [facts()] }), { id: J }),
	]);
	assert.deepEqual([a.verdicts[0].verdict, b.verdicts[0].verdict], ["normal", "unverified"]);
	assert.equal(registry.get(L).instanceId, I);
});

test("pending intents and completed history are hints the controller owns", async () => {
	const { plugin } = controllerHarness();
	plugin.pendingTransfers.set("1:job", { transferId: "1:job", sourceInstanceId: I, targetInstanceId: J, sourcePlatformIndex: 3,
		sourcePlatformName: "ship", forceName: "player", startedAt: 1, exportId: "1:job", lineage: L, lineageGeneration: 0 });
	plugin.persistedTransactionLogs = [{ transferId: "1:done", transferInfo: { operationType: "transfer", status: "completed",
		sourceInstanceId: I, platformUid: "boot-old:20" } }];
	plugin.auditIndex.set("1:audit", { operationType: "transfer", status: "completed", sourceInstanceId: I, platformUid: "boot-old:21" });
	plugin.auditIndex.set("1:failed", { operationType: "transfer", status: "failed", sourceInstanceId: I, platformUid: "boot-old:22" });
	const { verdicts } = await classify(plugin, [
		facts(),
		facts({ platformIndex: 4, lineage: null, generation: null, platformUid: "boot-old:20", hubUnitNumber: 20 }),
		facts({ platformIndex: 5, lineage: null, generation: null, platformUid: "boot-old:21", hubUnitNumber: 21 }),
		facts({ platformIndex: 6, lineage: null, generation: null, platformUid: "boot-old:22", hubUnitNumber: 22 }),
	]);
	assert.deepEqual(verdicts.map(verdict => verdict.verdict), ["in_transit", "legacy_unclassified", "legacy_unclassified", "normal"]);
	assert.equal(plugin.lineageRegistry.get(L), undefined, "an in-transit copy was claimed");
	plugin.pendingTransfers.clear();
	plugin.activeTransfers.set("1:live", { transferId: "1:live", status: "awaiting_validation", lineage: L, sourceInstanceId: I, targetInstanceId: J });
	assert.equal((await classify(plugin, [facts()])).verdicts[0].verdict, "in_transit", "an active transfer without an intent released its copy");
});

test("an in-transit or unresolved handoff quarantine records the owning source job, and only that one", async () => {
	assert.equal(classifyPlatform(facts(), hints({ inTransit: true, ownerJobId: "job-1" }), entry(), undefined, context()).ownerJobId, "job-1");
	assert.equal(classifyPlatform(facts({ protected: true }), hints({ ownerJobId: "job-1" }), entry(), undefined, context()).ownerJobId, "job-1");
	assert.equal(classifyPlatform(facts({ lineage: null, generation: null, protected: true }), hints({ ownerJobId: "job-1" }), undefined, undefined, context()).ownerJobId, "job-1");
	assert.equal(classifyPlatform(facts(), hints({ ownerJobId: "job-1" }), entry({ instanceId: J, generation: 1 }), { state: "present" }, context()).ownerJobId,
		undefined, "a duplicate became releasable by a transfer");
	const { plugin } = controllerHarness();
	const intent = (id, overrides) => ({ transferId: `1:${id}`, sourceExportId: id, sourceInstanceId: I, targetInstanceId: J, sourcePlatformIndex: 3,
		sourcePlatformName: "ship", forceName: "player", startedAt: 1, exportId: `1:${id}`, lineage: L, lineageGeneration: 0, ...overrides });
	plugin.pendingTransfers.set("1:job-a", intent("job-a"));
	assert.equal(plugin.owningSourceJob(I, facts()), "job-a");
	assert.equal(plugin.owningSourceJob(J, facts()), null, "another instance's transfer owns this copy");
	assert.equal(plugin.owningSourceJob(I, facts({ lineage: "lineage:other:1" })), null);
	assert.equal(plugin.owningSourceJob(I, facts({ lineage: null, generation: null })), "job-a", "an unlineaged source lost its handoff owner");
	plugin.platformStorage = new Map([["1:job-a", { exportData: { platform_uid: "boot-old:99" } }]]);
	assert.equal(plugin.owningSourceJob(I, facts({ lineage: null, generation: null })), null, "a reused index gave another platform's handoff owner");
	plugin.platformStorage.set("1:job-a", { exportData: { platform_uid: facts().platformUid } });
	assert.equal(plugin.owningSourceJob(I, facts({ lineage: null, generation: null })), "job-a");
	plugin.platformStorage.clear();
	plugin.activeTransfers.set("1:other", { transferId: "1:other", operationType: "transfer", status: "awaiting_validation", sourceInstanceId: I,
		targetInstanceId: J, platformIndex: 7, platformUid: "boot-old:98", sourceExportId: "job-other" });
	assert.equal(plugin.owningSourceJob(I, facts({ platformIndex: 7, lineage: null, generation: null })), null, "an active transfer of another platform owned a reused index");
	plugin.activeTransfers.clear();
	plugin.pendingTransfers.set("1:job-b", intent("job-b"));
	assert.equal(plugin.owningSourceJob(I, facts()), null, "an ambiguous owner was recorded");
	plugin.pendingTransfers.clear();
	plugin.activeTransfers.set("1:live", { transferId: "1:live", operationType: "transfer", status: "awaiting_validation", sourceInstanceId: I,
		targetInstanceId: J, platformIndex: 3, lineage: L, sourceExportId: "job-live" });
	assert.equal(plugin.owningSourceJob(I, facts()), "job-live");
	const { verdicts } = await classify(plugin, [facts()]);
	assert.deepEqual([verdicts[0].verdict, verdicts[0].ownerJobId], ["in_transit", "job-live"]);
});

test("gallery batch lifecycle: the live pair restored after golden transfers classifies normal", async () => {
	const { plugin } = controllerHarness();
	const live = [facts({ platformIndex: 2, lineage: "lineage:live-boot:40", generation: 0, hubUnitNumber: 40, platformUid: "live-boot:40" }),
		facts({ platformIndex: 3, lineage: "lineage:live-boot:41", generation: 3, hubUnitNumber: 41, platformUid: "live-boot:41" }),
		facts({ platformIndex: 4, lineage: null, generation: null, hadIdentity: true, hubUnitNumber: 42, platformUid: "live-boot:42" })];
	await plugin.lineageRegistry.update(draft => {
		draft.set("lineage:live-boot:40", { instanceId: I, generation: 0, platformName: "a", forceName: "player", lastExportId: null, updatedAt: 1, source: "claim" });
		draft.set("lineage:live-boot:41", { instanceId: I, generation: 3, platformName: "b", forceName: "player", lastExportId: "2:t", updatedAt: 1, source: "transfer" });
		draft.set("lineage:golden-boot:40", { instanceId: J, generation: 1, platformName: "g", forceName: "player", lastExportId: "1:g", updatedAt: 1, source: "transfer" });
	});
	const restored = live.map(platform => ({ ...platform, journalHubMatch: true }));
	const { verdicts } = await classify(plugin, restored);
	assert.deepEqual(verdicts.map(verdict => verdict.verdict), ["normal", "normal", "normal"],
		"a coincidental golden-save journal record quarantined a live platform");
});
