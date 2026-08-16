import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	EXPORT_SCANNER_EXCLUSIONS, assemble, checkControls, classifyTypes, conditionFailure,
	conditionFailures, loadEphemera, luaTable, selectRepresentative,
} from "./derive-universe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = JSON.parse(readFileSync(path.join(here, "universe.json"), "utf8"));

const PLATFORM_VECTOR = { gravity: 0, pressure: 0, "magnetic-field": 0, "solar-power": 100 };

const proto = (name, type, extra = {}) => ({
	n: name, t: type, pl: 0, sc: [], cb: [-0.5, -0.5, 0.5, 0.5], tw: 1, th: 1,
	fb: 0, mi: 0, ivn: 0, ivs: 0, hd: false, ...extra,
});

const REASON = "a reviewed reason long enough to be a reason and not a shrug";

test("an empty Lua table deserializes to no conditions, not to a crash", () => {
	assert.deepEqual(luaTable({}), []);
	assert.deepEqual(luaTable(undefined), []);
	assert.deepEqual(luaTable([{ p: "gravity" }]), [{ p: "gravity" }]);
});

test("a condition failure names the bound AND the measured value", () => {
	const failure = conditionFailure({ p: "gravity", mn: 0.1 }, PLATFORM_VECTOR);
	assert.match(failure, /gravity >= 0\.1/);
	assert.match(failure, /measures 0/, "without the measured value the reason cannot be checked");
	assert.equal(conditionFailure({ p: "pressure", mx: 100 }, { pressure: 4000 }).length > 0, true);
	assert.equal(conditionFailure({ p: "gravity", mn: 0 }, PLATFORM_VECTOR), null);
});

test("a condition on a property the surface does not have FAILS — it does not pass by absence", () => {
	const failure = conditionFailure({ p: "invented-property", mn: 1 }, PLATFORM_VECTOR);
	assert.match(failure, /not a property of the measured surface/);
});

test("selectRepresentative ranks fluidboxes over inventories over slots over module slots", () => {
	const rich = proto("chemical-plant", "assembling-machine", { fb: 4, ivn: 1, ivs: 2, mi: 3 });
	const poor = proto("assembling-machine-1", "assembling-machine", { fb: 0, ivn: 2, ivs: 40, mi: 0 });
	const { row, reason } = selectRepresentative([poor, rich]);
	assert.equal(row.n, "chemical-plant");
	assert.match(reason, /richest of 2/);
	assert.match(reason, /assembling-machine-1/, "the reason must name the runner-up it beat");
});

test("selectRepresentative is deterministic when features tie — the vendored artifact must not churn", () => {
	const a = proto("bbb", "lamp", { ivs: 5 });
	const b = proto("aaa", "lamp", { ivs: 5 });
	assert.equal(selectRepresentative([a, b]).row.n, "aaa");
	assert.equal(selectRepresentative([b, a]).row.n, "aaa");
});

test("a sole candidate says so rather than claiming it beat something", () => {
	const { reason } = selectRepresentative([proto("thruster", "thruster")]);
	assert.match(reason, /the only thruster prototype/);
	assert.doesNotMatch(reason, /ahead of/);
});

test("is_exportable_entity's three types are excluded even when they are buildable", () => {
	const rows = [
		proto("character", "character", { pl: 1 }),
		proto("item-on-ground", "item-entity"),
		proto("spidertron-leg", "spider-leg"),
		proto("lamp", "lamp", { pl: 1 }),
	];
	const { entries, exclusions } = classifyTypes({ rows, propertyVector: PLATFORM_VECTOR, ephemera: [] });
	assert.deepEqual(entries.map(entry => entry.type), ["lamp"]);
	assert.deepEqual(exclusions.map(row => row.type).sort(), [...EXPORT_SCANNER_EXCLUSIONS].sort());
	for (const row of exclusions) assert.equal(row.derivation, "export_scanner");
});

test("a buildable type whose every prototype fails a condition is excluded, and the reason cites it", () => {
	const rows = [proto("wooden-chest", "container", { pl: 1, sc: [{ p: "gravity", mn: 0.1 }] })];
	const { entries, exclusions } = classifyTypes({ rows, propertyVector: PLATFORM_VECTOR, ephemera: [] });
	assert.equal(entries.length, 0);
	assert.equal(exclusions[0].derivation, "surface_conditions");
	assert.match(exclusions[0].reason, /gravity >= 0\.1 but the surface measures 0/);
});

test("a script-only type is in the universe unless the reviewed list excludes it", () => {
	const rows = [proto("character-corpse", "character-corpse"), proto("acid-cloud", "smoke-with-trigger")];
	const { entries, exclusions } = classifyTypes({
		rows, propertyVector: PLATFORM_VECTOR,
		ephemera: [{ type: "smoke-with-trigger", reason: REASON }],
	});
	assert.deepEqual(entries.map(entry => entry.type), ["character-corpse"]);
	assert.equal(entries[0].class, "script_only");
	assert.equal(exclusions[0].derivation, "ephemera");
	assert.equal(exclusions[0].reason, REASON);
});

test("an ephemera entry without a real reason is refused", () => {
	const rows = [proto("acid-cloud", "smoke-with-trigger")];
	assert.throws(() => loadEphemera({ entries: [{ type: "smoke-with-trigger", reason: "meh" }] }, rows),
		/no reason/);
	assert.throws(() => loadEphemera({ entries: [{ type: "smoke-with-trigger" }] }, rows), /no reason/);
});

test("an ephemera entry naming a type that does not exist at the pin is refused", () => {
	assert.throws(() => loadEphemera({ entries: [{ type: "invented-type", reason: REASON }] }, []),
		/does not exist at this pin/);
});

test("an ephemera entry naming a PLAYER-BUILDABLE type is refused — it would shrink the universe silently", () => {
	const rows = [proto("lamp", "lamp", { pl: 1 })];
	assert.throws(() => loadEphemera({ entries: [{ type: "lamp", reason: REASON }] }, rows),
		/PLAYER-BUILDABLE/);
});

test("an ephemera entry that duplicates an is_exportable_entity exclusion is refused", () => {
	const rows = [proto("item-on-ground", "item-entity")];
	assert.throws(() => loadEphemera({ entries: [{ type: "item-entity", reason: REASON }] }, rows),
		/already excluded by is_exportable_entity/);
});

test("checkControls refuses a universe that lost character-corpse — the founding blind spot", () => {
	const artifact = {
		counts: {
			types: 132, player_buildable: 61, script_only: 23, universe: 84,
			excluded_ephemera: 18,
		},
		entries: [{ type: "lamp", representative: "small-lamp", representative_reason: "r" }],
		exclusions: EXPORT_SCANNER_EXCLUSIONS.map(type => ({ type, derivation: "export_scanner", reason: "r" })),
	};
	const failures = checkControls(artifact);
	assert.equal(failures.some(failure => /character-corpse/.test(failure)), true);
});

test("checkControls refuses every count that drifts, naming the measured control", () => {
	const base = {
		counts: { types: 132, player_buildable: 61, script_only: 23, universe: 84, excluded_ephemera: 18 },
		entries: [{ type: "character-corpse", representative: "character-corpse", representative_reason: "r" }],
		exclusions: EXPORT_SCANNER_EXCLUSIONS.map(type => ({ type, derivation: "export_scanner", reason: "r" })),
	};
	assert.deepEqual(checkControls(base), []);
	for (const [key, control] of [["types", 132], ["player_buildable", 61], ["script_only", 23],
		["universe", 84], ["excluded_ephemera", 18]]) {
		const drifted = { ...base, counts: { ...base.counts, [key]: control + 1 } };
		const failures = checkControls(drifted);
		assert.equal(failures.length, 1, `${key} drifted by one and no control fired`);
		assert.match(failures[0], new RegExp(`^${key} derived ${control + 1}, the measured control is ${control}`));
	}
});

test("checkControls refuses an entry with no representative and an exclusion with no reason", () => {
	const base = {
		counts: { types: 132, player_buildable: 61, script_only: 23, universe: 84, excluded_ephemera: 18 },
		entries: [{ type: "character-corpse", representative: "character-corpse", representative_reason: "r" },
			{ type: "lamp" }],
		exclusions: [...EXPORT_SCANNER_EXCLUSIONS.map(type => ({ type, derivation: "export_scanner", reason: "r" })),
			{ type: "tree", derivation: "ephemera" }],
	};
	const failures = checkControls(base);
	assert.equal(failures.some(f => /lamp entered the universe with no representative/.test(f)), true);
	assert.equal(failures.some(f => /tree was excluded with no reason/.test(f)), true);
});

test("assemble counts every exclusion derivation, and the classes partition the type set", () => {
	const rows = [
		proto("lamp", "lamp", { pl: 1 }),
		proto("wooden-chest", "container", { pl: 1, sc: [{ p: "gravity", mn: 0.1 }] }),
		proto("acid-cloud", "smoke-with-trigger"),
		proto("character-corpse", "character-corpse"),
		proto("item-on-ground", "item-entity"),
	];
	const artifact = assemble({
		dump: { rows, props: PLATFORM_VECTOR, version: "2.1.11", mods: {} },
		ephemeraRaw: { entries: [{ type: "smoke-with-trigger", reason: REASON }] },
	});
	assert.equal(artifact.counts.types, 5);
	assert.equal(artifact.counts.universe + artifact.counts.excluded, artifact.counts.types);
	assert.equal(artifact.counts.player_buildable + artifact.counts.script_only, artifact.counts.universe);
	assert.equal(artifact.counts.excluded_surface_conditions, 1);
	assert.equal(artifact.counts.excluded_ephemera, 1);
	assert.equal(artifact.counts.excluded_export_scanner, 1);
});

test("the VENDORED universe.json still passes its own controls", () => {
	assert.deepEqual(checkControls(VENDORED), []);
	assert.equal(VENDORED.counts.universe, VENDORED.entries.length);
	assert.equal(VENDORED.counts.excluded, VENDORED.exclusions.length);
});

test("the vendored artifact carries a footprint and features for every universe entry", () => {
	for (const entry of VENDORED.entries) {
		assert.equal(typeof entry.footprint.tile_width, "number", `${entry.type} has no tile_width`);
		assert.equal(entry.footprint.collision_box.length, 4, `${entry.type} has no collision box`);
		assert.equal(typeof entry.features.fluidboxes, "number", `${entry.type} has no feature counts`);
	}
});

test("every vendored exclusion carries a reason that is not the type name restated", () => {
	for (const row of VENDORED.exclusions) {
		assert.equal(row.reason.trim().length > 20, true, `${row.type} has a stub reason`);
		assert.equal(["export_scanner", "surface_conditions", "ephemera"].includes(row.derivation), true);
	}
});

test("no type is both in the universe and excluded", () => {
	const universe = new Set(VENDORED.entries.map(entry => entry.type));
	for (const row of VENDORED.exclusions) {
		assert.equal(universe.has(row.type), false, `${row.type} is classified twice`);
	}
});

test("conditionFailures reports every failing condition, not just the first", () => {
	const row = proto("x", "y", { sc: [{ p: "gravity", mn: 1 }, { p: "pressure", mn: 1000 }] });
	assert.equal(conditionFailures(row, PLATFORM_VECTOR).length, 2);
});
