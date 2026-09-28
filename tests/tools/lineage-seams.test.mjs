import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createCluster, luaValue } from "./lineage-seams.harness.mjs";

const binary = process.env.SE_TEST_LUA;
const skip = binary ? false : "set SE_TEST_LUA and SE_PLUGIN_DIST (CI runs this on Lua 5.2 after building the plugin)";
let sequence = 0;
const requestId = label => `${label}-${String(++sequence).padStart(4, "0")}-seams`;
const usable = copies => copies.filter(copy => copy.usable).length;

async function rolledBackSource({ lineageBeforeSave = true, keepDestinationCopy = true } = {}) {
	const c = await createCluster({ binary });
	const index = await c.create(1, "ship");
	if (lineageBeforeSave) await c.restart(1);
	await c.save(1, "before-transfer");
	await c.save(2, "empty");
	const { transfer } = await c.transfer(1, index, 2);
	assert.equal(transfer.status, "completed", "setup transfer A->B did not complete");
	const lineage = transfer.lineage;
	const destination = await c.find(2, "ship");
	await c.load(1, "before-transfer");
	if (!keepDestinationCopy) await c.load(2, "empty");
	return { c, index, lineage, destination };
}

async function conflictFor(c, instanceId, platformIndex) {
	const listing = await c.controller.resolver.list(instanceId);
	return listing.conflicts.find(entry => entry.platformIndex === platformIndex);
}

async function resolve(c, entry, action, id = requestId(action)) {
	return c.controller.resolver.resolve({ instanceId: entry.instanceId, platformIndex: entry.platformIndex, platformUid: entry.platformUid, action, requestId: id });
}

test("lineage seams (a): A->B, roll A back, then B->A never leaves zero usable copies", { skip }, async () => {
	const { c, index, lineage, destination } = await rolledBackSource();
	try {
		const restored = await c.platform(1, index);
		assert.equal(restored.usable, false, "the rolled-back source copy became usable");
		const back = await c.transfer(2, destination, 1);
		const copies = await c.copies(lineage);
		assert.equal(usable(copies), 1, `the return trip left ${usable(copies)} usable copies: ${JSON.stringify(copies)}`);
		assert.equal(back.started.success, false, "a transfer into a server that still holds a copy was admitted");
		assert.match(back.started.error, /resolve the quarantined copy first/);
		assert.equal((await c.platform(2, destination)).usable, true, "the refused return trip did not release the source");
	} finally { await c.close(); }
});

test("lineage seams (a2): a copy that appears at the destination after admission rolls back before the source is deleted", { skip }, async () => {
	const c = await createCluster({ binary });
	try {
		const index = await c.create(1, "ship");
		await c.restart(1);
		const lineage = (await c.platform(1, index)).lineage;
		const route = c.controller.controller.sendTo;
		c.controller.controller.sendTo = async (target, message) => {
			const reply = await route(target, message);
			if (message.constructor.name === "ImportPlatformRequest") {
				await c.world(2).eval(`harness.quarantine_copy("stale", ${JSON.stringify(lineage)}, 0, "duplicate")`);
			}
			return reply;
		};
		const { transfer } = await c.transfer(1, index, 2);
		const copies = await c.copies(lineage);
		assert.equal(usable(copies), 1, `a late destination copy left ${usable(copies)} usable copies: ${JSON.stringify(copies)}`);
		assert.equal((await c.platform(1, index)).usable, true, "the source was not rolled back");
		assert.equal(transfer.status, "failed");
	} finally { await c.close(); }
});

test("lineage seams (b): stale_copy on a journal-matched tombstone deletes it through its original retirement", { skip }, async () => {
	const { c, index } = await rolledBackSource({ keepDestinationCopy: false });
	try {
		const entry = await conflictFor(c, 1, index);
		assert.equal(entry.state, "tombstone");
		assert.equal(entry.liveVerdict, "rollback_other");
		const result = await resolve(c, entry, "stale_copy");
		assert.equal(result.status, "completed", `stale_copy on a tombstone did not complete: ${JSON.stringify(result)}`);
		assert.equal((await c.platform(1, index)).present, false);
	} finally { await c.close(); }
});

test("lineage seams (b2): stale_copy on a journal-matched copy that startup quarantined deletes it through the journal's retirement", { skip }, async () => {
	const { c, index } = await rolledBackSource({ keepDestinationCopy: false });
	try {
		await c.world(1).eval(`(function()
			local lock = storage.locked_platforms[${index}]
			lock.kind = "quarantine"
			lock.phase = nil
			lock.transfer_job_id = nil
			lock.committed_transfer_id = nil
			lock.committed_tick = nil
			lock.quarantine = {reason = "reconcile_error", epoch = storage.source_recovery_epoch}
			storage.source_recovery_notices[${index}].status = "quarantined"
			storage.source_recovery_notices[${index}].reason = "reconcile_error"
			return true end)()`);
		const entry = await conflictFor(c, 1, index);
		assert.equal(entry.state, "quarantine");
		assert.equal(entry.hints.journalUidMatch, true);
		assert.ok(entry.retiredExportId, "the listing lost the journal's retirement for a quarantined copy");
		const result = await resolve(c, entry, "stale_copy");
		assert.equal(result.status, "completed", `stale_copy on a journal-matched quarantine did not complete: ${JSON.stringify(result)}`);
		assert.equal((await c.platform(1, index)).present, false);
	} finally { await c.close(); }
});

test("lineage seams (c): keep_other on a journal-matched tombstone deletes it and leaves the other copy alone", { skip }, async () => {
	const { c, index, lineage, destination } = await rolledBackSource();
	try {
		await c.world(1).eval(`harness.add_player("pat", ${index})`);
		const entry = await conflictFor(c, 1, index);
		assert.equal(entry.liveVerdict, "duplicate");
		const result = await resolve(c, entry, "keep_other");
		assert.equal(result.status, "completed", `keep_other on a tombstone did not complete: ${JSON.stringify(result)}`);
		assert.equal((await c.platform(1, index)).present, false);
		assert.equal(await c.world(1).eval("harness.player_surface(1)"), 1, "the player aboard the deleted copy was not moved to the default planet");
		assert.equal((await c.platform(2, destination)).usable, true);
		assert.equal(usable(await c.copies(lineage)), 1);
		assert.equal(c.registry.get(lineage).instanceId, 2, "keep_other moved the registry");
	} finally { await c.close(); }
});

test("lineage seams (d): a tombstoned retired source is never offered or allowed new_platform", { skip }, async () => {
	const { c, index, destination } = await rolledBackSource({ lineageBeforeSave: false });
	try {
		const entry = await conflictFor(c, 1, index);
		assert.equal(entry.liveVerdict, "legacy_unclassified");
		assert.equal(entry.actions.includes("new_platform"), false, "new_platform was offered for a retired source");
		const result = await resolve(c, entry, "new_platform");
		assert.equal(result.success, false, "new_platform released a retired source beside its transferred copy");
		assert.equal((await c.platform(1, index)).usable, false);
		assert.equal((await c.platform(2, destination)).usable, true);
	} finally { await c.close(); }
});

test("lineage seams (e): adopt refuses while a live copy exists elsewhere (unregistered and ahead_of_registry)", { skip }, async () => {
	for (const variant of ["unregistered", "ahead_of_registry"]) {
		const c = await createCluster({ binary });
		try {
			const lineage = "lineage:elsewhere-boot:777";
			const live = await c.world(2).eval(`harness.lineage_copy("live", ${JSON.stringify(lineage)}, 1)`);
			if (variant === "ahead_of_registry") {
				await c.registry.update(draft => draft.set(lineage, { instanceId: 2, generation: 0, platformName: "live", forceName: "player",
					lastExportId: null, updatedAt: 1, source: "claim" }));
			}
			const quarantined = await c.world(1).eval(`harness.quarantine_copy("copy", ${JSON.stringify(lineage)}, ${variant === "unregistered" ? 1 : 2}, ${JSON.stringify(variant)})`);
			const entry = await conflictFor(c, 1, quarantined);
			assert.equal(entry.liveVerdict, variant);
			const result = await resolve(c, entry, "adopt");
			assert.equal(result.success, false, `${variant}: adopt released a copy while another server holds a live one`);
			assert.equal((await c.platform(2, live)).usable, true);
			assert.equal(usable(await c.copies(lineage)), 1, variant);
		} finally { await c.close(); }
	}
});

for (const variant of ["ahead_of_registry", "stale_self"]) {
	test(`lineage seams (e2): adopt of ${variant} asks every other server, not only the registry holder`, { skip }, async () => {
		const c = await createCluster({ binary, ids: [1, 2, 3] });
		try {
			const lineage = "lineage:three-boot:555";
			const live = await c.world(1).eval(`harness.lineage_copy("live", ${JSON.stringify(lineage)}, 3)`);
			const holder = variant === "ahead_of_registry" ? { instanceId: 2, generation: 1 } : { instanceId: 3, generation: 2 };
			await c.registry.update(draft => draft.set(lineage, { ...holder, platformName: "live", forceName: "player",
				lastExportId: "x:1", updatedAt: 1, source: "transfer" }));
			const quarantined = await c.world(3).eval(`harness.quarantine_copy("copy", ${JSON.stringify(lineage)}, ${variant === "ahead_of_registry" ? 2 : 1}, ${JSON.stringify(variant)})`);
			const entry = await conflictFor(c, 3, quarantined);
			assert.equal(entry.liveVerdict, variant);
			assert.ok(entry.actions.includes("adopt"));
			const result = await resolve(c, entry, "adopt");
			assert.equal(result.success, false, `${variant}: adopt released a copy while instance 1 holds a live one: ${JSON.stringify(result)}`);
			assert.match(result.error, /Instance 1 still has a copy/);
			assert.equal((await c.platform(1, live)).usable, true);
			assert.equal(usable(await c.copies(lineage)), 1, `${variant}: ${JSON.stringify(await c.copies(lineage))}`);
			c.controller.controller.instances.set(4, { id: 4, isDeleted: false, config: { get: key => key === "surface_export.load_plugin" ? false : undefined } });
			await c.world(1).eval(`(function() game.forces.player.platforms[${live}].valid = false return true end)()`);
			const disabled = await resolve(c, entry, "adopt");
			assert.equal(disabled.success, false, "an instance with the plugin disabled was treated as holding no copy");
			assert.match(disabled.error, /Instance 4 could not rule out/);
			c.controller.controller.instances.delete(4);
			const adopted = await resolve(c, entry, "adopt");
			assert.equal(adopted.status, "completed", `${variant}: adopt refused after every other server answered absent: ${JSON.stringify(adopted)}`);
			assert.equal(usable(await c.copies(lineage)), 1);
		} finally { await c.close(); }
	});
}

test("lineage seams (e3): a listed copy is duplicate_local while another usable local copy carries its lineage", { skip }, async () => {
	const c = await createCluster({ binary });
	try {
		const lineage = "lineage:local-boot:444";
		const live = await c.world(1).eval(`harness.lineage_copy("live", ${JSON.stringify(lineage)}, 3)`);
		const quarantined = await c.world(1).eval(`(function()
			local index = harness.create_platform("copy", "player")
			local platform = game.forces.player.platforms[index]
			local hub = platform.hub
			storage.surface_export_lineages[index] = {lineage = ${JSON.stringify(lineage)}, generation = 4, surface_index = platform.surface.index, hub_unit_number = hub.unit_number}
			assert(harness.SurfaceLock.lock_platform(platform, platform.force, {kind = "startup"}))
			local lock = harness.SurfaceLock.get_lock_data(index)
			lock.kind = "quarantine"
			lock.platform_uid = harness.Recovery.platform_uid(platform)
			lock.quarantine = {reason = "ahead_of_registry", lineage = ${JSON.stringify(lineage)}, generation = 4, epoch = storage.source_recovery_epoch}
			return index end)()`);
		await c.registry.update(draft => draft.set(lineage, { instanceId: 1, generation: 3, platformName: "live", forceName: "player",
			lastExportId: "x:1", updatedAt: 1, source: "transfer" }));
		const entry = await conflictFor(c, 1, quarantined);
		assert.equal(entry.liveVerdict, "duplicate_local", `a second local copy was not reported: ${entry.liveVerdict}`);
		assert.deepEqual(entry.actions, ["stale_copy"]);
		const result = await resolve(c, entry, "adopt");
		assert.equal(result.success, false);
		assert.equal(c.registry.get(lineage).generation, 3, "the registry was committed for a copy Lua must refuse to release");
		assert.equal((await c.platform(1, live)).usable, true);
	} finally { await c.close(); }
});

test("lineage seams (f): a copy quarantined without a hub becomes resolvable once it has one", { skip }, async () => {
	const c = await createCluster({ binary });
	try {
		const index = await c.create(1, "starter", "player", false);
		await c.restart(1);
		assert.equal((await c.platform(1, index)).reason, "no_identity");
		await c.world(1).eval(`harness.add_hub(${index})`);
		const entry = await conflictFor(c, 1, index);
		assert.ok(entry?.platformUid, "the platform did not gain an identity with its hub");
		assert.ok(entry.actions.includes("release"), `no release offered: ${JSON.stringify(entry)}`);
		const result = await resolve(c, entry, "release");
		assert.equal(result.status, "completed", `release did not complete: ${JSON.stringify(result)}`);
		assert.equal((await c.platform(1, index)).usable, true);
	} finally { await c.close(); }
});

test("lineage seams (g): keep_this deletes the other copy in its own force and shows who is aboard it", { skip }, async () => {
	const c = await createCluster({ binary });
	try {
		const lineage = "lineage:elsewhere-boot:888";
		const other = await c.world(2).eval(`harness.lineage_copy("other", ${JSON.stringify(lineage)}, 1, "engineers")`);
		await c.world(2).eval(`harness.add_player("sam", ${other}, "engineers")`);
		await c.registry.update(draft => draft.set(lineage, { instanceId: 2, generation: 1, platformName: "other", forceName: "engineers",
			lastExportId: "2:x", updatedAt: 1, source: "transfer" }));
		const mine = await c.world(1).eval(`harness.quarantine_copy("mine", ${JSON.stringify(lineage)}, 1, "duplicate")`);
		const entry = await conflictFor(c, 1, mine);
		assert.equal(entry.liveVerdict, "duplicate");
		assert.equal(entry.holderPassengers, 1, "the confirmation cannot show who is aboard the copy keep_this deletes");
		const result = await resolve(c, entry, "keep_this");
		assert.equal(result.status, "completed", `keep_this did not complete: ${JSON.stringify(result)}`);
		assert.equal((await c.platform(2, other, "engineers")).present, false);
		assert.equal(await c.world(2).eval("harness.player_surface(1)"), 1, "the player aboard was not evacuated");
		assert.equal((await c.platform(1, mine)).usable, true);
		assert.deepEqual([c.registry.get(lineage).instanceId, c.registry.get(lineage).generation], [1, 2]);
	} finally { await c.close(); }
});

test("lineage seams (h): a deletion that keeps refusing can be abandoned with protection restored", { skip }, async () => {
	for (const action of ["keep_this", "stale_copy"]) {
		const c = await createCluster({ binary });
		try {
			const lineage = "lineage:elsewhere-boot:999";
			const other = await c.world(2).eval(`harness.lineage_copy("other", ${JSON.stringify(lineage)}, ${action === "keep_this" ? 1 : 0})`);
			if (action === "keep_this") {
				await c.registry.update(draft => draft.set(lineage, { instanceId: 2, generation: 1, platformName: "other", forceName: "player",
					lastExportId: "2:x", updatedAt: 1, source: "transfer" }));
			}
			const mine = await c.world(1).eval(`harness.quarantine_copy("mine", ${JSON.stringify(lineage)}, 1, ${JSON.stringify(action === "keep_this" ? "duplicate" : "stale_self")})`);
			if (action === "stale_copy") {
				await c.registry.update(draft => draft.set(lineage, { instanceId: 1, generation: 3, platformName: "mine", forceName: "player",
					lastExportId: "1:x", updatedAt: 1, source: "transfer" }));
				await c.world(2).eval(`(function() game.forces.player.platforms[${other}].valid = false return true end)()`);
			}
			const deleting = action === "keep_this" ? 2 : 1;
			mkdirSync(path.join(c.dir, `journal-${deleting}.json.tmp`));
			const entry = await conflictFor(c, 1, mine);
			const id = requestId(action);
			const first = await resolve(c, entry, action, id);
			assert.deepEqual([first.status, first.step], ["in_progress", "delete"], `${action}: ${JSON.stringify(first)}`);
			const again = await resolve(c, entry, action, id);
			assert.equal(again.step, "delete");
			const abandoned = await c.controller.resolver.abandon(id);
			assert.equal(abandoned.status, "failed", `${action}: the stuck deletion could not be abandoned: ${JSON.stringify(abandoned)}`);
			assert.equal((await c.platform(1, mine)).lockKind, "quarantine", `${action}: the quarantine was not restored`);
			if (action === "keep_this") assert.equal((await c.platform(2, other)).usable, true, "the other server's copy stayed locked");
		} finally { await c.close(); }
	}
});

test("lineage seams (h2): abandoning after a deletion whose reply was lost finishes it instead of reporting the copy restored", { skip }, async () => {
	const { c, index } = await rolledBackSource({ keepDestinationCopy: false });
	try {
		const entry = await conflictFor(c, 1, index);
		const send = c.controller.controller.sendTo;
		c.controller.controller.sendTo = async (target, message) => {
			const reply = await send(target, message);
			if (message.constructor.name === "DeleteSourcePlatformRequest") {
				c.controller.controller.sendTo = send;
				throw new Error("Session Closed");
			}
			return reply;
		};
		const id = requestId("stale_copy");
		const lost = await resolve(c, entry, "stale_copy", id);
		assert.deepEqual([lost.status, lost.step], ["in_progress", "delete"], JSON.stringify(lost));
		assert.equal((await c.platform(1, index)).present, false, "the deletion did not run before its reply was lost");
		const abandoned = await c.controller.resolver.abandon(id);
		assert.equal(abandoned.status, "completed", `a deletion that already happened was reported abandoned: ${JSON.stringify(abandoned)}`);
	} finally { await c.close(); }
});

test("lineage seams (h3): a delete-only resolution does not quarantine the current copy when its server restarts", { skip }, async () => {
	const { c, index, lineage, destination } = await rolledBackSource();
	try {
		const entry = await conflictFor(c, 1, index);
		assert.equal(entry.liveVerdict, "duplicate");
		const send = c.controller.controller.sendTo;
		c.controller.controller.sendTo = async (target, message) => {
			if (message.constructor.name === "DeleteSourcePlatformRequest") throw new Error("Session Closed");
			return send(target, message);
		};
		const id = requestId("keep_other");
		const stuck = await resolve(c, entry, "keep_other", id);
		assert.deepEqual([stuck.status, stuck.step], ["in_progress", "delete"], JSON.stringify(stuck));
		await c.restart(2);
		const holder = await c.platform(2, destination);
		assert.equal(holder.usable, true, `a restart during keep_other quarantined the current copy: ${JSON.stringify(holder)}`);
		c.controller.controller.sendTo = send;
		const abandoned = await c.controller.resolver.abandon(id);
		assert.equal(abandoned.status, "failed", JSON.stringify(abandoned));
		assert.equal(usable(await c.copies(lineage)), 1);
		assert.equal((await c.platform(2, destination)).usable, true);
	} finally { await c.close(); }
});

test("lineage seams (i): a release without a controller-issued token is refused", { skip }, async () => {
	const c = await createCluster({ binary });
	try {
		const index = await c.world(1).eval(`harness.quarantine_copy("mine", "lineage:x-boot:5", 0, "unverified")`);
		const uid = (await c.platform(1, index)).uid;
		const forged = await c.world(1).eval(`helpers.json_to_table(remote.call("surface_export", "resolution_apply_json",
			helpers.table_to_json(${luaValue({ requestId: "forged-release-0001", step: "release", platformIndex: index, platformUid: uid })})))`);
		assert.equal(forged.success, false, "resolution_apply_json released a quarantine without a controller-issued token");
		assert.equal((await c.platform(1, index)).lockKind, "quarantine");
	} finally { await c.close(); }
});
