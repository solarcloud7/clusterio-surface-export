#!/usr/bin/env node
// Hub request sections — the platform's pending item requests must survive a transfer.
//
// WHAT THIS PROTECTS. A player's hub requests (the hub GUI "Requests" tab) are MANUAL logistic
// sections on the hub's requester logistic point. They are settings, not items, so the exact gate
// is structurally blind to them — the same silent-loss class as the infinity-pipe filter
// (2026-07-26) and chest slot filters (2026-07-18). Before the sections serializer landed
// (2026-08-04) every transfer silently dropped them.
//
// WHY SECTIONS AND NOT ITEM-REQUEST-PROXIES. Measured 2.1.11 (2026-08-04, live probes): a
// hub-targeted item-request-proxy is destroyed BY THE ENGINE within one tick of creation — paused
// or unpaused, frozen hub or not — and its request is annihilated (not delivered, not merged into
// sections). It cannot exist as persistent state, so it can never be exported or restored; manual
// sections are the only persistent form a pending hub request takes. An assembler-targeted proxy
// under identical conditions persists indefinitely (and rides the payload as a first-class record).
//
// TWO INDEPENDENT MEASUREMENTS, deliberately separate so each failure names its half:
//   payload.*  — testkit exportInspect: is `logistic_sections` ON THE PAYLOAD hub record?
//                (export-side serializer omission — presence is necessary, never sufficient)
//   dest.*     — a REAL production transfer, then a PHYSICAL read of the destination hub's
//                sections (restore-side; the only thing that proves survival)
//
// The fixture is adversarial on purpose: a slot-index GAP (slots 1 and 3, 2 empty), min+max,
// import_from, a GROUPED section with non-default multiplier and active=false — every field family
// the serializer claims to carry, so a partial capture cannot pass. The group name is unique per
// run: logistic groups are FORCE-level shared state on the destination, and add_section(<existing
// group>) ADOPTS the existing filters (measured 2.1.11), which would make the restore assert
// vacuously green against a stale group from a previous run.
//
// CLEANUP IS UNCONDITIONAL (evacuation-coverage pattern): the finally block sweeps probe-named
// platforms on BOTH hosts (unlock best-effort first) and restores host-2's debug_mode to its
// pre-test value. The `hub-req-sections-` prefix is in cleanup-test-surfaces.ps1's sweep list as
// the backstop.

import {
	HOSTS, lua, rcon, instanceIds, createBatchLifecycle,
} from "../../lab-gallery/batch-lifecycle.mjs";
import { exportInspect } from "../../../tools/tests/testkit/export-inspect.mjs";

const RUN_TAG = Date.now().toString(36);
const PROBE = `hub-req-sections-${RUN_TAG}`;
const GROUP = `hub-req-sections-group-${RUN_TAG}`;
// A SECOND group, pre-created on the DESTINATION force with different filters before the transfer:
// add_section(<existing group>) ADOPTS the existing force-level filters (measured 2.1.11), and the
// restore must NOT overwrite them — a logistic group is shared by every platform on that force, so
// clobbering it from a payload would corrupt unrelated platforms. Section C asserts that policy:
// it arrives joined to the group but carrying the DESTINATION's filters, not the payload's.
const GROUP_PREEXISTING = `hub-req-sections-adopt-${RUN_TAG}`;

const L = createBatchLifecycle({
	// Golden saves are NOT used (no loadGoldenPair call — the probe platform is throwaway on the
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

// Lua snippet: dump the MANUAL sections of every logistic point on the named platform's hub, in
// the exact shape both the source snapshot and the destination assert consume. Shared so the two
// reads cannot drift.
function dumpHubSectionsLua(platformName) {
	return `(function() local plat for _,q in pairs(game.forces.player.platforms) do `
		+ `if q.valid and q.name=='${platformName}' then plat=q end end `
		+ `if not plat then return {found=false} end `
		+ `local hub = plat.hub if not (hub and hub.valid) then return {found=true, hub=false} end `
		+ `local points = {} `
		+ `for _,pt in pairs(hub.get_logistic_point()) do `
		+ `local secs = {} `
		+ `for _,sec in pairs(pt.sections or {}) do `
		+ `if sec.is_manual then `
		+ `local fs = {} `
		+ `for i=1,sec.filters_count do local f=sec.get_slot(i) `
		+ `if f and f.value then fs[#fs+1]={index=i, name=f.value.name, quality=f.value.quality, `
		+ `min=f.min, max=f.max, import_from=(f.import_from and f.import_from.name or nil)} end end `
		+ `secs[#secs+1]={group=sec.group, multiplier=sec.multiplier, active=sec.active, `
		+ `slots=sec.filters_count, filters=fs} end end `
		+ `if #secs > 0 then points[#points+1]={point_index=pt.logistic_member_index, sections=secs} end end `
		+ `return {found=true, hub=true, index=plat.index, points=points} end)()`;
}

// Assert one hub-sections dump (source or destination) matches the fixture. `where` prefixes the
// check labels so a red names the failing side. `expectedAdopt` is section C's expected filter —
// the payload's own filter on the source, the pre-existing destination group's filter on the dest.
function assertFixtureSections(where, dump, expectedAdopt) {
	check(dump.found === true && dump.hub === true, `${where}: probe platform + hub present`,
		JSON.stringify(dump));
	const points = asArray(dump.points);
	check(points.length === 1, `${where}: exactly one logistic point carries manual sections`,
		`points=${points.length}`);
	const sections = asArray(points[0] && points[0].sections);
	check(sections.length === 3, `${where}: exactly the three fixture sections (default empties replaced)`,
		`sections=${sections.length}`);

	const ungrouped = sections.find(s => !s.group || s.group === "");
	const grouped = sections.find(s => s.group === GROUP);
	const adopted = sections.find(s => s.group === GROUP_PREEXISTING);
	check(!!ungrouped, `${where}: ungrouped section present`);
	check(!!grouped, `${where}: grouped section present (group=${GROUP})`);
	check(!!adopted, `${where}: adoption-case section present (group=${GROUP_PREEXISTING})`);
	if (adopted) {
		const filters = asArray(adopted.filters);
		check(filters.length === 1 && filters[0].name === expectedAdopt.name
			&& filters[0].min === expectedAdopt.min,
			`${where}: adoption-case section carries ${expectedAdopt.name} min=${expectedAdopt.min}`
			+ (expectedAdopt.why ? ` (${expectedAdopt.why})` : ""),
			JSON.stringify(filters));
	}
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
		// --- Adoption pre-state: GROUP_PREEXISTING lives on the DESTINATION force with its own
		// filter before the transfer. A logistic group persists on the force after its creating
		// entity is gone (measured — that is also why cleanup deletes groups explicitly), so the
		// scratch chest is destroyed in the same call.
		const preGroup = lua(2,
			`local chest=game.surfaces['nauvis'].create_entity{name='requester-chest', `
			+ `position=game.surfaces['nauvis'].find_non_colliding_position('requester-chest',{0,0},64,1), `
			+ `force='player'} `
			+ `local pt=chest.get_logistic_point()[1] `
			+ `local sec=pt.add_section('${GROUP_PREEXISTING}') `
			+ `sec.set_slot(1,{value={name='iron-stick',quality='normal'},min=42}) `
			+ `chest.destroy() `
			+ `local present=false for _,g in pairs(game.forces.player.get_logistic_groups()) do `
			+ `if g=='${GROUP_PREEXISTING}' then present=true end end `
			+ `return {success=true, group_present=present}`);
		check(preGroup.group_present === true,
			"pre-state: adoption group exists on the destination force (outliving its creating entity)");

		// --- Fixture: throwaway platform whose hub carries the adversarial manual sections ---------
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
			+ `return {success=true, index=p.index}`);
		if (!setup.success) throw new Error(`fixture setup failed: ${JSON.stringify(setup)}`);

		// Source truth, read back PHYSICALLY through the same dump the destination assert uses.
		// Section C carries the PAYLOAD filter here (the group is new on the source force).
		const sourceDump = lua(1, `return ${dumpHubSectionsLua(PROBE)}`);
		assertFixtureSections("source", sourceDump, { name: "plastic-bar", min: 99 });

		// --- Measurement 1: the payload carries the sections (export-side omission screen) ----------
		const inspector = await exportInspect({ platform: PROBE, host: 1 });
		const hubRecord = (inspector.entities || []).find(e => e.name === "space-platform-hub");
		check(!!hubRecord, "payload: hub record present", `entities=${inspector.entities.length}`);
		const payloadPoints = asArray(hubRecord && hubRecord.logistic_sections);
		check(payloadPoints.length === 1,
			"payload: hub record carries logistic_sections (presence is necessary, never sufficient)",
			hubRecord ? `logistic_sections=${JSON.stringify(hubRecord.logistic_sections)}` : "no hub record");
		const payloadSections = asArray(payloadPoints[0] && payloadPoints[0].sections);
		check(payloadSections.length === 3
			&& payloadSections.some(s => s.group === GROUP)
			&& payloadSections.some(s => s.group === GROUP_PREEXISTING)
			&& payloadSections.some(s => asArray(s.filters).some(f =>
				f.import_from === "nauvis" && f.max === 200)),
			"payload: all three sections ride with group/import_from/max intact",
			JSON.stringify(payloadSections));

		// --- Measurement 2: a REAL transfer, then the PHYSICAL destination read ---------------------
		const marker = L.dropMarker(2, "transfer");
		rcon(1, `/transfer-platform ${setup.index} ${ids[2]}`);
		const { result } = await L.waitForImportResult(2, marker);
		check(result.validation_success === true, "transfer: exact gate passed",
			`validation_success=${result.validation_success}`
			+ (result.validation_result && result.validation_result.mismatchDetails
				? ` — ${result.validation_result.mismatchDetails}` : ""));

		// Section C must arrive joined to the pre-existing group and carrying the DESTINATION's
		// filter — the restore must never clobber a force-level group other platforms share.
		const destDump = lua(2, `return ${dumpHubSectionsLua(PROBE)}`);
		assertFixtureSections("dest", destDump,
			{ name: "iron-stick", min: 42, why: "destination group adopted, payload filter NOT written" });

		// 2PC: the source is gone after a committed transfer (standard contract, cheap to keep visible).
		const sourceGone = lua(1, `for _,q in pairs(game.forces.player.platforms) do `
			+ `if q.valid and q.name=='${PROBE}' then return {success=true,present=true} end end `
			+ `return {success=true,present=false}`);
		check(sourceGone.present === false, "transfer: source deleted (two-phase commit)");
	} finally {
		// Unconditional sweep. PER-HOST try/catch: measured 2026-08-04, a host-1 restart mid-run made
		// the shared try abort before host 2's sweep ever ran, stranding the transferred probe there —
		// one host's outage must not leak the other host's leftovers. Failures are REPORTED without
		// masking the primary failure above.
		for (const host of [1, 2]) {
			try {
				const swept = lua(host,
					`local n=0 for _,q in pairs(game.forces.player.platforms) do `
					+ `if q.valid and q.name=='${PROBE}' then `
					+ `pcall(remote.call,'surface_export','unlock_platform',q.index) `
					+ `if q.surface and q.surface.valid then game.delete_surface(q.surface) n=n+1 end end end `
					// The run-unique GROUPS outlive their platform (measured: force-level registry entries
					// remain after the surface is deleted) — a persistent force record is a leftover too.
					+ `local gok, gerr = pcall(function() `
					+ `for _,g in pairs(game.forces.player.get_logistic_groups()) do `
					+ `if g=='${GROUP}' or g=='${GROUP_PREEXISTING}' then game.forces.player.delete_logistic_group(g) end end end) `
					+ `return {success=true, swept=n, group_ok=gok, group_err=(gok and nil or tostring(gerr))}`);
				console.log(`  cleanup host ${host}: swept ${swept.swept} probe platform(s)`);
				check(swept.group_ok === true, `cleanup host ${host}: no logistic-group residue`,
					String(swept.group_err));
			} catch (sweepErr) {
				failed++;
				console.error(`  FAIL cleanup host ${host} threw: ${sweepErr && sweepErr.message ? sweepErr.message : sweepErr}`);
				console.error("  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix hub-req-sections is in its sweep list)");
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
