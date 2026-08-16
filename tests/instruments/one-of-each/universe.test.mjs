import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	EXPORT_SCANNER_EXCLUSIONS, RAIL_TYPES, ROLLING_STOCK_TYPES, assemble, checkControls,
	checkRailTaxonomy, classifyTypes, conditionFailure, conditionFailures, loadBonusInclusions,
	loadEphemera, loadTransientAnnex, luaTable, railBuildability, selectRepresentative,
} from "./derive-universe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VENDORED = JSON.parse(readFileSync(path.join(here, "universe.json"), "utf8"));

const PLATFORM_VECTOR = { gravity: 0, pressure: 0, "magnetic-field": 0, "solar-power": 100 };

const proto = (name, type, extra = {}) => ({
	n: name, t: type, pl: 0, sc: [], cb: [-0.5, -0.5, 0.5, 0.5], tw: 1, th: 1,
	fb: 0, mi: 0, ivn: 0, ivs: 0, hd: false, ...extra,
});

const REASON = "a reviewed reason long enough to be a reason and not a shrug";
const MEASUREMENT = "valid on the creating tick 31874068, absent from an area census 38 ticks later";

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

test("is_exportable_entity's four types are excluded even when they are buildable", () => {
	const rows = [
		proto("character", "character", { pl: 1 }),
		proto("item-on-ground", "item-entity"),
		proto("big-demolisher-segment-x0_65", "segment"),
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

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
	"ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
	"nineteen", "twenty", "twenty-one", "twenty-two", "twenty-three", "twenty-four", "twenty-five"];

test("the ephemera note's stated total is the number of entries it actually describes", () => {
	const raw = JSON.parse(readFileSync(path.join(here, "ephemera-exclusions.json"), "utf8"));
	const stated = /of these ([\w-]+) types/.exec(raw.measured.note);
	assert.ok(stated, "the note no longer states its total as 'of these <word> types'");
	assert.equal(stated[1], NUMBER_WORDS[raw.entries.length],
		`the note says "${stated[1]}" but the list holds ${raw.entries.length} entries — loadEphemera reads `
		+ "only type and reason, so a stale total in a MEASURED block survives every other check");
});

const CONTROL_COUNTS = {
	types: 132, player_buildable: 60, script_only: 20, bonus: 2, universe: 82,
	excluded: 50, excluded_ephemera: 17, excluded_transient_annex: 3,
};

test("checkControls refuses a universe that lost character-corpse — the founding blind spot", () => {
	const artifact = {
		counts: { ...CONTROL_COUNTS },
		entries: [{ type: "lamp", representative: "small-lamp", representative_reason: "r" }],
		exclusions: EXPORT_SCANNER_EXCLUSIONS.map(type => ({ type, derivation: "export_scanner", reason: "r" })),
	};
	const failures = checkControls(artifact);
	assert.equal(failures.some(failure => /character-corpse/.test(failure)), true);
});

test("checkControls refuses every count that drifts, naming the measured control", () => {
	const base = {
		counts: { ...CONTROL_COUNTS },
		entries: [{ type: "character-corpse", representative: "character-corpse", representative_reason: "r" }],
		exclusions: EXPORT_SCANNER_EXCLUSIONS.map(type => ({ type, derivation: "export_scanner", reason: "r" })),
	};
	assert.deepEqual(checkControls(base), []);
	// The partition identity (universe + excluded == types) is its own control, so each drift here
	// compensates it — otherwise a one-count drift would fire two controls and prove neither.
	const compensation = { types: { excluded: 1 }, universe: { excluded: -1 } };
	for (const [key, control] of Object.entries(CONTROL_COUNTS).filter(([name]) => name !== "excluded")) {
		const counts = { ...base.counts, [key]: control + 1 };
		for (const [other, delta] of Object.entries(compensation[key] || {})) counts[other] += delta;
		const failures = checkControls({ ...base, counts });
		assert.equal(failures.length, 1, `${key} drifted by one and fired ${failures.length} control(s)`);
		assert.match(failures[0], new RegExp(`^${key} derived ${control + 1}, the measured control is ${control}`));
	}
});

test("checkControls refuses a classification that loses or doubles a type, which no count catches", () => {
	const base = {
		counts: { ...CONTROL_COUNTS },
		entries: [{ type: "character-corpse", representative: "character-corpse", representative_reason: "r" }],
		exclusions: EXPORT_SCANNER_EXCLUSIONS.map(type => ({ type, derivation: "export_scanner", reason: "r" })),
	};
	const failures = checkControls({ ...base, counts: { ...base.counts, excluded: 49 } });
	assert.equal(failures.length, 1, "a partition that does not add up must fire exactly the identity control");
	assert.match(failures[0], /universe 82 \+ excluded 49 is not the 132 types/);
});

test("checkControls refuses an entry with no representative and an exclusion with no reason", () => {
	const base = {
		counts: { ...CONTROL_COUNTS },
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
		assert.equal(["export_scanner", "surface_conditions", "rail_dependency", "ephemera", "transient_annex"]
			.includes(row.derivation), true);
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

test("the representative is the RICHEST placeable prototype even when it is surface-illegal", () => {
	const rows = [
		proto("bottomless-chest", "container", { pl: 1, ivn: 1, ivs: 1 }),
		proto("steel-chest", "container", { pl: 1, ivn: 1, ivs: 48, sc: [{ p: "gravity", mn: 0.1 }] }),
	];
	const { entries } = classifyTypes({ rows, propertyVector: PLATFORM_VECTOR, ephemera: [] });
	assert.equal(entries[0].representative, "steel-chest");
	assert.equal(entries[0].representative_surface_legal, false);
	assert.deepEqual(entries[0].representative_surface_conditions,
		["gravity >= 0.1 but the surface measures 0"]);
	assert.match(entries[0].representative_reason, /regardless of surface legality/);
	assert.match(entries[0].representative_reason, /gravity >= 0\.1 but the surface measures 0/,
		"the reason must carry the condition it knowingly broke, or the choice cannot be reviewed");
});

test("a type with no surface-legal prototype at all stays excluded — widening choice is not widening membership", () => {
	const rows = [proto("locomotive", "locomotive", { pl: 1, sc: [{ p: "gravity", mn: 1 }] })];
	const { entries, exclusions } = classifyTypes({ rows, propertyVector: PLATFORM_VECTOR, ephemera: [] });
	assert.deepEqual(entries, []);
	assert.equal(exclusions[0].derivation, "surface_conditions");
});

test("on an exact feature TIE the surface-legal candidate keeps the cell", () => {
	const legal = proto("simple-entity-with-owner", "simple-entity-with-owner", { pl: 1 });
	const illegal = proto("aaa-mod-collision-box", "simple-entity-with-owner",
		{ pl: 1, sc: [{ p: "pressure", mn: 200000 }] });
	const { entries } = classifyTypes({
		rows: [illegal, legal], propertyVector: PLATFORM_VECTOR, ephemera: [],
	});
	assert.equal(entries[0].representative, "simple-entity-with-owner",
		"an alphabetical tie-break would take the mod's collision placeholder, which is not RICHER by any feature");
	assert.equal(entries[0].representative_surface_legal, true);
	assert.equal(selectRepresentative([illegal, legal], new Set(["simple-entity-with-owner"])).row.n,
		"simple-entity-with-owner");
	assert.equal(selectRepresentative([illegal, legal]).row.n, "aaa-mod-collision-box",
		"without a preference the tie-break is still alphabetical");
});

test("a bonus inclusion carries a surface-illegal type into the universe, with its own class and reason", () => {
	const rows = [proto("straight-rail", "straight-rail", { pl: 1, sc: [{ p: "gravity", mn: 1 }] })];
	const { entries, exclusions } = classifyTypes({
		rows, propertyVector: PLATFORM_VECTOR, ephemera: [],
		bonus: [{ type: "straight-rail", reason: REASON }],
	});
	assert.deepEqual(exclusions, []);
	assert.equal(entries[0].class, "bonus");
	assert.equal(entries[0].representative_surface_legal, false);
	assert.match(entries[0].representative_reason, new RegExp(REASON));
});

test("a bonus inclusion is refused when it is redundant, unplaceable, unknown, or unreasoned", () => {
	const legal = [proto("lamp", "lamp", { pl: 1 })];
	const illegal = [proto("straight-rail", "straight-rail", { pl: 1, sc: [{ p: "gravity", mn: 1 }] })];
	const scriptOnly = [proto("cliff", "cliff")];
	assert.throws(() => loadBonusInclusions({ entries: [{ type: "lamp", reason: REASON }] }, legal, PLATFORM_VECTOR),
		/already platform-legal/);
	assert.throws(() => loadBonusInclusions({ entries: [{ type: "cliff", reason: REASON }] }, scriptOnly,
		PLATFORM_VECTOR), /no placeable prototype/);
	assert.throws(() => loadBonusInclusions({ entries: [{ type: "nope", reason: REASON }] }, illegal,
		PLATFORM_VECTOR), /does not exist at this pin/);
	assert.throws(() => loadBonusInclusions({ entries: [{ type: "straight-rail", reason: "meh" }] }, illegal,
		PLATFORM_VECTOR), /no reason/);
});

const wagon = extra => proto("infinity-cargo-wagon", "infinity-cargo-wagon", { pl: 1, ...extra });
const blockedRail = proto("straight-rail", "straight-rail", { pl: 1, sc: [{ p: "gravity", mn: 1 }] });
const openRail = proto("straight-rail", "straight-rail", { pl: 1 });

test("rolling stock whose OWN conditions pass is still not player-buildable where no rail is", () => {
	const { entries, exclusions } = classifyTypes({
		rows: [wagon(), blockedRail], propertyVector: PLATFORM_VECTOR, ephemera: [],
	});
	assert.deepEqual(entries, [], "empty surface_conditions is not a build route when the rail under it is blocked");
	const refused = exclusions.find(row => row.type === "infinity-cargo-wagon");
	assert.equal(refused.derivation, "rail_dependency");
	assert.match(refused.reason, /1 rail type\(s\) at this pin is placeable here/);
	assert.match(refused.reason, /gravity >= 1 but the surface measures 0/,
		"the reason must carry the rail's own failure, or the exclusion cannot be audited");
	assert.match(refused.reason, /0 placeable for rolling stock/);
	assert.match(refused.reason, /NOT isolated/,
		"#248 measured the block and did not isolate its cause — the derivation must not invent one");
	assert.doesNotMatch(refused.reason, /all 1 placeable/,
		"the surface_conditions reason would be false here: this prototype fails no condition of its own");
});

test("the SAME rolling stock IS player-buildable where a rail is placeable — the rule is a dependency", () => {
	const { entries, exclusions } = classifyTypes({
		rows: [wagon(), openRail], propertyVector: PLATFORM_VECTOR, ephemera: [],
	});
	assert.deepEqual(exclusions, []);
	assert.equal(entries.find(entry => entry.type === "infinity-cargo-wagon").class, "player_buildable");
});

test("the rail dependency is scoped to rolling stock — nothing else loses its class when rail is blocked", () => {
	const { entries } = classifyTypes({
		rows: [proto("lamp", "lamp", { pl: 1 }), blockedRail], propertyVector: PLATFORM_VECTOR, ephemera: [],
	});
	assert.equal(entries.find(entry => entry.type === "lamp").class, "player_buildable");
});

test("rolling stock that fails its OWN conditions keeps the surface_conditions derivation", () => {
	const { exclusions } = classifyTypes({
		rows: [proto("locomotive", "locomotive", { pl: 1, sc: [{ p: "gravity", mn: 1 }] }), blockedRail],
		propertyVector: PLATFORM_VECTOR, ephemera: [],
	});
	assert.equal(exclusions.find(row => row.type === "locomotive").derivation, "surface_conditions",
		"a type its own conditions already exclude must not be re-labelled with a dependency it never reached");
});

test("railBuildability reports the rail types it checked and the failures it found", () => {
	const blocked = railBuildability([wagon(), blockedRail], PLATFORM_VECTOR);
	assert.equal(blocked.buildable, false);
	assert.deepEqual(blocked.types, ["straight-rail"], "the wagon is not a rail and must not be counted as one");
	assert.deepEqual(blocked.failures, ["gravity >= 1 but the surface measures 0"]);
	assert.equal(railBuildability([openRail], PLATFORM_VECTOR).buildable, true);
	assert.equal(railBuildability([wagon()], PLATFORM_VECTOR).buildable, false,
		"no rail prototype at all is not a rail a player can lay");
});

const taxonomyRows = () => [...ROLLING_STOCK_TYPES, ...RAIL_TYPES].map(type => proto(type, type, { pl: 1 }));

test("checkRailTaxonomy refuses a pin that lost a rolling-stock or rail type, rather than disarming", () => {
	assert.equal(checkRailTaxonomy(taxonomyRows()), undefined);
	for (const gone of ["infinity-cargo-wagon", "straight-rail"]) {
		assert.throws(() => checkRailTaxonomy(taxonomyRows().filter(row => row.t !== gone)),
			new RegExp(`\\[${gone}\\] are named as rolling stock or rail but do not exist`));
	}
});

test("a bonus inclusion carries a rolling-stock type only while the rail under it is blocked", () => {
	const raw = { entries: [{ type: "infinity-cargo-wagon", reason: REASON }] };
	assert.deepEqual(loadBonusInclusions(raw, [wagon(), blockedRail], PLATFORM_VECTOR),
		[{ type: "infinity-cargo-wagon", reason: REASON }]);
	assert.throws(() => loadBonusInclusions(raw, [wagon(), openRail], PLATFORM_VECTOR),
		/already platform-legal/,
		"once a player can lay rail the derivation carries the wagon itself, and the override must go");
});

test("an annexed type leaves the universe as its own derivation, carrying the measurement that annexed it", () => {
	const rows = [proto("asteroid", "asteroid"), proto("character-corpse", "character-corpse")];
	const { entries, exclusions } = classifyTypes({
		rows, propertyVector: PLATFORM_VECTOR, ephemera: [],
		annex: [{ type: "asteroid", reason: REASON, measurement: MEASUREMENT }],
	});
	assert.deepEqual(entries.map(entry => entry.type), ["character-corpse"]);
	assert.equal(exclusions[0].derivation, "transient_annex");
	assert.equal(exclusions[0].measurement, MEASUREMENT);
});

test("an annex entry with no MEASUREMENT is refused — the annex is a measured despawn, not a prediction", () => {
	const rows = [proto("asteroid", "asteroid"), proto("lamp", "lamp", { pl: 1 })];
	assert.throws(() => loadTransientAnnex({ entries: [{ type: "asteroid", reason: REASON }] }, rows),
		/carries no measurement/);
	assert.throws(() => loadTransientAnnex({
		entries: [{ type: "asteroid", reason: REASON, measurement: "short" }],
	}, rows), /carries no measurement/);
	assert.throws(() => loadTransientAnnex({
		entries: [{ type: "lamp", reason: REASON, measurement: MEASUREMENT }],
	}, rows), /PLAYER-BUILDABLE/);
});

test("a type in both the reviewed ephemera list and the annex is refused, not silently double-reasoned", () => {
	const rows = [proto("acid-cloud", "smoke-with-trigger")];
	assert.throws(() => assemble({
		dump: { rows, props: PLATFORM_VECTOR, version: "2.1.11", mods: {} },
		ephemeraRaw: { entries: [{ type: "smoke-with-trigger", reason: REASON }] },
		annexRaw: { entries: [{ type: "smoke-with-trigger", reason: REASON, measurement: MEASUREMENT }] },
	}), /both the reviewed ephemera list and the transient annex/);
});

test("the vendored artifact records the legality of every representative it chose", () => {
	for (const entry of VENDORED.entries) {
		assert.equal(typeof entry.representative_surface_legal, "boolean",
			`${entry.type} does not say whether its representative is surface-legal`);
		assert.equal(Array.isArray(entry.representative_surface_conditions), true);
		assert.equal(entry.representative_surface_legal,
			entry.representative_surface_conditions.length === 0,
			`${entry.type} disagrees with itself about surface legality`);
	}
	const illegal = VENDORED.entries.filter(entry => !entry.representative_surface_legal);
	assert.ok(illegal.length > 0, "the whole point of the unconditional rule is that some winner is illegal");
	assert.ok(illegal.some(entry => entry.type === "container" && entry.representative === "steel-chest"),
		"container must carry a real chest, not the 1-slot bottomless-chest the surface-legal filter left");
});

test("the vendored annex holds exactly the three transients, each with a measurement", () => {
	const annexed = VENDORED.exclusions.filter(row => row.derivation === "transient_annex");
	assert.deepEqual(annexed.map(row => row.type).sort(),
		["asteroid", "capture-robot", "temporary-container"]);
	for (const row of annexed) {
		assert.equal(typeof row.measurement, "string");
		assert.match(row.measurement, /tick/, `${row.type} annexed without citing when it went`);
	}
});

test("the vendored universe carries the rail and the wagon that rides it as its two bonus members", () => {
	const bonus = VENDORED.entries.filter(entry => entry.class === "bonus");
	assert.deepEqual(bonus.map(entry => entry.type), ["infinity-cargo-wagon", "straight-rail"]);
	assert.equal(VENDORED.counts.bonus, 2);
	assert.equal(VENDORED.counts.player_buildable + VENDORED.counts.script_only + VENDORED.counts.bonus,
		VENDORED.counts.universe);
});

test("the vendored wagon is NOT player_buildable, and says why without inventing the cause", () => {
	const wagon = VENDORED.entries.find(entry => entry.type === "infinity-cargo-wagon");
	assert.equal(wagon.class, "bonus",
		"empty surface_conditions plus items_to_place_this once read as player-buildable, and 0/4350 says it is not");
	assert.equal(wagon.representative_surface_legal, true,
		"its OWN conditions do pass — that field means the prototype's conditions, not the rail under it");
	assert.match(wagon.representative_reason, /0 placeable for infinity-cargo-wagon/);
	assert.match(wagon.representative_reason, /NOT isolated/,
		"the residual cause beyond rail's own surface conditions was never isolated (#248)");
	assert.match(wagon.representative_reason, /build_check_type\.manual is the ONLY route that sweep measured/,
		"the sweep ran one build route, so the reason must scope its claim to that route");
	assert.match(wagon.representative_reason, /revival routes[^.]*UNMEASURED/,
		"the routes the sweep never ran must be named unmeasured rather than covered by silence");
	assert.doesNotMatch(wagon.representative_reason, /no player or bot route/i,
		"the retracted overclaim: a build_check_type.manual sweep is not evidence about bot revival");
	assert.equal(VENDORED.entries.some(entry => entry.type === "infinity-cargo-wagon"), true,
		"the fixture still stages the wagon on its rail segment — reclassifying must not drop the cell");
});
