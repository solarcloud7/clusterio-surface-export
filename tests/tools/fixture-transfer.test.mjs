import test from "node:test";
import assert from "node:assert/strict";
import { runFixtureTransfer } from "../integration/lib/fixture-transfer.mjs";
import { createCase as inventory } from "../integration/inventory-item-state/case.mjs";
import { createCase as belt } from "../integration/belt-item-state/case.mjs";
import { createCase as config } from "../integration/config-attrs/case.mjs";

const platform = (index, uid, name = "fixture-test") => ({ platform_index: index, platform_uid: uid,
	surface_index: index + 100, platform_name: name, force_name: "player" });

function rig(fault) {
	const original = platform(21, "original", "lab-transfer-fixture-v1"), clone = platform(22, "clone");
	const destination = platform(33, "arrived");
	let cloned = false, started = false, removed = false;
	const calls = [], stages = [];
	const io = { report() {}, sleep: async () => {}, instanceIds: () => ({ 1: 1, 2: 2 }),
		storedField(id, field) {
			assert.equal(id, "1:transfer_1"); assert.equal(field, "summary");
			return { transferId: id, platform: { name: "fixture-test" }, result: fault === "stored-verdict" ? "FAILED" : "SUCCESS" };
		},
		ctl: () => JSON.stringify([{ transferId: "1:transfer_1", sourceInstanceId: 1, targetInstanceId: 2,
			operationType: "transfer", status: "completed", completedAt: 1 }]),
		lua(host, body) {
			calls.push({ host, body });
			if (body.includes("platforms=remote.call")) return { success: true, platforms: host === 1
				? [original, ...(cloned && !started && !removed ? [clone] : [])] : started && !removed ? [destination] : [] };
			if (body.includes("['fixture_preflight']")) return { success: true };
			if (body.includes("'clone_platform'")) {
				assert.match(body, /original/); cloned = true;
				return { success: true, job_id: "clone_1" };
			}
			if (body.includes("local name=")) return { success: true, index: 22, jobId: "import_1", active: false,
				status: "complete", complete: true, identityMatched: true, identity: clone,
				...(fault === "clone" ? { error: "clone interrupted" } : {}) };
			if (body.includes("'export_platform'")) {
				assert.match(body, /clone/); started = true;
				if (fault === "lost-reply") throw new Error("lost transfer reply");
				return { success: true, jobId: "transfer_1" };
			}
			if (body.includes("destination_live")) return { success: true, receipt: { ...destination, transfer_id: "1:transfer_1" } };
			if (body.includes("game.delete_surface")) {
				assert.match(body, started ? /arrived/ : /clone/);
				assert.equal(host, started ? 2 : 1);
				if (fault === "cleanup") return { success: false, error: "unlock refused" };
				removed = true;
				return { success: true, swept: 1 };
			}
			if (body.includes("game.tick_paused")) return { success: true, paused: false };
			throw new Error("Unexpected Lua call");
		} };
	const create = name => context => ({
		prepare() { stages.push(`prepare:${name}`); if (fault === "prepare" && name === "inventory") context.fail("unarmed inventory"); },
		source() { stages.push(`source:${name}`); assert.match(context.platformLua(), /clone/); },
		verify() { stages.push(`verify:${name}`); assert.match(context.platformLua(), /arrived/);
			if (fault === "verify") context.fail(`${name} differs`); },
	});
	return { io, calls, stages, cases: [create("inventory"), create("belt")] };
}

test("compatible cases build before source reads and share one transfer and cleanup", async () => {
	const r = rig();
	const result = await runFixtureTransfer({ cloneName: "fixture-test", cases: r.cases }, r.io);
	assert.deepEqual(result.problems, []);
	assert.deepEqual(r.stages, ["prepare:inventory", "prepare:belt", "source:inventory", "source:belt", "verify:belt", "verify:inventory"]);
	for (const operation of ["'clone_platform'", "'export_platform'", "game.delete_surface"]) {
		assert.equal(r.calls.filter(call => call.body.includes(operation)).length, 1, operation);
	}
});

for (const [fault, message] of [["clone", /clone interrupted/], ["lost-reply", /lost transfer reply/]]) {
	test(`${fault}: shared runner cannot delete an uncertain platform`, async () => {
		const r = rig(fault);
		await assert.rejects(runFixtureTransfer({ cloneName: "fixture-test", cases: r.cases }, r.io), message);
		assert.equal(r.calls.filter(call => call.body.includes("game.delete_surface")).length, 0);
		assert.ok(r.calls.filter(call => call.body.includes("'export_platform'")).length <= 1);
	});
}

for (const fault of ["lookup", "invalid-ids"]) {
	test(`${fault}: preflight failure cleans the known unexported clone`, async () => {
		const r = rig();
		r.io.instanceIds = async () => {
			if (fault === "lookup") throw new Error("instance lookup failed");
			return { 1: 1, 2: 1 };
		};
		await assert.rejects(runFixtureTransfer({ cloneName: "fixture-test", cases: r.cases }, r.io),
			fault === "lookup" ? /instance lookup failed/ : /Source and destination must differ/);
		assert.equal(r.calls.filter(call => call.body.includes("'export_platform'")).length, 0);
		const removals = r.calls.filter(call => call.body.includes("game.delete_surface"));
		assert.equal(removals.length, 1);
		assert.equal(removals[0].host, 1);
		assert.match(removals[0].body, /clone/);
	});
}

for (const fault of ["prepare", "verify", "cleanup"]) {
	test(`${fault} failure stays red after shared cleanup`, async () => {
		const r = rig(fault);
		const result = await runFixtureTransfer({ cloneName: "fixture-test", cases: r.cases }, r.io);
		assert.ok(result.problems.length > 0);
		assert.equal(r.calls.filter(call => call.body.includes("game.delete_surface")).length, 1);
		if (fault === "prepare") assert.equal(r.calls.filter(call => call.body.includes("'export_platform'")).length, 0);
	});
}

test("failed stored verdict fails after guarded destination cleanup", async () => {
	const r = rig("stored-verdict");
	await assert.rejects(runFixtureTransfer({ cloneName: "fixture-test", cases: r.cases }, r.io), /Stored transfer verdict failed/);
	assert.equal(r.calls.filter(call => call.body.includes("game.delete_surface")).length, 1);
});

test("real case factories construct without touching a cluster", () => {
	for (const create of [inventory, belt, config]) {
		const spec = create({ CLONE: "fixture-test" });
		for (const phase of ["prepare", "source", "verify"]) assert.equal(typeof spec[phase], "function");
	}
});
