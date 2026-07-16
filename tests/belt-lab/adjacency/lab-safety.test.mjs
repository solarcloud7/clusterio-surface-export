import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { cleanupAll, preflight, requireLuaSuccess } from "./lab-safety.mjs";
import { RuntimeClient } from "./runtime-client.mjs";

const luaSource = readFileSync(new URL("./lab-runtime.lua", import.meta.url), "utf8");

test("preflight refuses an existing pause or unrelated transfer state", () => {
	const clear = { success: true, gamePaused: false, jobs: 0, locks: 0, holds: 0, tombstones: 0 };
	assert.doesNotThrow(() => preflight(["host"], () => clear));
	for (const field of ["gamePaused", "jobs", "locks", "holds", "tombstones"]) {
		const busy = { ...clear, [field]: field === "gamePaused" ? true : 1 };
		assert.throws(() => preflight(["host"], () => busy), new RegExp(field));
	}
});

test("cleanup visits and inspects both instances after the first cleanup throws", () => {
	const calls = [];
	const result = cleanupAll(
		["one", "two"],
		instance => {
			calls.push(`cleanup:${instance}`);
			if (instance === "one") throw new Error("injected cleanup failure");
			return { success: true };
		},
		instance => {
			calls.push(`inspect:${instance}`);
			return { success: true, surfaces: 0 };
		},
	);
	assert.deepEqual(calls, ["cleanup:one", "inspect:one", "cleanup:two", "inspect:two"]);
	assert.match(result.one.errors.join("\n"), /injected cleanup failure/);
	assert.equal(result.two.errors.length, 0);
});

test("caught Lua failures never become evidence", () => {
	assert.throws(() => requireLuaSuccess({ success: false, error: "construction failed" }, "construct"), /construction failed/);
	assert.throws(() => requireLuaSuccess(null, "inspect"), /missing success=true/);
});

test("runtime unpauses only after acquiring pause ownership", async () => {
	let paused = false;
	const calls = [];
	const transport = async (operation, payload) => {
		calls.push({ operation, payload });
		if (operation === "inspect") return { success: true, gamePaused: paused };
		if (operation === "set_pause") {
			assert.equal(paused, payload.expectedCurrent);
			paused = payload.paused;
			return { success: true, gamePaused: paused };
		}
		throw new Error(`unexpected ${operation}`);
	};
	const client = new RuntimeClient({ transport });
	await client.beginOwnedPause();
	assert.equal(paused, true);
	await client.endOwnedPause();
	assert.equal(paused, false);
	assert.deepEqual(calls.filter(call => call.operation === "set_pause").map(call => call.payload.paused), [true, false]);
});

test("runtime never unpauses when pause ownership was not acquired", async () => {
	let paused = true;
	const calls = [];
	const client = new RuntimeClient({
		transport: async (operation) => {
			calls.push(operation);
			if (operation === "inspect") return { success: true, gamePaused: paused };
			if (operation === "set_pause") paused = false;
			return { success: true, gamePaused: paused };
		},
	});
	await assert.rejects(() => client.beginOwnedPause(), /already paused/);
	await client.endOwnedPause();
	assert.equal(paused, true);
	assert.deepEqual(calls, ["inspect"]);
});

test("R0 Lua runtime is prefix-scoped and contains no item insertion path", () => {
	assert.match(luaSource, /belt-adjacency-r0-/);
	assert.match(luaSource, /committed_source_transfer_tombstones/);
	assert.doesNotMatch(luaSource, /insert_at|insert_at_back|spill_item_stack|hub/);
	assert.doesNotMatch(luaSource, /line_equals|\.input_lines|\.output_lines/);
	assert.doesNotMatch(luaSource, /game\.tick_paused\s*=\s*false/);
	assert.doesNotMatch(luaSource, /find_entity_by_unit_number|surface\.get_item_count/);
	assert.match(luaSource, /get_detailed_contents/);
});
