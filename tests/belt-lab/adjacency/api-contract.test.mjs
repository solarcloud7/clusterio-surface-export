import assert from "node:assert/strict";
import test from "node:test";

import {
	EXPECTED_RUNTIME_API_SHA256,
	certifyRuntimeApi,
	sha256Buffer,
} from "./api-contract.mjs";

const schema = {
	application_version: "2.0.77",
	classes: [{
		name: "LuaEntity",
		methods: [
			{ name: "get_item_insert_specification", parameters: [{ type: "MapPosition" }], return_values: [{ type: "uint32" }, { type: "float" }] },
			{ name: "get_line_item_position", parameters: [{ type: "defines.transport_line" }, { type: "float" }], return_values: [{ type: "MapPosition" }] },
			{ name: "get_transport_line", parameters: [{ type: "defines.transport_line" }], return_values: [{ type: "LuaTransportLine" }] },
		],
	}],
	defines: [{
		name: "transport_line",
		values: [
			{ name: "left_line" },
			{ name: "right_line" },
			{ name: "left_underground_line" },
			{ name: "right_underground_line" },
			{ name: "secondary_left_line" },
			{ name: "secondary_right_line" },
			{ name: "left_split_line" },
			{ name: "right_split_line" },
			{ name: "secondary_left_split_line" },
			{ name: "secondary_right_split_line" },
		],
	}],
};

test("certifies only the complete Factorio 2.0.77 API signature contract", () => {
	const result = certifyRuntimeApi(schema);
	assert.equal(result.version, "2.0.77");
	assert.equal(result.behaviorScope, "signatures-only");
	assert.equal(result.transportLineRoles.length, 10);
	assert.deepEqual(result.methods.get_item_insert_specification.returns, ["uint32", "float"]);
});

test("fails closed when a transport-line role disappears", () => {
	const changed = structuredClone(schema);
	changed.defines[0].values.pop();
	assert.throws(() => certifyRuntimeApi(changed), /secondary_right_split_line/);
});

test("pins the downloaded official artifact by SHA-256", () => {
	assert.equal(EXPECTED_RUNTIME_API_SHA256, "594b4ec98cc5fbee322d7380db49a388ab38b0d69c06f00ead877cffbb37f578");
	assert.equal(sha256Buffer(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
