#!/usr/bin/env node
// unarmed-fluid-registry — do the NON-production callers of EntityScanner.serialize_entity arm the
// FluidRegistry that InventoryScanner.extract_fluidboxes raises without?
//
// requires: a running surface-export cluster (host-1); debug_mode togglable via the configure remote
// produces: exit 0 when test_import_entity re-exports a no-handler entity (solar-panel), and when
//           force_execute's blocker gate still measures as unreachable through place_spec
// does not: exercise force_execute's blocker-snapshot branch (measured unreachable — see the PINNED
//           MEASUREMENT check), perform a transfer, assert fluid AMOUNTS, exercise the interactive
//           selection-lab tool, or prove a destroyed blocker's fluids come back on rollback

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
let prevDebug = false;
try {
	setup = lua(`
		local prev_debug = (storage.surface_export_config and storage.surface_export_config.debug_mode) == true
		remote.call('surface_export', 'configure', { debug_mode = true })
		storage.selection_lab = storage.selection_lab or {}
		storage.__selab_probe_saved = storage.selection_lab[${LAB_PLAYER}]
		storage.selection_lab[${LAB_PLAYER}] = nil
		local p = game.forces.player.create_space_platform{ name = '${PROBE}', planet = 'nauvis',
			starter_pack = 'space-platform-starter-pack' }
		if not p then return { ok = false, prev_debug = prev_debug, err = 'platform not created' } end
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
		return { ok = true, prev_debug = prev_debug, surface = s.name, platform = p.index,
			chest = (chest ~= nil and chest.valid), panel = (panel ~= nil and panel.valid),
			roster = roster, connected = #game.connected_players,
			player = (pl ~= nil and pl.valid), player_force = (pl and pl.force.name) or '',
			lab_state_was_live = storage.__selab_probe_saved ~= nil }
	`);
	prevDebug = setup.prev_debug === true;
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

		// force_execute only reaches the blocker snapshot when can_place_entity is FALSE, and it asks
		// with build_check_type.script (place_spec). A fixture whose blocker does not make THAT call
		// fail cannot exercise the line under test, so the precondition is measured, not assumed.
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
		check(gate.can_script === true && gate.can_manual === false,
			"PINNED MEASUREMENT: a solar-panel sitting on the target position blocks can_place_entity under "
			+ "build_check_type.manual but NOT under .script, which is the type place_spec hardcodes — so "
			+ "force_execute's blocker-snapshot branch (selection-lab.lua) is not reachable through it. When "
			+ "this check fails the branch has become live and needs the real blocker assertions restored.",
			`script=${gate.can_script} manual=${gate.can_manual} default=${gate.can_default} `
			+ `at_target=${asArray(gate.at_target).join(", ")}`);

		const forced = lua(`
			local ok, r = pcall(remote.call, 'surface_export', 'selection_lab_drive', 'force',
				${LAB_PLAYER}, 14, 2, 16, 4, '${setup.surface}')
			if not ok then return { raised = true, err = tostring(r) } end
			return { raised = false, ok = r.ok == true, err = tostring(r.err or ''),
				outcome = (r.report and r.report.outcome) or '',
				blockers_replaced = (r.report and r.report.blockers_replaced) or -1,
				error_detail = (r.report and tostring(r.report.error or '')) or '' }
		`);
		check(forced.raised !== true,
			"a force-paste onto an entity-occupied position does not RAISE out of the selection lab",
			forced.raised ? forced.err : "");
		check(forced.raised !== true && forced.outcome === "force_pasted",
			"the force-paste completes",
			`outcome=${forced.outcome || "(none)"} ${forced.error_detail || ""}`);
		check(forced.raised !== true && forced.blockers_replaced === 0,
			"and it replaces NO blocker, which is what the pinned gate measurement above predicts — the "
			+ "solar-panel is left standing and the pasted chest overlaps it",
			`blockers_replaced=${forced.blockers_replaced}`);
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
			remote.call('surface_export', 'configure', { debug_mode = ${prevDebug} })
			return { removed = removed }
		`);
		console.log(`  cleanup: delete_surface issued for ${swept.removed} probe platform(s); debug_mode restored to ${prevDebug}`);
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
