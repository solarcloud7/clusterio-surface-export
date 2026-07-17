import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const EXPECTED_RUNTIME_API_SHA256 = "594b4ec98cc5fbee322d7380db49a388ab38b0d69c06f00ead877cffbb37f578";

export function certifyRuntimeApiSchema(schema) {
	if (schema.application_version !== "2.0.77") throw new Error(`expected Factorio 2.0.77, got ${schema.application_version}`);
	const classes = new Map(schema.classes.map(entry => [entry.name, entry]));
	const requiredMethods = {
		LuaGameScript: ["create_surface", "delete_surface", "server_save"],
		LuaSurface: ["create_entity", "find_entity", "set_tiles", "delete_chunk", "get_property", "find_non_colliding_position", "can_place_entity", "find_entities_filtered"],
		LuaForce: ["add_chart_tag", "chart", "find_chart_tags", "create_space_platform"],
		LuaSpacePlatform: ["apply_starter_pack", "destroy"],
		LuaEntity: ["destroy", "get_max_transport_line_index", "get_transport_line"],
		LuaControl: ["get_inventory"],
		LuaInventory: ["get_item_count", "insert"],
		LuaTransportLine: ["get_detailed_contents"],
		LuaRendering: ["draw_text", "get_all_objects"],
		LuaRenderObject: ["destroy"],
		LuaCustomChartTag: ["destroy"],
	};
	for (const [className, methods] of Object.entries(requiredMethods)) {
		const apiClass = classes.get(className);
		if (!apiClass) throw new Error(`missing ${className}`);
		for (const method of methods) if (!apiClass.methods.some(entry => entry.name === method)) throw new Error(`missing ${className}.${method}`);
	}
	const requiredAttributes = {
		LuaGameScript: ["surfaces"],
		LuaSurface: ["platform", "planet", "map_gen_settings", "generate_with_lab_tiles", "has_global_electric_network", "ignore_surface_conditions"],
		LuaForce: ["platforms"],
		LuaSpacePlatform: ["surface", "paused", "name", "valid"],
		LuaEntity: ["loader_type", "valid", "fluidbox", "mining_target", "name"],
	};
	for (const [className, attributes] of Object.entries(requiredAttributes)) {
		const apiClass = classes.get(className);
		for (const attribute of attributes) {
			if (!apiClass.attributes.some(entry => entry.name === attribute)) throw new Error(`missing ${className}.${attribute}`);
		}
	}
	const mapGen = schema.concepts?.find(entry => entry.name === "MapGenSettings");
	const mapGenFields = new Set(mapGen?.type?.parameters?.map(entry => entry.name));
	for (const field of ["default_enable_all_autoplace_controls", "width", "height"]) {
		if (!mapGenFields.has(field)) throw new Error(`missing MapGenSettings.${field}`);
	}
	return { version: schema.application_version, behaviorScope: "signatures-only" };
}

export function certifyRuntimeApiFile(path) {
	const raw = readFileSync(path);
	const sha256 = createHash("sha256").update(raw).digest("hex");
	if (sha256 !== EXPECTED_RUNTIME_API_SHA256) throw new Error(`runtime API SHA-256 changed: ${sha256}`);
	const result = certifyRuntimeApiSchema(JSON.parse(raw));
	return { ...result, sha256 };
}
