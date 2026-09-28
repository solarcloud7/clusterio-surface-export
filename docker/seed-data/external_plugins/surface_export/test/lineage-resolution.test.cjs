"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
	if (request === "@clusterio/lib") return { safeOutputFile: async (file, data) => fs.writeFile(file, data) };
	return originalLoad.call(this, request, parent, isMain);
};
const { LineageRegistry } = require("../dist/node/lib/lineage-registry");
const { LineageResolver } = require("../dist/node/lib/lineage-resolution");
const { resolutionActions } = require("../dist/node/shared/lineage-resolution");
const { hasUnresolvedPlatformOwnership } = require("../dist/node/shared/operation-lifecycle");
const messages = require("../dist/node/messages");
Module._load = originalLoad;

const I = 1, H = 2, L = "lineage:boot-old:15";

function candidate(overrides = {}) {
	return { platformIndex: 3, platformUid: "boot-old:15", hadIdentity: true, lineage: L, generation: 1, hubUnitNumber: 15,
		surfaceIndex: 8, platformName: "ship", forceName: "player", lockKind: "quarantine", jobOwns: false,
		journalUidMatch: false, journalHubMatch: false, protected: false, state: "quarantine", reason: "duplicate",
		ownerJobId: null, holderInstanceId: H, holderGeneration: 2, retiredExportId: null, resolutionRequestId: null, passengers: 2, ...overrides };
}

function entry(overrides = {}) {
	return { instanceId: H, generation: 2, platformName: "ship", forceName: "player", lastExportId: "2:x", updatedAt: 1, source: "transfer", ...overrides };
}

function cluster({ registry = new LineageRegistry(), candidates = { [I]: [candidate()] }, holder = { present: true, platformIndex: 9, platformUid: "h:9" } } = {}) {
	const sent = [];
	const storage = new Map();
	const behaviour = { lose: new Set(), jobIds: {}, jobState: {}, applyError: {}, deleteError: null, presenceError: null, reserved: new Set(), offline: new Set() };
	const counters = { prepare: 0, delete: 0, release: 0, mint: 0 };
	const host = {
		lineageRegistry: registry, pendingTransfers: new Map(), activeTransfers: new Map(), platformStorage: storage,
		get recoveryReservations() { return new Map([...behaviour.reserved].map(id => [id, {}])); },
		logger: { warn() {}, info() {} },
		isInstanceOnline: id => !behaviour.offline.has(id) && !behaviour.reserved.has(id),
		instanceIds: () => [I, H],
		lineageInTransit(lineage) {
			return !!lineage && ([...this.pendingTransfers.values()].some(intent => intent.lineage === lineage)
				|| [...this.activeTransfers.values()].some(transfer => transfer.lineage === lineage && hasUnresolvedPlatformOwnership(transfer)));
		},
		completedTransferFrom: () => false,
		owningSourceJob: () => null,
		async lineagePresence(wanted) {
			const results = new Map();
			for (const [holderId, set] of wanted) {
				for (const lineage of set) {
					results.set(`${holderId}\u0000${lineage}`, behaviour.presenceError || behaviour.offline.has(holderId)
						? { state: "unknown", reason: behaviour.presenceError || "offline" }
						: holder.present ? { state: "present" } : { state: "absent" });
				}
			}
			return results;
		},
		async send(instanceId, message) {
			const name = message.constructor.name;
			sent.push({ instanceId, name, message });
			const key = `${instanceId}:${name}:${message.step ?? ""}`;
			if (behaviour.lose.has(key)) { behaviour.lose.delete(key); throw Object.assign(new Error("Session Closed"), { code: "SessionLost" }); }
			if (name === "LineageCandidatesRequest") return { success: true, epoch: `epoch-${instanceId}`, platforms: candidates[instanceId] ?? [] };
			if (name === "LineagePresenceRequest") {
				if (behaviour.onDirectPresence) behaviour.onDirectPresence();
				return { success: true, lineages: message.lineages.map(lineage => ({ lineage, ...holder })) };
			}
			if (name === "ApplyLineageResolutionRequest") {
				if (behaviour.applyError[message.step]) return { success: false, error: behaviour.applyError[message.step] };
				if (message.step === "prepare_delete") {
					counters.prepare++;
					const jobId = behaviour.jobIds[instanceId] ?? `job-${instanceId}`;
					if (behaviour.storeSnapshot !== false) storage.set(`${instanceId}:${jobId}`, { exportId: `${instanceId}:${jobId}` });
					return { success: true, jobId };
				}
				if (message.step === "mint") { counters.mint++; return { success: true, lineage: `lineage:epoch-${instanceId}:15`, generation: 0 }; }
				counters.release++;
				return { success: true, platformUid: message.platformUid };
			}
			if (name === "JobsStatusRequest") {
				return { version: 1, epoch: "e", jobs: message.jobs.map(job => ({ jobId: job.jobId, state: behaviour.jobState[job.jobId] ?? "running" })) };
			}
			if (name === "DeleteSourcePlatformRequest") {
				counters.delete++;
				return behaviour.deleteError ? { success: false, error: behaviour.deleteError } : { success: true, passengers: [] };
			}
			throw new Error(`unexpected ${name}`);
		},
	};
	const resolver = new LineageResolver(host, messages, { snapshotWaitMs: 20, pollMs: 5 });
	return { host, resolver, sent, storage, behaviour, counters, registry };
}

const request = (overrides = {}) => ({ instanceId: I, platformIndex: 3, platformUid: "boot-old:15", action: "keep_other", requestId: "req-00000001", ...overrides });

test("each live verdict offers only its own actions", () => {
	const table = {
		duplicate: ["keep_this", "keep_other"], rollback_other: ["adopt", "stale_copy"], unregistered: ["adopt", "stale_copy"],
		stale_self: ["adopt", "stale_copy"], ahead_of_registry: ["adopt", "stale_copy"], legacy_unclassified: ["new_platform", "stale_copy"],
		duplicate_local: ["stale_copy"], normal: ["release", "stale_copy"], no_identity: ["release"],
		unverified: [], in_transit: [], unresolved_handoff: [],
	};
	for (const [verdict, actions] of Object.entries(table)) {
		const gate = resolutionActions(verdict, "quarantine");
		assert.deepEqual(gate.actions, actions, verdict);
		assert.equal(Boolean(gate.blocked), actions.length === 0, `${verdict} must explain a missing action`);
	}
	assert.deepEqual(resolutionActions("duplicate", "resolving").actions, [], "a copy in the middle of a resolution offered another action");
});

test("resolution needs its own permission and listing only needs the page view", () => {
	assert.equal(messages.PERMISSIONS.RECOVERY_RESOLVE, "surface_export.recovery.resolve");
	assert.equal(messages.ResolvePlatformLineageRequest.permission, messages.PERMISSIONS.RECOVERY_RESOLVE);
	assert.notEqual(messages.ResolvePlatformLineageRequest.permission, messages.PERMISSIONS.TRANSFER_EXPORTS);
	assert.equal(messages.ListLineageConflictsRequest.permission, messages.PERMISSIONS.UI_VIEW);
	assert.equal(messages.ApplyLineageResolutionRequest.src, "controller");
	assert.equal(messages.LineageCandidatesRequest.dst, "instance");
});

test("the conflict list evaluates live, labels hints and marks unchecked servers", async () => {
	const c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	c.behaviour.offline.add(H);
	let listing = await c.resolver.list(null);
	assert.deepEqual(listing.unavailable.map(item => item.instanceId), [H]);
	assert.equal(listing.conflicts[0].liveVerdict, "unverified", "an offline holder was treated as absent");
	assert.deepEqual(listing.conflicts[0].actions, []);
	assert.match(listing.conflicts[0].hints.presence, /offline/);
	c.behaviour.offline.delete(H);
	listing = await c.resolver.list(I);
	assert.equal(listing.conflicts[0].liveVerdict, "duplicate", "a returning holder did not turn the stored verdict into a decision");
	assert.deepEqual(listing.conflicts[0].actions, ["keep_this", "keep_other"]);
	assert.equal(listing.conflicts[0].storedReason, "duplicate");
	assert.equal(listing.conflicts[0].passengers, 2);
	assert.equal(c.registry.get(L).instanceId, H, "listing wrote to the registry");
});

test("duplicate after rollback: keep-other snapshots and deletes only this copy through the source-delete path", async () => {
	const c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	const result = await c.resolver.resolve(request());
	assert.deepEqual([result.success, result.status, result.step], [true, "completed", "completed"]);
	assert.equal(result.snapshotExportId, "1:job-1");
	const steps = c.sent.filter(item => item.name !== "LineageCandidatesRequest").map(item => `${item.instanceId}:${item.name}:${item.message.step ?? ""}`);
	assert.deepEqual(steps, ["1:ApplyLineageResolutionRequest:prepare_delete", "1:DeleteSourcePlatformRequest:"]);
	const deletion = c.sent.find(item => item.name === "DeleteSourcePlatformRequest").message;
	assert.deepEqual([deletion.platformIndex, deletion.exportId], [3, "job-1"], "the deletion did not use the resolution snapshot job");
	assert.equal(c.sent.some(item => item.instanceId === H), false, "the other copy was touched");
	assert.deepEqual(c.registry.get(L), entry(), "the surviving copy's registry entry changed");
	const record = c.registry.resolution("req-00000001");
	assert.deepEqual([record.status, record.step, record.snapshotExportId, record.passengers], ["completed", "completed", "1:job-1", 2]);
});

test("keep-this deletes the other server's copy, then advances the registry and releases this copy", async () => {
	const c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	const result = await c.resolver.resolve(request({ action: "keep_this" }));
	assert.equal(result.status, "completed");
	const order = c.sent.filter(item => !["LineageCandidatesRequest", "LineagePresenceRequest"].includes(item.name))
		.map(item => `${item.instanceId}:${item.name}:${item.message.step ?? ""}`);
	assert.deepEqual(order, ["2:ApplyLineageResolutionRequest:prepare_delete", "2:DeleteSourcePlatformRequest:", "1:ApplyLineageResolutionRequest:release"]);
	const deletion = c.sent.find(item => item.name === "DeleteSourcePlatformRequest").message;
	assert.equal(deletion.platformIndex, 9);
	const release = c.sent.find(item => item.message.step === "release").message;
	assert.deepEqual([release.lineage, release.generation], [L, 3]);
	assert.deepEqual([c.registry.get(L).instanceId, c.registry.get(L).generation, c.registry.get(L).source], [I, 3, "resolution"]);
});

test("adopt, new-platform and release commit the registry before the Lua release", async () => {
	let c = cluster({ candidates: { [I]: [candidate({ reason: "rollback_other" })] }, holder: { present: false } });
	await c.registry.update(draft => draft.set(L, entry()));
	let result = await c.resolver.resolve(request({ action: "adopt" }));
	assert.equal(result.status, "completed");
	assert.deepEqual([c.registry.get(L).instanceId, c.registry.get(L).generation], [I, 3]);
	assert.deepEqual([c.sent.at(-1).message.step, c.sent.at(-1).message.generation], ["release", 3]);
	c = cluster({ candidates: { [I]: [candidate({ lineage: null, generation: null, hadIdentity: false, journalHubMatch: true, reason: "legacy_unclassified" })] } });
	result = await c.resolver.resolve(request({ action: "new_platform" }));
	assert.equal(result.status, "completed");
	assert.deepEqual([c.registry.get("lineage:epoch-1:15").instanceId, c.registry.get("lineage:epoch-1:15").generation], [I, 0]);
	assert.deepEqual(c.sent.filter(item => item.message.step).map(item => item.message.step), ["mint", "release"]);
	c = cluster({ candidates: { [I]: [candidate({ platformUid: "boot-old:15", hubUnitNumber: null, lineage: null, generation: null, reason: "no_identity" })] } });
	result = await c.resolver.resolve(request({ action: "release" }));
	assert.equal(result.status, "completed");
	assert.equal(c.sent.at(-1).message.lineage, null);
});

test("every action re-checks at action time and refuses on any uncertainty", async () => {
	const refusals = [
		["an action the verdict does not offer", c => {}, { action: "adopt" }, /not available for a duplicate/],
		["an unverified holder", c => { c.behaviour.presenceError = "Session Closed"; }, {}, /not available for a unverified copy/],
		["a copy with a transfer in flight", c => { c.host.pendingTransfers.set("1:t", { transferId: "1:t", lineage: L, sourceInstanceId: H, targetInstanceId: I, sourcePlatformIndex: 5 }); }, {}, /in_transit|in flight/],
		["a copy owned by an unresolved handoff", c => { c.host.pendingTransfers.set("1:u", { transferId: "1:u", sourceInstanceId: I, targetInstanceId: H, sourcePlatformIndex: 3 }); }, {}, /unresolved|owns this copy/],
		["a changed identity", c => {}, { platformUid: "boot-new:15" }, /changed or is no longer quarantined/],
		["a reconciling instance", c => { c.behaviour.reserved.add(I); }, {}, /reconciling/],
		["a registry change after evaluation", c => {
			c.behaviour.onDirectPresence = () => { void c.registry.update(draft => draft.set(L, entry({ generation: 3, lastExportId: "2:y" }))); };
		}, { action: "keep_this" }, /registry changed/],
	];
	for (const [label, arrange, overrides, expected] of refusals) {
		const c = cluster();
		await c.registry.update(draft => draft.set(L, entry()));
		arrange(c);
		const result = await c.resolver.resolve(request(overrides));
		assert.equal(result.success, false, label);
		assert.match(result.error, expected, label);
		assert.equal(c.counters.prepare + c.counters.delete + c.counters.release, 0, `${label} still acted`);
		assert.equal(c.registry.resolution("req-00000001"), undefined, `${label} was recorded`);
	}
});

test("a request ID is bound to one resolution and concurrent retries share one run", async () => {
	const c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	const [first, second] = await Promise.all([c.resolver.resolve(request()), c.resolver.resolve(request())]);
	assert.equal(first.status, "completed");
	assert.deepEqual(second, first);
	assert.equal(c.counters.prepare, 1);
	const other = await c.resolver.resolve(request({ action: "keep_this" }));
	assert.equal(other.success, false);
	assert.match(other.error, /already belongs to another resolution/);
	const replay = await c.resolver.resolve(request());
	assert.equal(replay.status, "completed");
	assert.equal(c.counters.delete, 1, "a completed resolution was run again");
});

test("lost replies resume from the last confirmed step with the same request ID", async () => {
	for (const lost of ["1:ApplyLineageResolutionRequest:prepare_delete", "1:DeleteSourcePlatformRequest:"]) {
		const c = cluster();
		await c.registry.update(draft => draft.set(L, entry()));
		c.behaviour.lose.add(lost);
		const pending = await c.resolver.resolve(request());
		assert.deepEqual([pending.success, pending.status], [true, "in_progress"], lost);
		assert.match(pending.error, /reply was not received/);
		const resumed = await c.resolver.resolve(request());
		assert.equal(resumed.status, "completed", lost);
		assert.equal(c.counters.delete, 1);
	}
	const c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	c.behaviour.lose.add("1:ApplyLineageResolutionRequest:release");
	const pending = await c.resolver.resolve(request({ action: "keep_this" }));
	assert.equal(pending.step, "committed");
	assert.equal(c.registry.get(L).generation, 3);
	const resumed = await c.resolver.resolve(request({ action: "keep_this" }));
	assert.equal(resumed.status, "completed");
	assert.equal(c.registry.get(L).generation, 3, "a retried commit advanced the generation twice");
	assert.equal(c.counters.delete, 1, "a retried release deleted the other copy again");
});

test("a controller restart resumes the persisted resolution instead of starting another", async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lineage-resolution-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "registry.json");
	const registry = new LineageRegistry();
	await registry.load(file);
	await registry.update(draft => draft.set(L, entry()));
	const c = cluster({ registry });
	c.behaviour.storeSnapshot = false;
	const waiting = await c.resolver.resolve(request());
	assert.deepEqual([waiting.status, waiting.step], ["in_progress", "snapshot"]);
	const reloaded = new LineageRegistry();
	await reloaded.load(file);
	assert.equal(reloaded.resolution("req-00000001").jobId, "job-1");
	const restarted = cluster({ registry: reloaded });
	restarted.storage.set("1:job-1", { exportId: "1:job-1" });
	const done = await restarted.resolver.resolve(request());
	assert.equal(done.status, "completed");
	assert.equal(restarted.counters.prepare, 0, "a resumed resolution took a second snapshot");
	assert.equal(restarted.counters.delete, 1);
});

test("a failed snapshot or a forgotten Lua job ends the resolution without deleting", async () => {
	let c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	c.behaviour.storeSnapshot = false;
	c.behaviour.jobState["job-1"] = "failed";
	let result = await c.resolver.resolve(request());
	assert.deepEqual([result.success, result.status], [false, "failed"]);
	assert.match(result.error, /snapshot failed/);
	assert.equal(c.counters.delete, 0);
	c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	c.behaviour.storeSnapshot = false;
	await c.resolver.resolve(request());
	const record = c.registry.resolution("req-00000001");
	await c.registry.update((_draft, resolutions) => { resolutions.set(record.requestId, { ...record, step: "admitted" }); });
	c.behaviour.jobIds[I] = "job-other";
	result = await c.resolver.resolve(request());
	assert.equal(result.status, "failed");
	assert.match(result.error, /no longer knows/);
	assert.equal(c.counters.delete, 0);
	c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	c.behaviour.deleteError = "source evacuation not confirmed";
	result = await c.resolver.resolve(request());
	assert.deepEqual([result.success, result.status, result.step], [true, "in_progress", "delete"]);
	assert.match(result.error, /evacuation not confirmed/);
});

test("keep-this whose registry changed after the other copy was deleted leaves this copy quarantined", async () => {
	const c = cluster();
	await c.registry.update(draft => draft.set(L, entry()));
	const send = c.host.send.bind(c.host);
	c.host.send = async (id, message) => {
		const reply = await send(id, message);
		if (message.constructor.name === "DeleteSourcePlatformRequest") {
			await c.registry.update(draft => draft.set(L, entry({ generation: 5, lastExportId: "9:z" })));
		}
		return reply;
	};
	const result = await c.resolver.resolve(request({ action: "keep_this" }));
	assert.deepEqual([result.success, result.status], [false, "failed"]);
	assert.match(result.error, /registry changed.*stays quarantined/);
	assert.equal(c.counters.release, 0, "a copy was released against a changed registry");
});
