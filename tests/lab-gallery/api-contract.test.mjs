import assert from "node:assert/strict";
import test from "node:test";

import { certifyRuntimeApiSchema } from "./api-contract.mjs";

function apiClass(name, methods = [], attributes = []) {
	return {
		name,
		methods: methods.map(method => ({ name: method })),
		attributes: attributes.map(attribute => ({ name: attribute })),
	};
}

function completeSchema() {
	return {
		application_version: "2.0.77",
		classes: [
			apiClass("LuaGameScript", ["create_surface", "delete_surface", "server_save"], ["surfaces"]),
			apiClass("LuaSurface", ["create_entity", "find_entity", "set_tiles", "delete_chunk", "get_property", "find_non_colliding_position", "can_place_entity", "find_entities_filtered"], ["platform", "planet", "map_gen_settings", "generate_with_lab_tiles", "has_global_electric_network", "ignore_surface_conditions"]),
			apiClass("LuaForce", ["add_chart_tag", "chart", "find_chart_tags", "create_space_platform"], ["platforms"]),
			apiClass("LuaSpacePlatform", ["apply_starter_pack", "destroy"], ["surface", "paused", "name", "valid"]),
			apiClass("LuaEntity", ["destroy", "get_max_transport_line_index", "get_transport_line"], ["loader_type", "valid", "fluidbox", "mining_target", "name"]),
			apiClass("LuaControl", ["get_inventory"]),
			apiClass("LuaInventory", ["get_item_count", "insert"]),
			apiClass("LuaTransportLine", ["get_detailed_contents"]),
			apiClass("LuaRendering", ["draw_text", "get_all_objects"]),
			apiClass("LuaRenderObject", ["destroy"]),
			apiClass("LuaCustomChartTag", ["destroy"]),
		],
		concepts: [{
			name: "MapGenSettings",
			type: { complex_type: "table", parameters: [
				{ name: "default_enable_all_autoplace_controls" }, { name: "width" }, { name: "height" },
			] },
		}],
	};
}

test("paired gallery runtime touchpoints are certified as API shapes only", () => {
	assert.deepEqual(certifyRuntimeApiSchema(completeSchema()), {
		version: "2.0.77", behaviorScope: "signatures-only",
	});
});

test("certification rejects missing platform, chunk, and map-generation shapes", () => {
	for (const mutate of [
		schema => schema.classes.find(entry => entry.name === "LuaSpacePlatform").methods.pop(),
		schema => schema.classes.find(entry => entry.name === "LuaSurface").methods.splice(3, 1),
		schema => schema.concepts[0].type.parameters.shift(),
	]) {
		const schema = completeSchema();
		mutate(schema);
		assert.throws(() => certifyRuntimeApiSchema(schema), /missing/);
	}
});

test("certification rejects a missing lab-surface setting", () => {
	const schema = completeSchema();
	const surface = schema.classes.find(entry => entry.name === "LuaSurface");
	surface.attributes = surface.attributes.filter(entry => entry.name !== "has_global_electric_network");
	assert.throws(() => certifyRuntimeApiSchema(schema), /LuaSurface\.has_global_electric_network/);
});
