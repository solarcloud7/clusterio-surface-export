#!/usr/bin/env node

import {
	lua, rcon, instanceIds, createBatchLifecycle,
} from "../../lab-gallery/batch-lifecycle.mjs";
import { exportInspect } from "../../../tools/tests/testkit/export-inspect.mjs";

const RUN_TAG = Date.now().toString(36);
const PROBE = `hub-req-sections-${RUN_TAG}`;
const PROBE_FAIL = `hub-req-sections-refusal-${RUN_TAG}`;
const GROUP = `hub-req-sections-group-${RUN_TAG}`;
const GROUP_PREEXISTING = `hub-req-sections-adopt-${RUN_TAG}`;
const GROUP_ADOPT_EMPTY = `hub-req-sections-adopt-empty-${RUN_TAG}`;
const GROUP_FAIL = `hub-req-sections-fail-${RUN_TAG}`;
const ALL_GROUPS = [GROUP, GROUP_PREEXISTING, GROUP_ADOPT_EMPTY, GROUP_FAIL];

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip",
	markerPrefix: "hub-req-sections",
});

const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

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

	const prevDebug = lua(2, `return {success=true, debug=(storage.surface_export_config `
		+ `and storage.surface_export_config.debug_mode) == true}`);
	lua(2, `remote.call('surface_export','configure',{debug_mode=true}) return {success=true}`);

	try {
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

		const setup = lua(1,
			`local p=game.forces.player.create_space_platform{name='${PROBE}', planet='nauvis', `
			+ `starter_pack='space-platform-starter-pack'} `
			+ `p.apply_starter_pack() `
			+ `local hub=p.surface.find_entity('space-platform-hub',{0,0}) `
			+ `local pt=hub.get_logistic_point()[1] `
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

		assertHubSections("source", lua(1, `return ${dumpSectionsLua(PROBE, "hub")}`),
			{ name: "plastic-bar", min: 99 }, 1);
		assertChestSections("source", lua(1, `return ${dumpSectionsLua(PROBE, "requester-chest")}`),
			setup.chest_point_index);

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

		const marker = L.dropMarker(2, "transfer");
		rcon(1, `/transfer-platform ${setup.index} ${ids[2]}`);
		const { result } = await L.waitForImportResult(2, marker);
		check(result.validation_success === true, "transfer: exact gate passed",
			`validation_success=${result.validation_success}`
			+ (result.validation_result && result.validation_result.mismatchDetails
				? ` — ${result.validation_result.mismatchDetails}` : ""));

		assertHubSections("dest", lua(2, `return ${dumpSectionsLua(PROBE, "hub")}`),
			{ name: "iron-stick", min: 42, why: "destination group adopted, payload filter NOT written" }, 0);
		assertChestSections("dest", lua(2, `return ${dumpSectionsLua(PROBE, "requester-chest")}`),
			setup.chest_point_index);

		const sourceGone = lua(1, `for _,q in pairs(game.forces.player.platforms) do `
			+ `if q.valid and q.name=='${PROBE}' then return {success=true,present=true} end end `
			+ `return {success=true,present=false}`);
		check(sourceGone.present === false, "transfer: source deleted (two-phase commit)");

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
		assertHubSections("dest-after-guards", lua(2, `return ${dumpSectionsLua(PROBE, "hub")}`),
			{ name: "iron-stick", min: 42 }, 0);

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
		const groupLuaList = ALL_GROUPS.map(g => `'${g}'`).join(",");
		for (const host of [1, 2]) {
			try {
				const swept = lua(host,
					`local n=0 for _,q in pairs(game.forces.player.platforms) do `
					+ `if q.valid and (q.name=='${PROBE}' or q.name=='${PROBE_FAIL}') then `
					+ `pcall(remote.call,'surface_export','unlock_platform',q.index) `
					+ `if q.surface and q.surface.valid then game.delete_surface(q.surface) n=n+1 end end end `
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
