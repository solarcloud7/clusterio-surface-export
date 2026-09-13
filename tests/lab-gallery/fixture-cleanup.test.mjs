import { test } from "node:test";
import assert from "node:assert/strict";
import { assertFixtureCleanup } from "./fixture-cleanup.mjs";

test("cleanup refuses missing, malformed and unsuccessful RCON results", () => {
	for (const result of [undefined, {}, { swept: 1 }, { success: false, swept: 1,
		errors: [{ index: 3, error: "Fixture unlock refused" }] }]) {
		assert.throws(() => assertFixtureCleanup(result), /Fixture cleanup failed/);
	}
	const complete = { success: true, swept: 2, errors: [] };
	assert.equal(assertFixtureCleanup(complete), complete);
});
