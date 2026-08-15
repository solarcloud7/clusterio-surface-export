"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");

const scriptUrl = pathToFileURL(path.join(__dirname, "..", "scripts", "lint-api-names.mjs")).href;
const indexPath = path.join(__dirname, "..", "scripts", "factorio-api-index.json");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));

async function guard() {
	return import(scriptUrl);
}

async function verdict(source) {
	const { collectReads, classifyReads } = await guard();
	return classifyReads(collectReads(source, "f.lua"), index);
}

test("every mapped receiver names a class the vendored index actually has", async () => {
	const { RECEIVER_CLASS } = await guard();
	for (const [receiver, className] of Object.entries(RECEIVER_CLASS)) {
		assert.ok(index.classes[className],
			`receiver ${receiver} maps to ${className}, which is not in the index — every read on that `
			+ "receiver would pass unchecked");
	}
	assert.ok(Object.keys(index.classes.LuaEntity).length > 100,
		"LuaEntity must carry a plausible member count or the oracle is broken");
});

test("the ghost members resolve from the index, so no hardcoded allowance is needed", async () => {
	for (const name of ["ghost_name", "ghost_type", "ghost_prototype", "ghost_localised_name"]) {
		assert.ok(index.classes.LuaEntity[name],
			`${name} must resolve from the index — it used to sit in a hardcoded ENTITY_GHOST_OK set, and a `
			+ "stale allowance is a hole");
	}
});

test("a bare read of an absent member fires — the auto_launch and planting_position incidents", async () => {
	const launch = await verdict("local mode = entity.auto_launch\n");
	assert.equal(launch.failures.length, 1);
	assert.equal(launch.failures[0].name, "auto_launch");
	assert.equal(launch.failures[0].context, "bare");

	const planting = await verdict("local p = entity.planting_position\n");
	assert.equal(planting.failures.length, 1);
	assert.equal(planting.failures[0].name, "planting_position");
});

test("a bare WRITE of an absent member fires — a write throws exactly like a read", async () => {
	const { failures } = await verdict("entity.auto_launch = true\n");
	assert.equal(failures.length, 1);
	assert.equal(failures[0].name, "auto_launch");
});

test("the safe_get arm survives the AST rewrite, in BOTH call shapes", async () => {
	const qualified = await verdict('local v = GameUtils.safe_get(entity, "driver_is_main_gunner")\n');
	assert.equal(qualified.failures.length, 1, "GameUtils.safe_get(...) is the shape every live call site uses — "
		+ "matching only the unqualified call would drop the founding incident's coverage entirely");
	assert.equal(qualified.failures[0].context, "safe_get");

	const bare = await verdict('local v = safe_get(entity, "driver_is_main_gunner")\n');
	assert.equal(bare.failures.length, 1);
});

test("a real name behind safe_get passes", async () => {
	const { failures, checked } = await verdict('local v = GameUtils.safe_get(entity, "driver_is_gunner")\n');
	assert.equal(failures.length, 0);
	assert.equal(checked, 1);
});

test("the pcall-probe arm covers a probe-only receiver — the live stack.spoil_result misname", async () => {
	const { failures } = await verdict(
		"local ok, r = pcall(function() return stack.spoil_result end)\n");
	assert.equal(failures.length, 1);
	assert.equal(failures[0].receiver, "stack");
	assert.equal(failures[0].className, "LuaItemStack");
	assert.equal(failures[0].context, "probe");
	assert.ok(failures[0].elsewhere, "spoil_result exists on LuaItemPrototype, and the report must say so");
});

test("a probe-only receiver is NOT checked as a bare read — module/ binds `stack` to plain tables", async () => {
	const { checked, failures } = await verdict("local r = stack.spoil_result\n");
	assert.equal(checked, 0, "core/json.lua binds `stack` to a recursion-guard table and utils/version-compat.lua "
		+ "to a plain item table, so a bare `stack.` read cannot be assumed to be a LuaItemStack");
	assert.equal(failures.length, 0);
});

test("only the FIRST hop is checked — the second hop is another class entirely", async () => {
	const { checked, failures } = await verdict("local r = entity.prototype.spoil_result\n");
	assert.equal(failures.length, 0, "spoil_result is a real LuaItemPrototype member; flagging it here would also "
		+ "flag every entity.position.x");
	assert.equal(checked, 1, "the first hop, entity.prototype, is still checked");
});

test("a member expression whose base is not a plain identifier does not fire", async () => {
	const { checked, failures } = await verdict("if item.entity.auto_launch then return end\n");
	assert.equal(checked, 0, "`item.entity` is a payload field, not the `entity` receiver — 30 such sites exist");
	assert.equal(failures.length, 0);
});

test("unmapped receivers are left alone", async () => {
	const { checked } = await verdict("local x = entity_data.specific_data\nlocal y = job.auto_launch\n");
	assert.equal(checked, 0);
});

test("comments and string literals cannot fire — the AST never sees them", async () => {
	const commented = await verdict("-- entity.auto_launch was removed in 2.0\nlocal n = entity.name\n");
	assert.equal(commented.failures.length, 0);
	assert.equal(commented.checked, 1);

	const stringed = await verdict('log("entity.auto_launch is gone")\nlocal n = entity.name\n');
	assert.equal(stringed.failures.length, 0);
	assert.equal(stringed.checked, 1);
});

test("the one-argument safe_get closure in connection-scanner is not mistaken for the two-arg helper", async () => {
	const { checked, failures } = await verdict('data.circuit_condition = safe_get("circuit_condition")\n');
	assert.equal(checked, 0, "connection-scanner.lua defines a local one-arg safe_get over a control behavior; "
		+ "reading its argument as a LuaEntity member name would invent 28 false positives");
	assert.equal(failures.length, 0);
});

test("method names count as members, and a real one passes", async () => {
	const { failures, checked } = await verdict("local inv = entity.get_inventory(defines.inventory.chest)\n");
	assert.equal(failures.length, 0, "get_inventory is LuaControl's — the index flattens the inheritance chain");
	assert.equal(checked, 1);
});

test("every bare receiver is genuinely checked", async () => {
	const { BARE_RECEIVERS } = await guard();
	for (const receiver of Object.keys(BARE_RECEIVERS)) {
		const { failures } = await verdict(`local v = ${receiver}.definitely_not_a_member_name\n`);
		assert.equal(failures.length, 1, `${receiver} is in the bare map but contributed no verdict`);
	}
});
