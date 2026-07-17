"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const moduleRoot = path.join(__dirname, "..", "module");
const files = new Map();

function source(relativePath) {
	if (!files.has(relativePath)) files.set(relativePath, fs.readFileSync(path.join(moduleRoot, relativePath), "utf8"));
	return files.get(relativePath);
}

const domains = [
	{
		id: "entity-prototype",
		status: "static-owned",
		producer: ["export_scanners/entity-scanner.lua", /entity_data\.quality\s*=\s*entity\.quality\.name/],
		consumer: ["core/deserializer.lua", /params\.quality\s*=\s*entity_data\.quality/],
	},
	{
		id: "inventory-stack",
		status: "static-owned",
		producer: ["export_scanners/inventory-scanner.lua", /quality\s*=\s*\(stack\.quality and stack\.quality\.name\)/],
		consumer: ["core/deserializer.lua", /insert_params\.quality\s*=\s*item\.quality/],
	},
	{
		id: "nested-inventory-stack",
		status: "static-owned",
		producer: ["export_scanners/inventory-scanner.lua", /extract_nested_inventory[\s\S]*quality\s*=\s*stack\.quality and stack\.quality\.name/],
		consumer: ["core/deserializer.lua", /restore_nested_inventory[\s\S]*insert_params\.quality\s*=\s*item\.quality/],
	},
	{
		id: "belt-stack",
		status: "static-owned",
		producer: ["export_scanners/inventory-scanner.lua", /extract_belt_items[\s\S]*quality\s*=\s*stack\.quality and stack\.quality\.name/],
		consumer: ["import_phases/belt_restoration.lua", /name\s*=\s*g\.name,\s*count\s*=\s*g\.count,\s*quality\s*=\s*g\.quality/],
	},
	{
		id: "inserter-held-stack",
		status: "static-owned",
		producer: ["export_scanners/inventory-scanner.lua", /extract_inserter_held_item[\s\S]*quality\s*=\s*held_stack\.quality and held_stack\.quality\.name/],
		consumer: ["import_phases/active_state_restoration.lua", /held_stack\.set_stack\(sd\.held_item\)/],
	},
	{
		id: "equipment-grid",
		status: "static-owned",
		producer: ["export_scanners/inventory-scanner.lua", /quality\s*=\s*equip\.quality and equip\.quality\.name/],
		consumer: ["core/deserializer.lua", /grid\.put\(\{[\s\S]*quality\s*=\s*equip_data\.quality/],
	},
	{
		id: "entity-burner-current-fuel",
		status: "static-owned",
		producer: ["export_scanners/entity-handlers.lua", /currently_burning\s*=\s*\{[\s\S]*quality\s*=\s*quality or GameUtils\.QUALITY_NORMAL/],
		consumer: ["core/deserializer.lua", /burner\.currently_burning\s*=\s*\{\s*name\s*=\s*fuel_name,\s*quality\s*=\s*fuel_quality\s*\}/],
	},
	{
		id: "equipment-burner-current-fuel",
		status: "static-owned",
		producer: ["export_scanners/inventory-scanner.lua", /currently_burning\s*=\s*eq_burning_name and \{[\s\S]*quality\s*=\s*eq_burning_quality/],
		consumer: ["core/deserializer.lua", /burner\.currently_burning\s*=\s*\{\s*name\s*=\s*fuel_name,\s*quality\s*=\s*fuel_quality\s*\}/],
	},
	{
		id: "ground-item",
		status: "static-owned",
		producer: ["export_scanners/entity-scanner.lua", /scan_items_on_ground[\s\S]*quality\s*=\s*stack\.quality and stack\.quality\.name/],
		consumer: ["core/deserializer.lua", /local stack\s*=\s*\{\s*name\s*=\s*item_data\.name,\s*count\s*=\s*item_data\.count,\s*quality\s*=\s*item_data\.quality\s*\}/],
	},
	{
		id: "recipe-selection",
		status: "static-owned",
		producer: ["export_scanners/entity-handlers.lua", /local recipe, recipe_quality\s*=\s*entity\.get_recipe\(\)[\s\S]*data\.recipe_quality\s*=\s*recipe_quality\.name/],
		consumer: ["core/deserializer.lua", /entity\.set_recipe\(entity_data\.specific_data\.recipe, entity_data\.specific_data\.recipe_quality\)/],
	},
	{
		id: "previous-recipe",
		status: "static-owned",
		producer: ["export_scanners/entity-handlers.lua", /previous_recipe\s*=\s*\{[\s\S]*quality\s*=\s*entity\.previous_recipe\.quality/],
		consumer: ["core/deserializer.lua", /entity\.previous_recipe\s*=\s*\{[\s\S]*quality\s*=\s*data\.previous_recipe\.quality/],
	},
	{
		id: "inserter-loader-wagon-filter",
		status: "live-pending",
		producer: ["export_scanners/connection-scanner.lua", /extract_entity_filters[\s\S]*quality\s*=\s*filter\.quality and filter\.quality\.name/],
		consumer: ["core/deserializer.lua", /restore_entity_filters[\s\S]*quality\s*=\s*filter\.quality or Util\.QUALITY_NORMAL/],
	},
	{
		id: "constant-combinator-slot",
		status: "live-pending",
		producer: ["export_scanners/connection-scanner.lua", /constant_sections[\s\S]*quality\s*=\s*filter\.quality and filter\.quality\.name/],
		consumer: ["core/deserializer.lua", /section\.set_slot\(filter\.index,\s*\{[\s\S]*quality\s*=\s*filter\.quality/],
	},
	{
		id: "logistic-request-slot",
		status: "static-owned",
		producer: ["export_scanners/connection-scanner.lua", /extract_logistic_requests[\s\S]*quality\s*=\s*request\.quality and request\.quality\.name/],
		consumer: ["core/deserializer.lua", /entity\.set_request_slot\(\{[\s\S]*quality\s*=\s*request\.quality or Util\.QUALITY_NORMAL/],
	},
	{
		id: "infinity-filter",
		status: "static-owned",
		producer: ["export_scanners/connection-scanner.lua", /extract_infinity_filters[\s\S]*quality\s*=\s*filter\.quality and filter\.quality\.name/],
		consumer: ["core/deserializer.lua", /entity\.infinity_container_filters\s*=\s*entity_data\.infinity_filters/],
	},
	{
		id: "splitter-filter",
		status: "static-owned",
		// Defensive both-shapes capture (string at 2.0.77, prototype-safe): resolves sf.quality to a
		// plain string, then falls back to QUALITY_NORMAL.
		producer: ["export_scanners/entity-handlers.lua", /local sf = entity\.splitter_filter[\s\S]*if type\(quality\) ~= "string" and quality then[\s\S]*data\.filter\s*=\s*\{ name = sf\.name, quality = quality or GameUtils\.QUALITY_NORMAL \}/],
		consumer: ["core/deserializer.lua", /field\s*=\s*"filter",\s*prop\s*=\s*"splitter_filter"/],
	},
	// mining-drill-filter row REMOVED (2026-07-17, measured at 2.0.77 + API-confirmed): a mining-drill
	// filter is an EntityID — a resource name with NO quality component — so there is no quality
	// dimension to own here. Every vanilla drill also measures filter_slot_count == 0 (the capture
	// only ever fires for modded drills with filter slots). The original row asserted a quality-keyed
	// {name,quality} shape whose set_filter write the engine rejects ("Invalid EntityID") and whose
	// zero-arg get_filter() capture always threw — see the mining-drill filter entry in
	// docs/factorio-2.0-api-notes.md.
	{
		id: "ghost-and-proxy-requests",
		status: "base-restoration-gap",
		// 2.0 array-of-ItemWithQualityCount capture (the old 1.1 item_with_quality dict iteration
		// crashed serialize_entity on every proxy; replaced 2026-07-17).
		producer: ["export_scanners/entity-handlers.lua", /item_requests[\s\S]*item\s*=\s*req\.name,\s*quality\s*=\s*req\.quality,\s*count\s*=\s*req\.count/],
		consumer: ["core/deserializer.lua", /item_requests is read-only for proxies as well/],
		gap: "request tables are reconstructed but never applied; this is broader than quality alone",
	},
];

test("the quality ownership matrix independently covers every approved item-domain surface", () => {
	assert.deepEqual(domains.map(row => row.id), [
		"entity-prototype", "inventory-stack", "nested-inventory-stack", "belt-stack",
		"inserter-held-stack", "equipment-grid", "entity-burner-current-fuel",
		"equipment-burner-current-fuel", "ground-item", "recipe-selection", "previous-recipe",
		"inserter-loader-wagon-filter", "constant-combinator-slot", "logistic-request-slot",
		"infinity-filter", "splitter-filter", "ghost-and-proxy-requests",
	]);
	// mining-drill-filter is intentionally ABSENT: drill filters are quality-less EntityIDs
	// (measured 2.0.77 + API — see the removed-row comment above and api-notes).
	assert.equal(domains.some(row => row.id.includes("fluid")), false, "fluids have no quality dimension");
});

test("every matrix row is anchored to both its producer and consumer", () => {
	for (const row of domains) {
		const [producerFile, producerPattern] = row.producer;
		const [consumerFile, consumerPattern] = row.consumer;
		assert.match(source(producerFile), producerPattern, `${row.id} producer drifted: ${producerFile}`);
		assert.match(source(consumerFile), consumerPattern, `${row.id} consumer drifted: ${consumerFile}`);
	}
});

test("all non-owned rows state the exact unresolved boundary", () => {
	const unresolved = domains.filter(row => row.status !== "static-owned");
	assert.deepEqual(unresolved.map(row => [row.id, row.status]), [
		["inserter-loader-wagon-filter", "live-pending"],
		["constant-combinator-slot", "live-pending"],
		["ghost-and-proxy-requests", "base-restoration-gap"],
	]);
	for (const row of unresolved.filter(row => row.status.endsWith("gap"))) {
		assert.ok(row.gap && row.gap.length > 20, `${row.id} must explain why it is not owned`);
	}
});

test("the authorized live spot checks remain explicit", () => {
	const liveTargets = domains.filter(row =>
		row.status === "live-pending" || row.id === "splitter-filter")
		.map(row => row.id)
		.sort();
	assert.deepEqual(liveTargets, [
		"constant-combinator-slot",
		"inserter-loader-wagon-filter",
		"splitter-filter",
	]);
	// The mining-drill spot check was RETIRED with its row: the live probe ran 2026-07-17 and
	// refuted the dimension (no quality on EntityID filters; vanilla drills have zero slots).
});

test("the quality-filter roundtrip fixture exercises the splitter domain (drill case retired)", () => {
	const suite = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..",
		"tests", "integration", "entity-roundtrip", "test-cases.json"), "utf8"));
	const fixtures = new Map(suite.tests.map(fixture => [fixture.id, fixture]));
	assert.deepEqual(fixtures.get("splitter-quality-filter").input.specific_data.filter,
		{ name: "iron-plate", quality: "legendary" });
	// mining-drill-quality-filter was DELETED (unpassable): drill filters are quality-less
	// EntityIDs and vanilla drills have zero filter slots — measured 2.0.77, see api-notes.
	assert.equal(fixtures.has("mining-drill-quality-filter"), false,
		"the refuted drill-quality case must stay deleted, not resurrected");

	const roundtrip = source("interfaces/remote/test-import-entity.lua");
	assert.match(roundtrip, /fields_to_compare\s*=\s*\{[\s\S]*"filter"/,
		"entity roundtrip must compare filter payloads instead of treating the fixtures as decorative");
});
