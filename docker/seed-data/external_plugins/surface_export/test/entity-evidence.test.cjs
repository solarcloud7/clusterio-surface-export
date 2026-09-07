const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { projectEntityEvidence, readEntityEvidence } = require("../dist/node/lib/entity-evidence");
const { ControllerPlugin } = require("../dist/node/controller");
const file = "failure_black_box_fixture_123.json";
const request = { transferId: "1:job", tick: 123, file };
const line = { entity_id: 50, entity_name: "turbo-transport-belt", position: { x: -6.5, y: -1.5 },
	line_index: 2, expected: { "explosive-rocket": 20 }, actual: { "explosive-rocket": 16 } };
const bundle = () => ({ transfer_id: "1:job", gate_tick: 123, belt_lines: { rows: [line] }, replay_payload: { secret: "not forwarded" } });
test("projects measured position and counts, never forwards the full replay", () => {
	const result = projectEntityEvidence(bundle(), "1:job", file, 123);
	assert.equal(result.status, "available");
	assert.deepEqual(result.rows, [{ entityId: 50, name: "turbo-transport-belt", x: -6.5, y: -1.5, line: 2,
		item: "explosive-rocket", expected: 20, actual: 16, delta: -4 }]);
	assert.ok(!JSON.stringify(result).includes("secret"));
});
test("identity, tick, missing measurements and invalid counts cannot become evidence", () => {
	assert.equal(projectEntityEvidence(bundle(), "1:other", file, 123).status, "unavailable");
	assert.equal(projectEntityEvidence(bundle(), "1:job", file, 124).status, "unavailable");
	for (const bad of [null, { ...bundle(), belt_lines: {} }, { ...bundle(), belt_lines: { rows: [{ ...line, actual: { rocket: Infinity } }] } }]) {
		assert.equal(projectEntityEvidence(bad, "1:job", file, 123).status, "unavailable");
	}
});
test("bounds projected rows while retaining total and truncation", () => {
	const b = bundle(); b.belt_lines.rows = Array.from({ length: 501 }, (_, i) => ({ ...line, entity_id: i }));
	const result = projectEntityEvidence(b, "1:job", file, 123);
	assert.equal(result.rows.length, 500); assert.equal(result.totalRows, 501); assert.equal(result.truncated, true);
});
test("file reads refuse traversal, malformed JSON, missing files and oversized diagnostics", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "entity-evidence-"));
	try {
		assert.equal((await readEntityEvidence(dir, request)).status, "unavailable");
		await fs.writeFile(path.join(dir, file), JSON.stringify(bundle()));
		assert.equal((await readEntityEvidence(dir, request)).status, "available");
		assert.equal((await readEntityEvidence(dir, { ...request, file: `../${file}` })).status, "unavailable");
		await fs.writeFile(path.join(dir, file), "{");
		assert.equal((await readEntityEvidence(dir, request)).status, "unavailable");
		await fs.truncate(path.join(dir, file), 64 * 1024 * 1024 + 1);
		assert.equal((await readEntityEvidence(dir, request)).status, "unavailable");
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("opening a log enriches a copy using its authoritative destination and reference", async () => {
	const detail = { success: true, transferId: "1:job", transferInfo: { targetInstanceId: 2 },
		summary: { validation: { failureBlackBox: { file, tick: 123 } } } };
	const calls = [];
	const plugin = { readTransactionLog: async () => detail, c: { sendTo: async (dst, message) => {
		calls.push([dst, message.toJSON()]); return projectEntityEvidence(bundle(), "1:job", file, 123);
	} } };
	const result = await ControllerPlugin.prototype.handleGetTransactionLog.call(plugin, { transferId: "1:job" });
	assert.deepEqual(calls, [[{ instanceId: 2 }, request]]);
	assert.equal(result.summary.validation.entityEvidence.rows[0].delta, -4);
	assert.equal(detail.summary.validation.entityEvidence, undefined, "read must not mutate retained transaction state");
	plugin.c.sendTo = async () => { throw new Error("offline"); };
	const offline = await ControllerPlugin.prototype.handleGetTransactionLog.call(plugin, { transferId: "1:job" });
	assert.equal(offline.success, true);
	assert.equal(offline.summary.validation.entityEvidence.status, "unavailable");
});
