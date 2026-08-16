"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const moduleRoot = path.join(__dirname, "..", "module");
const files = new Map();

const galleryManifestPath = path.join(__dirname, "..", "..", "..", "..", "..",
	"tests", "lab-gallery", "manifest.json");
const repoSkip = fs.existsSync(galleryManifestPath)
	? false
	: `repo checkout not mounted here (looked for ${galleryManifestPath}) — run from the repo, as CI does`;

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
		consumer: ["import_phases/belt_restoration.lua",
			/insert_with_state\([\s\S]{0,120}name\s*=\s*slot\.n,\s*quality\s*=\s*slot\.q,\s*count\s*=\s*slot\.ct/],
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
		id: "inserter-loader-wagon-filter",
		status: "live-pending",
		producer: ["export_scanners/connection-scanner.lua", /extract_entity_filters[\s\S]*quality\s*=\s*filter\.quality and filter\.quality\.name/],
		consumer: ["core/deserializer.lua", /function restore_slot_filters[\s\S]*quality\s*=\s*filter\.quality or Util\.QUALITY_NORMAL[\s\S]*function Deserializer\.restore_entity_filters[\s\S]*restore_slot_filters\(entity, entity_data\)/],
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
		producer: ["export_scanners/connection-scanner.lua", /extract_logistic_sections[\s\S]*?quality\s*=\s*filter\.value\.quality/],
		consumer: ["core/deserializer.lua", /restore_logistic_sections[\s\S]*?local slot = \{ value = f\.value, min = f\.min, max = f\.max[\s\S]{0,200}?section\.set_slot\(f\.index, slot\)/],
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
		producer: ["export_scanners/entity-handlers.lua", /local sf = entity\.splitter_filter[\s\S]*if type\(quality\) ~= "string" and quality then[\s\S]*data\.filter\s*=\s*\{ name = sf\.name, quality = quality or GameUtils\.QUALITY_NORMAL \}/],
		consumer: ["core/deserializer.lua", /field\s*=\s*"filter",\s*prop\s*=\s*"splitter_filter"/],
	},
	{
		id: "ghost-and-proxy-requests",
		status: "static-owned",
		producer: ["export_scanners/entity-handlers.lua",
			/EntityHandlers\["entity-ghost"\][\s\S]{0,300}?data\.insert_plan\s*=\s*entity\.insert_plan(?![\w.])/],
		consumer: ["core/deserializer.lua",
			/if entity\.type == "entity-ghost" then[\s\S]{0,200}?entity\.insert_plan = data\.insert_plan(?![\w.])/],
	},
];

test("the quality ownership matrix independently covers every approved item-domain surface", () => {
	assert.deepEqual(domains.map(row => row.id), [
		"entity-prototype", "inventory-stack", "nested-inventory-stack", "belt-stack",
		"inserter-held-stack", "equipment-grid", "entity-burner-current-fuel",
		"equipment-burner-current-fuel", "ground-item", "recipe-selection",
		"inserter-loader-wagon-filter", "constant-combinator-slot", "logistic-request-slot",
		"infinity-filter", "splitter-filter", "ghost-and-proxy-requests",
	]);
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
});

test("the logistic-request-slot physical evidence stays pinned to the sections suite", { skip: repoSkip }, () => {
	const suiteSource = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..",
		"tests", "integration", "hub-request-sections", "run-tests.mjs"), "utf8");
	assert.match(suiteSource, /quality='rare'/,
		"the fixture must keep writing a rare-quality request slot");
	assert.match(suiteSource, /quality === "rare"/,
		"the destination re-read must keep asserting the non-normal (rare) slot quality");
});

test("the ghost-and-proxy-requests physical evidence stays pinned to the ghost suite", { skip: repoSkip }, () => {
	const suiteSource = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..",
		"tests", "integration", "ghost-item-requests", "run-tests.mjs"), "utf8");
	assert.match(suiteSource, /id=\{name='[^']+',quality='uncommon'\}/,
		"the fixture must keep arming a ghost with a non-normal quality request, and the quality must "
		+ "ride inside the plan entry's id: insert_plan[].id.quality is the only place a pending "
		+ "request's quality exists, and the capture is wholesale, so this fixture shape is what makes "
		+ "the producer anchor's rejection of a projecting capture mean anything");
	assert.match(suiteSource, /requestsOf\(dstGhostA\) === EXPECT_A/,
		"the destination re-read must keep adjudicating the ghost's own item_requests");
	assert.match(suiteSource, /CONTROL: the item-request-proxy's requests arrive intact/,
		"the proxy control arm must stay, or a red ghost cannot be told from a broken probe");
});

test("the splitter-quality-filter law lives on the adversarial pad (entity-roundtrip retired)", { skip: repoSkip }, () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "..",
		"tests", "lab-gallery", "manifest.json"), "utf8"));
	const pad = manifest.fixtures.find(fixture => fixture.id === "omnibus-adversarial-inventory");
	assert.equal(pad.fingerprint.splitterFilter, "iron-plate");
	assert.equal(pad.fingerprint.splitterFilterQuality, "legendary");
	assert.ok(pad.anchors.some(anchor => anchor.entity === "splitter"),
		"the pad must anchor the filtered splitter so the meter can resolve it");
});
