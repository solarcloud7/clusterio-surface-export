#!/usr/bin/env node
// unarmed-fluid-registry — do the NON-production callers of EntityScanner.serialize_entity arm the
// FluidRegistry that InventoryScanner.extract_fluidboxes raises without?
//
// requires: a running surface-export cluster (host-1); debug_mode togglable via the configure remote
// produces: exit 0 when test_import_entity re-exports a no-handler entity (solar-panel), and when a
//           real force-paste over a real blocker replaces that blocker — which is what serializes the
//           blocker and so exercises the arming at selection-lab.lua
// does not: measure any record shape other than a plain entity record (item-on-ground,
//           item-request-proxy and entity-ghost recs are measured in tests/integration/lab-paste-conflict),
//           assert what the blocker snapshot CONTAINS, perform a transfer, assert fluid AMOUNTS, or
//           exercise the interactive selection-lab tool

import { execFileSync } from "node:child_process";

const INSTANCE = process.env.SE_LAB_INSTANCE || "clusterio-host-1-instance-1";
const TAG = Date.now().toString(36);
const PROBE = `selab-armed-${TAG}`;
const PROBE_PREFIX = "selab-armed-";
const LAB_PLAYER = 1;

const rcon = (body) => execFileSync("docker", [
	"exec", "surface-export-controller", "sh", "-c",
	"npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error "
	+ `instance send-rcon "${INSTANCE}" ${JSON.stringify("/sc " + body.replace(/\s*\n\s*/g, " ").trim())}`,
], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

// The Lua is flattened to ONE line before it is sent, so no -- comments may appear in any body below.
const lua = (body) => {
	const raw = rcon(`rcon.print(helpers.table_to_json((function() ${body} end)()))`);
	const line = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1);
	if (!line) throw new Error("RCON returned NOTHING — the command did not execute; this is not a result");
	try {
		return JSON.parse(line);
	} catch (parseError) {
		throw new Error(`RCON reply was not JSON (${parseError.message}): ${line.slice(0, 500)}`);
	}
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// helpers.table_to_json renders an EMPTY Lua array as {}, so every list crossing the wire is
// normalised before it is read as one.
const asArray = (value) => (Array.isArray(value) ? value : Object.values(value || {}));

let failures = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) { failures += 1; process.exitCode = 1; }
};
const note = (text) => console.log(`  NOTE  ${text}`);

console.log(`=== unarmed-fluid-registry: serialize_entity needs an armed FluidRegistry (${PROBE}) ===`);

let setup = null;
// Read BEFORE anything writes it. A setup body that raises after its own configure() call does not
// roll back, so a prevDebug assigned only from that body's return value would restore the wrong value.
let prevDebug = null;
try {
	prevDebug = lua(`
		return { debug = (storage.surface_export_config and storage.surface_export_config.debug_mode) == true }
	`).debug === true;

	setup = lua(`
		remote.call('surface_export', 'configure', { debug_mode = true })
		storage.selection_lab = storage.selection_lab or {}
		storage.__selab_probe_saved = storage.selection_lab[${LAB_PLAYER}]
		storage.selection_lab[${LAB_PLAYER}] = nil
		local p = game.forces.player.create_space_platform{ name = '${PROBE}', planet = 'nauvis',
			starter_pack = 'space-platform-starter-pack' }
		if not p then return { ok = false, err = 'platform not created' } end
		p.apply_starter_pack()
		local s, force = p.surface, game.forces.player
		local tiles = {}
		for x = 5, 21 do for y = 0, 10 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } } end end
		s.set_tiles(tiles)
		local chest = s.create_entity{ name = 'wooden-chest', position = { 6.5, 2.5 }, force = force }
		local panel = s.create_entity{ name = 'solar-panel', position = { 14.5, 2.5 }, force = force }
		local pl = game.get_player(${LAB_PLAYER})
		local roster = 0
		for _ in pairs(game.players) do roster = roster + 1 end
		return { ok = true, surface = s.name, platform = p.index,
			chest = (chest ~= nil and chest.valid), panel = (panel ~= nil and panel.valid),
			roster = roster, connected = #game.connected_players,
			player = (pl ~= nil and pl.valid), player_force = (pl and pl.force.name) or '',
			lab_state_was_live = storage.__selab_probe_saved ~= nil }
	`);
	if (setup.ok !== true) throw new Error(`probe setup refused: ${setup.err}`);

	note(`instance ${INSTANCE}: ${setup.roster} player record(s), ${setup.connected} connected; `
		+ `game.get_player(${LAB_PLAYER}) ${setup.player ? `resolves (force ${setup.player_force})` : "is NIL"}`);
	if (setup.lab_state_was_live) note(`player ${LAB_PLAYER} had live selection-lab state; it is parked and restored at cleanup`);
	check(setup.chest === true, "probe fixture: copy-source wooden-chest placed at (6.5, 2.5)");
	check(setup.panel === true, "probe fixture: blocker solar-panel placed at (14.5, 2.5)");

	const arm1 = lua(`
		local s = game.surfaces['${setup.surface}']
		local res = remote.call('surface_export', 'test_import_entity',
			{ name = 'solar-panel', type = 'solar-panel', position = { x = 18.5, y = 6.5 }, force = 'player' }, s.index)
		local warnings = {}
		for _, w in ipairs(res.warnings or {}) do warnings[#warnings + 1] = tostring(w) end
		local errors = {}
		for _, e in ipairs(res.errors or {}) do errors[#errors + 1] = tostring(e) end
		return { created = res.success == true, exported = res.exported_entity ~= nil,
			compared = res.comparison ~= nil, warnings = warnings, errors = errors }
	`);
	check(arm1.created === true,
		"control: test_import_entity CREATES the solar-panel (so an absent re-export is the re-export's fault)",
		asArray(arm1.errors).join(" | "));
	check(arm1.exported === true,
		"test_import_entity re-exports the created solar-panel (a no-handler category, so handle_entity "
		+ "reaches extract_fluidboxes unconditionally)",
		asArray(arm1.warnings).join(" | "));
	check(arm1.compared === true, "test_import_entity produces the roundtrip comparison it advertises");

	if (setup.player !== true) {
		check(false, `selection-lab force-paste arm UNEXERCISED — no player record at index ${LAB_PLAYER} on `
			+ `${INSTANCE}, and force_execute dereferences player.force before it reaches the blocker snapshot`,
			"this is a gap, not a pass");
	} else {
		const copy = lua(`
			local r = remote.call('surface_export', 'selection_lab_drive', 'copy', ${LAB_PLAYER}, 6, 2, 8, 4, '${setup.surface}')
			return { ok = r.ok == true, err = tostring(r.err or ''),
				outcome = (r.report and r.report.outcome) or '', records = (r.report and r.report.records) or 0 }
		`);
		check(copy.ok === true && copy.outcome === "copied" && copy.records === 1,
			"selection-lab copies the source chest (this path already arms the registry)",
			`ok=${copy.ok} outcome=${copy.outcome} records=${copy.records} ${copy.err}`);

		// These can_place_entity calls are RECORDED, not relied on: measured at 2.1.11 in
		// tests/integration/lab-paste-conflict, no build_check_type discriminates on a space-platform
		// surface (the non-script types answer false even on clear foundation), so none of them can
		// stand in for "the blocker blocks". The physical control is at_target; the assertion that
		// protects the invariant is blockers_replaced, read back off a real force-paste.
		const gate = lua(`
			local s = game.surfaces['${setup.surface}']
			local bct = defines.build_check_type
			local at_target = {}
			for _, e in pairs(s.find_entities_filtered{ area = { { 13, 1 }, { 17, 5 } } }) do
				at_target[#at_target + 1] = string.format('%s@%.2f,%.2f', e.name, e.position.x, e.position.y)
			end
			local spec = { name = 'wooden-chest', position = { 14.5, 2.5 }, direction = 0, force = 'player' }
			local can_script = s.can_place_entity{ name = spec.name, position = spec.position,
				direction = spec.direction, force = spec.force, build_check_type = bct.script }
			local can_manual = s.can_place_entity{ name = spec.name, position = spec.position,
				direction = spec.direction, force = spec.force, build_check_type = bct.manual }
			local can_default = s.can_place_entity{ name = spec.name, position = spec.position,
				direction = spec.direction, force = spec.force }
			local can_offfoundation = s.can_place_entity{ name = spec.name, position = { 25.5, 2.5 },
				direction = 0, force = 'player', build_check_type = bct.script }
			local overhang = s.create_entity{ name = 'solar-panel', position = { 21.5, 2.5 }, force = 'player' }
			local can_overhang = s.can_place_entity{ name = spec.name, position = { 22.5, 2.5 },
				direction = 0, force = 'player', build_check_type = bct.script }
			local overhang_hits = {}
			for _, e in pairs(s.find_entities_filtered{ area = { { 22, 2 }, { 23, 3 } } }) do
				overhang_hits[#overhang_hits + 1] = e.name
			end
			return { at_target = at_target, can_script = can_script, can_manual = can_manual,
				can_default = can_default, can_offfoundation = can_offfoundation,
				overhang_placed = (overhang ~= nil and overhang.valid), can_overhang = can_overhang,
				overhang_hits = overhang_hits }
		`);
		note(`can_place_entity(wooden-chest @14.5,2.5): script=${gate.can_script} manual=${gate.can_manual} `
			+ `default=${gate.can_default}; off-foundation(25.5,2.5) script=${gate.can_offfoundation}; `
			+ `entities in (13,1)-(17,5): ${asArray(gate.at_target).join(", ") || "(none)"}`);
		note(`fallback fixture (panel at 21.5 overhanging the x=21 foundation edge): placed=${gate.overhang_placed} `
			+ `can_place(22.5,2.5) script=${gate.can_overhang} `
			+ `entities in (22,2)-(23,3): ${asArray(gate.overhang_hits).join(", ") || "(none)"}`);
		check(asArray(gate.at_target).some(e => e.startsWith("solar-panel@14.50,2.50")),
			"CONTROL: the blocker is physically at the paste target, so a force-paste that replaces "
			+ "nothing cannot be explained by an absent fixture",
			`at_target=${asArray(gate.at_target).join(", ")}`);

		const forced = lua(`
			local ok, r = pcall(remote.call, 'surface_export', 'selection_lab_drive', 'force',
				${LAB_PLAYER}, 14, 2, 16, 4, '${setup.surface}')
			if not ok then return { raised = true, err = tostring(r) } end
			return { raised = false, ok = r.ok == true, err = tostring(r.err or ''),
				outcome = (r.report and r.report.outcome) or '',
				blockers_replaced = (r.report and r.report.blockers_replaced) or -1,
				blockers_guarded = (r.report and r.report.blockers_guarded) or -1,
				error_detail = (r.report and tostring(r.report.error or '')) or '' }
		`);
		check(forced.raised !== true,
			"a force-paste onto an entity-occupied position does not RAISE out of the selection lab",
			forced.raised ? forced.err : "");
		check(forced.raised !== true && forced.outcome === "force_pasted",
			"the force-paste completes",
			`outcome=${forced.outcome || "(none)"} ${forced.error_detail || ""}`);
		check(forced.raised !== true && forced.blockers_replaced === 1 && forced.blockers_guarded === 0,
			"PIN (read through the production path): the force-paste REPLACES the solar-panel blocker, so "
			+ "force_execute's blocker-snapshot branch is entered and EntityScanner.serialize_entity runs "
			+ "on a no-handler entity — which is what makes the arming at selection-lab.lua load-bearing "
			+ "here. Break that arming and this suite goes red on the raise.",
			`blockers_replaced=${forced.blockers_replaced} blockers_guarded=${forced.blockers_guarded}`);
	}
} catch (probeError) {
	failures += 1;
	process.exitCode = 1;
	console.error(`  FAIL  probe threw: ${probeError && probeError.message ? probeError.message : probeError}`);
} finally {
	try {
		const swept = lua(`
			local removed = 0
			for _, pl in pairs(game.forces.player.platforms) do
				if pl.valid and pl.name == '${PROBE}' and pl.surface and pl.surface.valid then
					game.delete_surface(pl.surface) removed = removed + 1
				end
			end
			if storage.__selab_probe_saved ~= nil then
				storage.selection_lab = storage.selection_lab or {}
				storage.selection_lab[${LAB_PLAYER}] = storage.__selab_probe_saved
			elseif storage.selection_lab then
				storage.selection_lab[${LAB_PLAYER}] = nil
				local n = 0
				for _ in pairs(storage.selection_lab) do n = n + 1 end
				if n == 0 then storage.selection_lab = nil end
			end
			storage.__selab_probe_saved = nil
			${prevDebug === null ? "" : `remote.call('surface_export', 'configure', { debug_mode = ${prevDebug} })`}
			return { removed = removed }
		`);
		console.log(`  cleanup: delete_surface issued for ${swept.removed} probe platform(s); debug_mode `
			+ (prevDebug === null ? "left alone (never written — the pre-read failed)" : `restored to ${prevDebug}`));
		await sleep(3000);
		const residue = lua(`
			local surfaces = {}
			for name, _ in pairs(game.surfaces) do
				if name:sub(1, ${PROBE_PREFIX.length}) == '${PROBE_PREFIX}' then surfaces[#surfaces + 1] = name end
			end
			local platforms = 0
			for _, pl in pairs(game.forces.player.platforms) do
				if pl.valid and pl.name:sub(1, ${PROBE_PREFIX.length}) == '${PROBE_PREFIX}' then platforms = platforms + 1 end
			end
			return { surfaces = surfaces, platforms = platforms,
				scratch = storage.__selab_probe_saved ~= nil,
				lab = (storage.selection_lab ~= nil and storage.selection_lab[${LAB_PLAYER}] ~= nil) }
		`);
		const leftoverSurfaces = asArray(residue.surfaces);
		check(leftoverSurfaces.length === 0 && residue.platforms === 0,
			"zero leftovers: no probe surface or platform survives",
			`surfaces=${leftoverSurfaces.join(",") || "(none)"} platforms=${residue.platforms}`);
		check(residue.scratch === false, "zero leftovers: the storage.__selab_probe_saved scratch key is cleared");
		check(residue.lab === (setup?.lab_state_was_live === true),
			"zero leftovers: storage.selection_lab is back to the state the probe found",
			`live_before=${setup?.lab_state_was_live === true} live_after=${residue.lab}`);
	} catch (sweepError) {
		failures += 1;
		process.exitCode = 1;
		console.error(`  FAIL  cleanup threw: ${sweepError && sweepError.message ? sweepError.message : sweepError}`);
		console.error("  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix selab-armed- is in its sweep list)");
	}
}

if (failures) {
	console.log(`=== unarmed-fluid-registry: ${failures} FAILURE(S) ===`);
	process.exit(1);
}
console.log("=== unarmed-fluid-registry: ALL PASS ===");
