#!/usr/bin/env node
// Hub request sections — the platform's pending item requests must survive a transfer.
//
// WHAT THIS PROTECTS. A player's hub requests (the hub GUI "Requests" tab) are MANUAL logistic
// sections on the hub's requester logistic point. They are settings, not items, so the exact gate
// is structurally blind to them — the same silent-loss class as the infinity-pipe filter
// (2026-07-26) and chest slot filters (2026-07-18). Before the sections serializer landed
// (2026-08-04) every transfer silently dropped them — and requester-chest requests were ALSO lost
// on this pin (the pre-sections logistic_requests path reads request_slot_count, which does not
// exist on 2.1.11), so a requester chest is part of this fixture too.
//
// WHY SECTIONS AND NOT ITEM-REQUEST-PROXIES. Measured 2.1.11 (2026-08-04, live probes; standing
// assert: tests/instruments/engine-invariants hub-proxy-annihilation): a hub-targeted
// item-request-proxy is destroyed BY THE ENGINE within a tick of creation — paused or unpaused,
// frozen hub or not — and its request is annihilated. It cannot exist as persistent state, so it
// can never be exported or restored; manual sections are the only persistent form a pending hub
// request takes.
//
// INDEPENDENT MEASUREMENTS, deliberately separate so each failure names its half:
//   payload.*  — testkit exportInspect: is `logistic_sections` ON THE PAYLOAD record?
//                (export-side serializer omission — presence is necessary, never sufficient)
//   dest.*     — a REAL production transfer, then a PHYSICAL read of the destination's sections
//                (restore-side; the only thing that proves survival)
//   guards.*   — malformed logistic_sections field shapes must be skipped LOUDLY, never thrown
//                (an uncaught throw in the on_tick import driver kills the headless server)
//   refusal.*  — a gate-refused transfer discards the destination AND sweeps the force-level
//                logistic groups the import created (a group outlives its sections, so failed
//                attempts would otherwise accumulate orphan groups on the destination force)
//
// The fixture is adversarial on purpose: a slot-index GAP (slots 1 and 3, 2 empty), min+max,
// import_from, a GROUPED section with non-default multiplier and active=false, a RARE-quality
// request and a `≥`-comparator quality filter on a requester chest, and TWO adoption cases —
// group names are FORCE-level shared state on the destination, and add_section(<existing group>)
// ADOPTS the existing filters (measured 2.1.11), so the restore must never write payload filters
// into a group that pre-existed, whether populated OR empty (an empty group can be a placeholder
// other platforms reference). Group names are unique per run so stale groups from a previous run
// cannot make the adoption asserts vacuously green.
//
// CLEANUP IS UNCONDITIONAL (evacuation-coverage pattern): the finally block sweeps probe-named
// platforms on BOTH hosts (unlock best-effort first), deletes every run-unique logistic group,
// disarms the refusal hook, and restores host-2's debug_mode to its pre-test value. The
// `hub-req-sections-` prefix is in cleanup-test-surfaces.ps1's sweep list as the backstop — that
// sweeper removes both prefix-matched platforms AND prefix-matched logistic groups.

import {
	lua, rcon, instanceIds, createBatchLifecycle,
} from "../../lab-gallery/batch-lifecycle.mjs";
import { exportInspect } from "../../../tools/tests/testkit/export-inspect.mjs";

const RUN_TAG = Date.now().toString(36);
const PROBE = `hub-req-sections-${RUN_TAG}`;
const PROBE_FAIL = `hub-req-sections-refusal-${RUN_TAG}`;
const GROUP = `hub-req-sections-group-${RUN_TAG}`;
// Pre-created on the DESTINATION force, POPULATED: the restored section must join it and carry
// the destination's filters, not the payload's.
const GROUP_PREEXISTING = `hub-req-sections-adopt-${RUN_TAG}`;
// Pre-created on the DESTINATION force, EMPTY: a placeholder group other platforms may reference.
// The restore must join it WITHOUT writing the payload's filters into it — filters_count cannot
// distinguish "just created" from "exists, empty", so the restore checks the force's group
// registry instead (review finding).
const GROUP_ADOPT_EMPTY = `hub-req-sections-adopt-empty-${RUN_TAG}`;
// Carried by the refusal-leg platform: the failed import must sweep it from the destination force.
const GROUP_FAIL = `hub-req-sections-fail-${RUN_TAG}`;
const ALL_GROUPS = [GROUP, GROUP_PREEXISTING, GROUP_ADOPT_EMPTY, GROUP_FAIL];

const L = createBatchLifecycle({
	// Golden saves are NOT used (no loadGoldenPair call — the probe platforms are throwaway on the
	// live pair); the factory just needs non-empty names, and marker/wait are the bound helpers.
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip",
	markerPrefix: "hub-req-sections",
});

// An EMPTY Lua table serializes as `{}` (object), a populated array-like one as `[...]` — the
// numeric-key coercion class. Normalize both shapes before iterating.
const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

// Lua snippet: dump the MANUAL sections of every logistic point on one entity of the named
// platform ("hub", or an entity name to find on the surface), in the exact shape the source
// snapshot and the destination assert both consume — shared so the two reads cannot drift.
function dumpSectionsLua(platformName, target) {
	const findEntity = target === "hub"
		? "local ent = plat.hub"
		: `local ent = plat.surface.find_entities_filtered({name='${target}'})[1]`;
	return `(function() local plat for _,q in pairs(game.forces.player.platforms) do `
		+ `if q.valid and q.name=='${platformName}' then plat=q end end `
		+ `if not plat then return {found=false} end `
		+ `${findEntity} `
		+ `if not (ent and ent.valid) then return {found=true, entity=false} end `
		+ `local points = {} `
		+ `for _,pt in pairs(ent.get_logistic_point()) do `
		+ `local secs = {} `
		+ `for _,sec in pairs(pt.sections or {}) do `
		+ `if sec.is_manual then `
		+ `local fs = {} `
		+ `for i=1,sec.filters_count do local f=sec.get_slot(i) `
		+ `if f and f.value then fs[#fs+1]={index=i, name=f.value.name, quality=f.value.quality, `
		+ `comparator=f.value.comparator, min=f.min, max=f.max, `
		+ `import_from=(f.import_from and f.import_from.name or nil)} end end `
		+ `secs[#secs+1]={group=sec.group, multiplier=sec.multiplier, active=sec.active, `
		+ `slots=sec.filters_count, filters=fs} end end `
		+ `if #secs > 0 then points[#points+1]={point_index=pt.logistic_member_index, sections=secs} end end `
		+ `return {found=true, entity=true, index=plat.index, points=points} end)()`;
}

// Assert one hub-sections dump (source or destination) matches the fixture. `where` prefixes the
// check labels so a red names the failing side. `adoptFilters` is section C's expected filter —
// the payload's own on the source, the pre-existing destination group's on the dest.
// `adoptEmptyFilterCount` is section D's expected filter count — 1 (payload) on the source,
// 0 on the dest (the pre-existing EMPTY group is adopted as-is, payload filters NOT written).
function assertHubSections(where, dump, adoptFilters, adoptEmptyFilterCount) {
	check(dump.found === true && dump.entity === true, `${where}: probe platform + hub present`,
		JSON.stringify(dump));
	const points = asArray(dump.points);
	check(points.length === 1, `${where}: exactly one hub logistic point carries manual sections`,
		`points=${points.length}`);
	const sections = asArray(points[0] && points[0].sections);
	check(sections.length === 4, `${where}: exactly the four fixture sections (default empties replaced)`,
		`sections=${sections.length}`);

	const ungrouped = sections.find(s => !s.group || s.group === "");
	const grouped = sections.find(s => s.group === GROUP);
	const adopted = sections.find(s => s.group === GROUP_PREEXISTING);
	const adoptedEmpty = sections.find(s => s.group === GROUP_ADOPT_EMPTY);
	check(!!ungrouped, `${where}: ungrouped section present`);
	check(!!grouped, `${where}: grouped section present (group=${GROUP})`);
	check(!!adopted, `${where}: adoption-case section present (group=${GROUP_PREEXISTING})`);
	check(!!adoptedEmpty, `${where}: empty-adoption-case section present (group=${GROUP_ADOPT_EMPTY})`);
	if (ungrouped) {
		// Slot-index fidelity: filters at 1 and 3, slot 2 stays a GAP (filters_count spans to 3).
		const filters = asArray(ungrouped.filters);
		const s1 = filters.find(f => f.index === 1);
		const s3 = filters.find(f => f.index === 3);
		check(filters.length === 2 && ungrouped.slots >= 3,
			`${where}: ungrouped keeps the slot gap (2 filters across 3 slots)`,
			`filters=${filters.length} slots=${ungrouped.slots}`);
		check(!!s1 && s1.name === "iron-plate" && s1.min === 100 && s1.max === 200
			&& s1.import_from === "nauvis",
			`${where}: slot 1 iron-plate min=100 max=200 import_from=nauvis`, JSON.stringify(s1));
		check(!!s3 && s3.name === "copper-plate" && s3.min === 50,
			`${where}: slot 3 copper-plate min=50`, JSON.stringify(s3));
	}
	if (grouped) {
		const filters = asArray(grouped.filters);
		check(filters.length === 1 && filters[0].name === "processing-unit" && filters[0].min === 7,
			`${where}: grouped section carries processing-unit min=7`, JSON.stringify(filters));
		check(grouped.multiplier === 3, `${where}: grouped multiplier=3`, `multiplier=${grouped.multiplier}`);
		check(grouped.active === false, `${where}: grouped section arrives INACTIVE (active=false)`,
			`active=${grouped.active}`);
	}
	if (adopted) {
		const filters = asArray(adopted.filters);
		check(filters.length === 1 && filters[0].name === adoptFilters.name
			&& filters[0].min === adoptFilters.min,
			`${where}: adoption-case section carries ${adoptFilters.name} min=${adoptFilters.min}`
			+ (adoptFilters.why ? ` (${adoptFilters.why})` : ""),
			JSON.stringify(filters));
	}
	if (adoptedEmpty) {
		const filters = asArray(adoptedEmpty.filters);
		check(filters.length === adoptEmptyFilterCount,
			`${where}: empty-adoption-case section carries ${adoptEmptyFilterCount} filter(s)`
			+ (adoptEmptyFilterCount === 0 ? " (pre-existing EMPTY group adopted as-is, payload filter NOT written)" : ""),
			JSON.stringify(filters));
	}
}

// Assert the requester chest's single manual section (rare-quality request + ≥-comparator quality
// filter — the field families the hub fixture cannot legally combine: the engine refuses a
// non-trivial comparator on a non-zero request, measured 2.1.11).
function assertChestSections(where, dump, expectedPointIndex) {
	check(dump.found === true && dump.entity === true, `${where}: requester chest present on the platform`,
		JSON.stringify(dump));
	const points = asArray(dump.points);
	check(points.length === 1, `${where}: chest has one point with manual sections`, `points=${points.length}`);
	const point = points[0] || {};
	check(point.point_index === expectedPointIndex,
		`${where}: chest point_index round-trips (${expectedPointIndex})`, `point_index=${point.point_index}`);
	const sections = asArray(point.sections);
	check(sections.length === 1, `${where}: chest carries exactly one section`, `sections=${sections.length}`);
	const filters = asArray(sections[0] && sections[0].filters);
	const s1 = filters.find(f => f.index === 1);
	const s2 = filters.find(f => f.index === 2);
	check(!!s1 && s1.name === "iron-plate" && s1.quality === "rare" && s1.min === 11 && s1.max === 77,
		`${where}: chest slot 1 iron-plate quality=rare min=11 max=77`, JSON.stringify(s1));
	check(!!s2 && s2.name === "copper-plate" && s2.quality === "uncommon" && s2.comparator === "≥"
		&& s2.min === 0,
		`${where}: chest slot 2 copper-plate quality≥uncommon (comparator round-trips as ≥)`,
		JSON.stringify(s2));
}

async function main() {
	console.log(`=== hub-request-sections: pending hub item requests survive a transfer (${PROBE}) ===`);
	const ids = instanceIds();

	// waitForImportResult reads debug_import_result_*.json on the destination — debug-gated. Capture
	// the prior value so the finally can put it back exactly (zero-leftover includes config).
	const prevDebug = lua(2, `return {success=true, debug=(storage.surface_export_config `
		+ `and storage.surface_export_config.debug_mode) == true}`);
	lua(2, `remote.call('surface_export','configure',{debug_mode=true}) return {success=true}`);

	try {
		// --- Adoption pre-state: both adoption groups live on the DESTINATION force before the
		// transfer — one populated, one EMPTY. A logistic group persists on the force after its
		// creating entity is gone (measured — that is also why cleanup deletes groups explicitly),
		// so the scratch chest is destroyed in the same call.
		const preGroup = lua(2,
			`local chest=game.surfaces['nauvis'].create_entity{name='requester-chest', `
			+ `position=game.surfaces['nauvis'].find_non_colliding_position('requester-chest',{0,0},64,1), `
			+ `force='player'} `
			+ `local pt=chest.get_logistic_point()[1] `
			+ `local sec=pt.add_section('${GROUP_PREEXISTING}') `
			+ `sec.set_slot(1,{value={name='iron-stick',quality='normal'},min=42}) `
			+ `pt.add_section('${GROUP_ADOPT_EMPTY}') `
			+ `chest.destroy() `
			+ `local present={} for _,g in pairs(game.forces.player.get_logistic_groups()) do present[g]=true end `
			+ `return {success=true, populated=present['${GROUP_PREEXISTING}'] == true, `
			+ `empty=present['${GROUP_ADOPT_EMPTY}'] == true}`);
		check(preGroup.populated === true && preGroup.empty === true,
			"pre-state: both adoption groups exist on the destination force (outliving their creating entity)",
			JSON.stringify(preGroup));

		// --- Fixture: throwaway platform whose hub carries the adversarial manual sections, plus a
		// requester chest carrying the quality/comparator families (chest requests were ALSO silently
		// lost on this pin before the sections path — request_slot_count does not exist on 2.1.11).
		const setup = lua(1,
			`local p=game.forces.player.create_space_platform{name='${PROBE}', planet='nauvis', `
			+ `starter_pack='space-platform-starter-pack'} `
			+ `p.apply_starter_pack() `
			+ `local hub=p.surface.find_entity('space-platform-hub',{0,0}) `
			+ `local pt=hub.get_logistic_point()[1] `
			// Deterministic baseline: replace the fresh hub's default manual section(s) with the fixture.
			+ `for i=pt.sections_count,1,-1 do local s=pt.sections[i] `
			+ `if s and s.is_manual then pt.remove_section(i) end end `
			+ `local a=pt.add_section() `
			+ `a.set_slot(1,{value={name='iron-plate',quality='normal'},min=100,max=200,import_from='nauvis'}) `
			+ `a.set_slot(3,{value={name='copper-plate',quality='normal'},min=50}) `
			+ `local b=pt.add_section('${GROUP}') `
			+ `b.set_slot(1,{value={name='processing-unit',quality='normal'},min=7}) `
			+ `b.multiplier=3 b.active=false `
			+ `local c=pt.add_section('${GROUP_PREEXISTING}') `
			+ `c.set_slot(1,{value={name='plastic-bar',quality='normal'},min=99}) `
			+ `local d=pt.add_section('${GROUP_ADOPT_EMPTY}') `
			+ `d.set_slot(1,{value={name='sulfur',quality='normal'},min=13}) `
			+ `local chest=p.surface.create_entity{name='requester-chest', position={3,3}, force=p.force} `
			+ `local cpt=chest.get_logistic_point()[1] `
			+ `for i=cpt.sections_count,1,-1 do local s=cpt.sections[i] `
			+ `if s and s.is_manual then cpt.remove_section(i) end end `
			+ `local cs=cpt.add_section() `
			+ `cs.set_slot(1,{value={name='iron-plate',quality='rare',comparator='='},min=11,max=77}) `
			+ `cs.set_slot(2,{value={name='copper-plate',quality='uncommon',comparator='>='},min=0}) `
			+ `return {success=true, index=p.index, chest_point_index=cpt.logistic_member_index}`);
		if (!setup.success) throw new Error(`fixture setup failed: ${JSON.stringify(setup)}`);

		// Source truth, read back PHYSICALLY through the same dumps the destination asserts use.
		// Sections C and D carry the PAYLOAD filters here (both groups are new on the source force).
		assertHubSections("source", lua(1, `return ${dumpSectionsLua(PROBE, "hub")}`),
			{ name: "plastic-bar", min: 99 }, 1);
		assertChestSections("source", lua(1, `return ${dumpSectionsLua(PROBE, "requester-chest")}`),
			setup.chest_point_index);

		// --- Measurement 1: the payload carries the sections (export-side omission screen) ----------
		const inspector = await exportInspect({ platform: PROBE, host: 1 });
		const hubRecord = (inspector.entities || []).find(e => e.name === "space-platform-hub");
		check(!!hubRecord, "payload: hub record present", `entities=${inspector.entities.length}`);
		const payloadPoints = asArray(hubRecord && hubRecord.logistic_sections);
		check(payloadPoints.length === 1,
			"payload: hub record carries logistic_sections (presence is necessary, never sufficient)",
			hubRecord ? `logistic_sections=${JSON.stringify(hubRecord.logistic_sections)}` : "no hub record");
		const payloadSections = asArray(payloadPoints[0] && payloadPoints[0].sections);
		check(payloadSections.length === 4
			&& payloadSections.some(s => s.group === GROUP)
			&& payloadSections.some(s => s.group === GROUP_PREEXISTING)
			&& payloadSections.some(s => s.group === GROUP_ADOPT_EMPTY)
			&& payloadSections.some(s => asArray(s.filters).some(f =>
				f.import_from === "nauvis" && f.max === 200)),
			"payload: all four hub sections ride with group/import_from/max intact",
			JSON.stringify(payloadSections));
		const chestRecord = (inspector.entities || []).find(e => e.name === "requester-chest");
		check(!!chestRecord && asArray(chestRecord.logistic_sections).length === 1,
			"payload: requester-chest record carries logistic_sections",
			chestRecord ? JSON.stringify(chestRecord.logistic_sections) : "no chest record");

		// --- Measurement 2: a REAL transfer, then the PHYSICAL destination read ---------------------
		const marker = L.dropMarker(2, "transfer");
		rcon(1, `/transfer-platform ${setup.index} ${ids[2]}`);
		const { result } = await L.waitForImportResult(2, marker);
		check(result.validation_success === true, "transfer: exact gate passed",
			`validation_success=${result.validation_success}`
			+ (result.validation_result && result.validation_result.mismatchDetails
				? ` — ${result.validation_result.mismatchDetails}` : ""));

		// Section C arrives joined to the pre-existing POPULATED group carrying the DESTINATION's
		// filter; section D joined to the pre-existing EMPTY group with NO filters written — the
		// restore must never clobber force-level groups other platforms share, populated or not.
		assertHubSections("dest", lua(2, `return ${dumpSectionsLua(PROBE, "hub")}`),
			{ name: "iron-stick", min: 42, why: "destination group adopted, payload filter NOT written" }, 0);
		assertChestSections("dest", lua(2, `return ${dumpSectionsLua(PROBE, "requester-chest")}`),
			setup.chest_point_index);

		// 2PC: the source is gone after a committed transfer (standard contract, cheap to keep visible).
		const sourceGone = lua(1, `for _,q in pairs(game.forces.player.platforms) do `
			+ `if q.valid and q.name=='${PROBE}' then return {success=true,present=true} end end `
			+ `return {success=true,present=false}`);
		check(sourceGone.present === false, "transfer: source deleted (two-phase commit)");

		// --- Measurement 3: malformed logistic_sections shapes are SKIPPED, never thrown -------------
		// The restore runs unprotected inside the on_tick import driver; an uncaught throw there is
		// headless-server death (exit 255). Drive the deployed function directly with the shapes a
		// hand-edited upload-import could carry. Against a SCRATCH chest, not the live dest hub —
		// shape 5's point_index resolves a real point and legitimately clears its manual sections
		// before skipping the malformed members, which on the hub would destroy the just-asserted
		// fixture. Each call must return (a table) instead of raising; the guards log-and-skip.
		const guards = lua(2,
			`local DS = package.loaded['__level__/modules/surface_export/core/deserializer.lua'] `
			+ `local s = game.surfaces['nauvis'] `
			+ `local chest = s.create_entity{name='requester-chest', `
			+ `position=s.find_non_colliding_position('requester-chest',{40,40},64,1), force='player'} `
			+ `if not chest then return {success=false, error='no scratch chest'} end `
			+ `local shapes = { {logistic_sections='x'}, {logistic_sections={{point_index=1}}}, `
			+ `{logistic_sections={{point_index=99, sections={}}}}, {logistic_sections={1,2,3}}, `
			+ `{logistic_sections={{point_index=0, sections={'y'}}}} } `
			+ `local results = {} `
			+ `for i, shape in ipairs(shapes) do `
			+ `local ok, res = pcall(DS.restore_logistic_sections, chest, shape) `
			+ `results[i] = ok and type(res) == 'table' end `
			+ `chest.destroy() `
			+ `return {success=true, results=results}`);
		check(guards.success === true && asArray(guards.results).every(r => r === true)
			&& asArray(guards.results).length === 5,
			"guards: five malformed logistic_sections shapes skipped without throwing",
			JSON.stringify(guards));
		// And the live dest hub was never touched by the guard probes.
		assertHubSections("dest-after-guards", lua(2, `return ${dumpSectionsLua(PROBE, "hub")}`),
			{ name: "iron-stick", min: 42 }, 0);

		// --- Measurement 4: a REFUSED transfer sweeps the groups its import created -----------------
		// Fail => revert discards the destination; the force-level groups add_section created during
		// the doomed restore must go with it, or every failed attempt leaks one (review finding).
		const failSetup = lua(1,
			`local p=game.forces.player.create_space_platform{name='${PROBE_FAIL}', planet='nauvis', `
			+ `starter_pack='space-platform-starter-pack'} `
			+ `p.apply_starter_pack() `
			+ `local hub=p.surface.find_entity('space-platform-hub',{0,0}) `
			+ `local pt=hub.get_logistic_point()[1] `
			+ `local sec=pt.add_section('${GROUP_FAIL}') `
			+ `sec.set_slot(1,{value={name='iron-plate',quality='normal'},min=5}) `
			+ `return {success=true, index=p.index}`);
		if (!failSetup.success) throw new Error(`refusal fixture setup failed: ${JSON.stringify(failSetup)}`);
		const armed = lua(2, `remote.call('surface_export','configure',{test_force_validation_failure=true}) `
			+ `return {success=true}`);
		if (!armed.success) throw new Error("failed to arm refusal hook on host 2");
		try {
			const marker2 = L.dropMarker(2, "refusal");
			rcon(1, `/transfer-platform ${failSetup.index} ${ids[2]}`);
			const { result: refusal } = await L.waitForImportResult(2, marker2);
			check(refusal.validation_success === false, "refusal: gate refused (hook-armed)",
				`validation_success=${refusal.validation_success}`);
			const srcKept = lua(1, `for _,q in pairs(game.forces.player.platforms) do `
				+ `if q.valid and q.name=='${PROBE_FAIL}' then return {success=true,present=true} end end `
				+ `return {success=true,present=false}`);
			check(srcKept.present === true, "refusal: source preserved (fail => revert)");
			const destState = lua(2,
				`local plat_present=false for _,q in pairs(game.forces.player.platforms) do `
				+ `if q.valid and q.name=='${PROBE_FAIL}' then plat_present=true end end `
				+ `local group_present=false for _,g in pairs(game.forces.player.get_logistic_groups()) do `
				+ `if g=='${GROUP_FAIL}' then group_present=true end end `
				+ `return {success=true, plat_present=plat_present, group_present=group_present}`);
			check(destState.plat_present === false, "refusal: destination copy discarded");
			check(destState.group_present === false,
				"refusal: import-created logistic group SWEPT with the discard (no orphan on the force)",
				`group_present=${destState.group_present}`);
		} finally {
			lua(2, `if storage.surface_export_config then `
				+ `storage.surface_export_config.test_force_validation_failure=nil end return {success=true}`);
		}
	} finally {
		// Unconditional sweep. PER-HOST try/catch: measured 2026-08-04, a host-1 restart mid-run made
		// a shared try abort before host 2's sweep ever ran, stranding the transferred probe there —
		// one host's outage must not leak the other host's leftovers. Failures are REPORTED without
		// masking the primary failure above.
		const groupLuaList = ALL_GROUPS.map(g => `'${g}'`).join(",");
		for (const host of [1, 2]) {
			try {
				const swept = lua(host,
					`local n=0 for _,q in pairs(game.forces.player.platforms) do `
					+ `if q.valid and (q.name=='${PROBE}' or q.name=='${PROBE_FAIL}') then `
					+ `pcall(remote.call,'surface_export','unlock_platform',q.index) `
					+ `if q.surface and q.surface.valid then game.delete_surface(q.surface) n=n+1 end end end `
					// The run-unique GROUPS outlive their platform (measured: force-level registry entries
					// remain after the surface is deleted) — a persistent force record is a leftover too.
					+ `local gok, gerr = pcall(function() `
					+ `local doomed = {${groupLuaList}} local dset = {} `
					+ `for _,g in ipairs(doomed) do dset[g]=true end `
					+ `for _,g in pairs(game.forces.player.get_logistic_groups()) do `
					+ `if dset[g] then game.forces.player.delete_logistic_group(g) end end end) `
					+ `return {success=true, swept=n, group_ok=gok, group_err=(gok and nil or tostring(gerr))}`);
				console.log(`  cleanup host ${host}: swept ${swept.swept} probe platform(s)`);
				check(swept.group_ok === true, `cleanup host ${host}: no logistic-group residue`,
					String(swept.group_err));
			} catch (sweepErr) {
				failed++;
				console.error(`  FAIL cleanup host ${host} threw: ${sweepErr && sweepErr.message ? sweepErr.message : sweepErr}`);
				console.error("  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix hub-req-sections is in its sweep list — platforms AND groups)");
			}
		}
		// Restore debug_mode exactly as found (configure() only applies allowlisted keys, so this
		// writes the same field the arming wrote). Its own try: a debug-restore failure must be
		// visible even when the platform sweep above also failed.
		try {
			lua(2, `remote.call('surface_export','configure',{debug_mode=${prevDebug.debug === true}}) `
				+ `return {success=true}`);
		} catch (cfgErr) {
			failed++;
			console.error(`  FAIL debug_mode restore threw: ${cfgErr && cfgErr.message ? cfgErr.message : cfgErr}`);
		}
	}

	if (failed) {
		console.log(`=== hub-request-sections: ${failed} FAILURE(S) ===`);
		process.exit(1);
	}
	console.log("=== hub-request-sections: ALL PASS ===");
}

main().catch(error => {
	console.error(`hub-request-sections: fatal — ${error && error.stack ? error.stack : error}`);
	process.exit(1);
});
