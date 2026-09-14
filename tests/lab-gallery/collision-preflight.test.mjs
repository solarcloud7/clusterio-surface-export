import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTransferIdCollisions, predictCanonicalIds } from "./batch-lifecycle.mjs";
const candidates = predictCanonicalIds({ instanceId: 2, counter: 10, platformName: "fixture", count: 3, epoch: "boot" });
test("a fresh fixture refuses every observed ID, including failed and historical operations", () => {
	for (const registrySource of ["active", "persisted", "both", undefined]) {
		for (const status of ["failed", "completed", "transporting", "awaiting_validation", "awaiting_completion", "in_progress", "unknown"]) {
			const hit = { transferId: candidates[1], registrySource, status };
			const result = checkTransferIdCollisions({ candidates, summaries: [hit] });
			assert.equal(result.fatal, true, `${registrySource}/${status} belongs to an existing operation`);
			assert.equal(result.status, "collision");
			assert.deepEqual(result.hits, [hit]);
		}
	}
});
test("all matching records survive collision reporting; unrelated history does not block", () => {
	const hits = candidates.map(transferId => ({ transferId, status: "completed", registrySource: "persisted" }));
	assert.deepEqual(checkTransferIdCollisions({ candidates, summaries: hits }).hits, hits);
	const result = checkTransferIdCollisions({ candidates, summaries: [{ transferId: "another-job" }] });
	assert.equal(result.fatal, false);
	assert.equal(result.status, "clear");
	assert.match(result.message, /windowed/);
});
test("unavailable history is reported as skipped, never as an admission guarantee", () => {
	const result = checkTransferIdCollisions({ candidates, summaries: null });
	assert.equal(result.status, "skipped");
	assert.equal(result.fatal, false);
});
