#!/usr/bin/env node
// lab-paste-conflict — does the selection lab's paste conflict-refusal path ever fire, and which
// defines.build_check_type would make it fire?
//
// requires: a running surface-export cluster (host-1); debug_mode togglable via the configure remote;
//           a player record at index 1 (force_execute dereferences player.force and player.index)
// produces: exit 0 when a paste onto an occupied target is REFUSED and nothing lands there, when a
//           force onto the same target replaces the blocker, and when the two exempted record shapes
//           keep their exemption; a measured defines.build_check_type x placement-case matrix with a
//           laid-tile control and a nauvis cross-surface control, plus a measured per-record-shape
//           matrix, all printed as NOTE lines
// does not: assert any terrain or off-foundation rule (the refusal predicate is an entity footprint
//           scan and has no terrain component — pasting off the platform edge is left to fail at
//           create_entity as it does today), assert what a blocker SNAPSHOT contains or that undo
//           restores it, measure the interactive selection-lab GUI tool, perform a transfer, exercise
//           undo/redo, or assert item or fluid amounts

import { execFileSync } from "node:child_process";

const INSTANCE = process.env.SE_LAB_INSTANCE || "clusterio-host-1-instance-1";
const TAG = Date.now().toString(36);
const PROBE = `labconflict-${TAG}`;
const PROBE_PREFIX = "labconflict-";
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

// A drive result is a self-report. Every refusal/replacement claim below is paired with one of these
// physical scans of the destination area.
const scanArea = (surface, x1, y1, x2, y2) => asArray(lua(`
	local s = game.surfaces['${surface}']
	local hits = {}
	for _, e in pairs(s.find_entities_filtered{ area = { { ${x1}, ${y1} }, { ${x2}, ${y2} } } }) do
		hits[#hits + 1] = string.format('%s:%s@%.2f,%.2f', e.name, e.type, e.position.x, e.position.y)
	end
	table.sort(hits)
	return { hits = hits }
`).hits);

console.log(`=== lab-paste-conflict: is the lab's conflict refusal reachable? (${PROBE}) ===`);

let setup = null;
// Read BEFORE anything writes it: a setup body that raises after its own configure() call does not
// roll back, so a prevDebug taken from that body's return value would restore the wrong value.
let prevDebug = null;
try {
	prevDebug = lua(`
		return { debug = (storage.surface_export_config and storage.surface_export_config.debug_mode) == true }
	`).debug === true;

	setup = lua(`
		remote.call('surface_export', 'configure', { debug_mode = true })
		storage.selection_lab = storage.selection_lab or {}
		storage.__labconflict_saved = storage.selection_lab[${LAB_PLAYER}]
		storage.selection_lab[${LAB_PLAYER}] = nil
		local p = game.forces.player.create_space_platform{ name = '${PROBE}', planet = 'nauvis',
			starter_pack = 'space-platform-starter-pack' }
		if not p then return { ok = false, err = 'platform not created' } end
		p.apply_starter_pack()
		local s, force = p.surface, game.forces.player
		local tiles = {}
		for x = 4, 42 do for y = 0, 26 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } } end end
		s.set_tiles(tiles)
		local made = {}
		local function put(spec)
			local ok, e = pcall(function() return s.create_entity(spec) end)
			made[#made + 1] = spec.name .. '=' .. (ok and tostring(e ~= nil and e.valid) or ('RAISED ' .. tostring(e)))
			return ok and e or nil
		end
		local chest = put{ name = 'wooden-chest', position = { 6.5, 2.5 }, force = force }
		put{ name = 'solar-panel', position = { 14.5, 2.5 }, force = force }
		put{ name = 'solar-panel', position = { 22.5, 2.5 }, force = force }
		put{ name = 'entity-ghost', inner_name = 'wooden-chest', position = { 6.5, 8.5 }, force = force }
		put{ name = 'solar-panel', position = { 14.5, 8.5 }, force = force }
		put{ name = 'item-on-ground', position = { 6.5, 14.5 }, stack = { name = 'iron-plate', count = 5 } }
		put{ name = 'solar-panel', position = { 14.5, 14.5 }, force = force }
		put{ name = 'solar-panel', position = { 22.5, 14.5 }, force = force }
		local pchest = put{ name = 'wooden-chest', position = { 6.5, 20.5 }, force = force }
		put{ name = 'item-request-proxy', position = { 6.5, 20.5 }, force = force, target = pchest,
			modules = { { id = { name = 'iron-plate' },
				items = { in_inventory = { { inventory = defines.inventory.chest, stack = 1, count = 10 } } } } } }
		put{ name = 'item-on-ground', position = { 32.5, 2.5 }, stack = { name = 'copper-plate', count = 3 } }
		put{ name = 'entity-ghost', inner_name = 'wooden-chest', position = { 34.5, 2.5 }, force = force }
		local mchest = put{ name = 'wooden-chest', position = { 36.5, 2.5 }, force = force }
		put{ name = 'item-request-proxy', position = { 36.5, 2.5 }, force = force, target = mchest,
			modules = { { id = { name = 'iron-plate' },
				items = { in_inventory = { { inventory = defines.inventory.chest, stack = 1, count = 10 } } } } } }
		local pl = game.get_player(${LAB_PLAYER})
		return { ok = true, surface = s.name, platform = p.index, made = made,
			source_chest = (chest ~= nil and chest.valid),
			player = (pl ~= nil and pl.valid), player_force = (pl and pl.force.name) or '',
			lab_state_was_live = storage.__labconflict_saved ~= nil }
	`);
	if (setup.ok !== true) throw new Error(`probe setup refused: ${setup.err}`);
	const SURF = setup.surface;
	note(`fixtures: ${asArray(setup.made).join(" ")}`);
	check(setup.source_chest === true, "probe fixture: the copy-source wooden-chest exists at (6.5, 2.5)");

	// ---------------------------------------------------------------------------------------------
	// Phase 1 — defines.build_check_type x placement-case. The member list is ENUMERATED off the
	// engine, not typed here, and every call is pcall'd so a refused combination is characterised.
	// ---------------------------------------------------------------------------------------------
	const matrix = lua(`
		local s = game.surfaces['${SURF}']
		local types = {}
		for tname, _ in pairs(defines.build_check_type) do types[#types + 1] = tname end
		table.sort(types)
		local cases = {
			{ key = 'clear_foundation', pos = { 30.5, 2.5 } },
			{ key = 'entity_blocker', pos = { 14.5, 2.5 } },
			{ key = 'off_foundation', pos = { 46.5, 2.5 } },
			{ key = 'ground_item', pos = { 32.5, 2.5 } },
			{ key = 'matching_ghost', pos = { 34.5, 2.5 } },
		}
		local tiles = {}
		for _, c in ipairs(cases) do tiles[c.key] = s.get_tile(c.pos[1], c.pos[2]).name end
		local nauvis = game.surfaces['nauvis']
		local npos = nauvis and nauvis.find_non_colliding_position('wooden-chest', { 0, 0 }, 64, 1) or nil
		local out, control = {}, {}
		for _, tname in ipairs(types) do
			for _, c in ipairs(cases) do
				local ok, res = pcall(function()
					return s.can_place_entity{ name = 'wooden-chest', position = c.pos, direction = 0,
						force = 'player', build_check_type = defines.build_check_type[tname] }
				end)
				out[tname .. '|' .. c.key] = ok and tostring(res) or ('RAISED ' .. tostring(res))
			end
			if npos then
				local ok, res = pcall(function()
					return nauvis.can_place_entity{ name = 'wooden-chest', position = npos, direction = 0,
						force = 'player', build_check_type = defines.build_check_type[tname] }
				end)
				control[tname] = ok and tostring(res) or ('RAISED ' .. tostring(res))
			end
		end
		return { types = types, out = out, tiles = tiles, control = control,
			nauvis_pos = npos and string.format('%.1f,%.1f', npos.x, npos.y) or '' }
	`);
	const TYPES = asArray(matrix.types);
	const cell = (t, c) => matrix.out[`${t}|${c}`];
	note(`defines.build_check_type members (enumerated at the pin): ${TYPES.join(", ")}`);
	note(`tile under each case: clear_foundation=${matrix.tiles.clear_foundation} `
		+ `entity_blocker=${matrix.tiles.entity_blocker} off_foundation=${matrix.tiles.off_foundation} `
		+ `ground_item=${matrix.tiles.ground_item} matching_ghost=${matrix.tiles.matching_ghost}`);
	check(matrix.tiles.clear_foundation === "space-platform-foundation"
		&& matrix.tiles.off_foundation !== "space-platform-foundation",
		"CONTROL: the 'clear foundation' case really is laid foundation and the 'off foundation' case "
		+ "really is not — without this, a check type that answers false everywhere cannot be told apart "
		+ "from a probe that never laid any tiles",
		`clear=${matrix.tiles.clear_foundation} off=${matrix.tiles.off_foundation}`);
	for (const t of TYPES) {
		note(`can_place_entity(wooden-chest, ${t}): clear=${cell(t, "clear_foundation")} `
			+ `blocker=${cell(t, "entity_blocker")} off_foundation=${cell(t, "off_foundation")} `
			+ `ground_item=${cell(t, "ground_item")} matching_ghost=${cell(t, "matching_ghost")} `
			+ `| nauvis clear control=${matrix.control[t]}`);
	}
	note(`nauvis control position (find_non_colliding_position for wooden-chest): ${matrix.nauvis_pos || "(none)"}`);
	check(TYPES.some(t => matrix.control[t] === "true") && TYPES.some(t => matrix.control[t] === "false"),
		"CONTROL: on an ordinary nauvis surface the same call form DISCRIMINATES — at least one check "
		+ "type answers true at a non-colliding position and at least one answers false — so a matrix "
		+ "that does not discriminate on the platform is a fact about the platform, not a malformed spec",
		TYPES.map(t => `${t}=${matrix.control[t]}`).join(" "));

	const usable = TYPES.filter(t => cell(t, "clear_foundation") === "true" && cell(t, "entity_blocker") === "false");
	note(`build_check_types satisfying (clear=true, blocker=false): ${usable.join(", ") || "(NONE)"}`);
	check(usable.length === 0,
		"PIN: NO defines.build_check_type both admits a clear space-platform foundation target and "
		+ "refuses an entity-occupied one — the four non-script types answer false even on clear "
		+ "foundation, the two script types answer true even off foundation. This is why conflict "
		+ "refusal is built on the footprint scan and not on can_place_entity. If a future pin makes a "
		+ "check type discriminate here, this goes red and the construction is worth revisiting.",
		`candidates=${usable.join(",") || "none"}`);

	// ---------------------------------------------------------------------------------------------
	// Phase 2 — the SHAPES plan_targets exempts, plus the ghost shape it does not. This decides
	// whether force_execute (which exempts nothing) would destroy a live entity to place a
	// placeholder once the check type actually detects collisions.
	// ---------------------------------------------------------------------------------------------
	const shapes = lua(`
		local s = game.surfaces['${SURF}']
		local types = {}
		for tname, _ in pairs(defines.build_check_type) do types[#types + 1] = tname end
		table.sort(types)
		local specs = {
			{ key = 'entity_ghost_over_entity', spec = { name = 'entity-ghost', inner_name = 'wooden-chest', position = { 14.5, 2.5 } } },
			{ key = 'entity_ghost_over_clear', spec = { name = 'entity-ghost', inner_name = 'wooden-chest', position = { 30.5, 2.5 } } },
			{ key = 'proxy_over_its_target', spec = { name = 'item-request-proxy', position = { 36.5, 2.5 } } },
			{ key = 'proxy_over_clear', spec = { name = 'item-request-proxy', position = { 30.5, 2.5 } } },
			{ key = 'ground_item_name_as_entity', spec = { name = 'iron-plate', position = { 30.5, 2.5 } } },
		}
		local out = {}
		for _, tname in ipairs(types) do
			for _, c in ipairs(specs) do
				local spec = {}
				for k, v in pairs(c.spec) do spec[k] = v end
				spec.direction = 0
				spec.force = 'player'
				spec.build_check_type = defines.build_check_type[tname]
				local ok, res = pcall(function() return s.can_place_entity(spec) end)
				out[tname .. '|' .. c.key] = ok and tostring(res) or ('RAISED ' .. tostring(res))
			end
		end
		return { out = out }
	`);
	const scell = (t, c) => shapes.out[`${t}|${c}`];
	for (const t of TYPES) {
		note(`shape matrix (${t}): ghost_over_entity=${scell(t, "entity_ghost_over_entity")} `
			+ `ghost_over_clear=${scell(t, "entity_ghost_over_clear")} `
			+ `proxy_over_target=${scell(t, "proxy_over_its_target")} `
			+ `proxy_over_clear=${scell(t, "proxy_over_clear")} `
			+ `ground_item_name=${String(scell(t, "ground_item_name_as_entity")).slice(0, 90)}`);
	}
	check(TYPES.every(t => scell(t, "proxy_over_clear") === "false"),
		"PIN: an item-request-proxy is refused by can_place_entity under EVERY check type even over a "
		+ "CLEAR tile — so the plan_targets proxy exemption is not about proxies overlapping their "
		+ "targets, it is the only thing that stops every proxy-bearing paste being refused",
		TYPES.map(t => `${t}=${scell(t, "proxy_over_clear")}`).join(" "));
	check(TYPES.every(t => String(scell(t, "ground_item_name_as_entity")).startsWith("RAISED")),
		"PIN: an item name handed to can_place_entity as an EntityID RAISES under every check type — "
		+ "a ground-item record's name is an item prototype, so no check type makes that call safe",
		String(scell(TYPES[0], "ground_item_name_as_entity")).slice(0, 120));

	if (setup.player !== true) {
		check(false, `production-path arms UNEXERCISED — no player record at index ${LAB_PLAYER} on `
			+ `${INSTANCE}, and force_execute dereferences player.force before it reaches its blocker branch`,
			"this is a gap, not a pass");
	} else {
		note(`game.get_player(${LAB_PLAYER}) resolves (force ${setup.player_force})`);
		const drive = (mode, x1, y1, x2, y2) => lua(`
			local ok, r = pcall(remote.call, 'surface_export', 'selection_lab_drive', '${mode}',
				${LAB_PLAYER}, ${x1}, ${y1}, ${x2}, ${y2}, '${SURF}')
			if not ok then return { raised = true, err = tostring(r) } end
			return { raised = false, ok = r.ok == true, err = tostring(r.err or ''),
				outcome = (r.report and r.report.outcome) or '',
				records = (r.report and r.report.records) or -1,
				created = (r.report and r.report.created) or -1,
				conflicts = (r.report and r.report.conflicts) or -1,
				targets = (r.report and r.report.targets) or -1,
				blockers_replaced = (r.report and r.report.blockers_replaced) or -1,
				blockers_guarded = (r.report and r.report.blockers_guarded) or -1,
				error_detail = (r.report and tostring(r.report.error or '')) or '' }
		`);

		// --- Shape A: a plain entity record over an entity blocker -------------------------------
		const copyA = drive("copy", 6, 2, 8, 4);
		check(copyA.raised !== true && copyA.outcome === "copied" && copyA.records === 1,
			"shape A setup: the lab copies the plain wooden-chest record",
			`outcome=${copyA.outcome} records=${copyA.records} ${copyA.err || copyA.error_detail}`);

		const pasteA = drive("paste", 14, 2, 16, 4);
		const afterPasteA = scanArea(SURF, 13, 1, 17, 5);
		note(`shape A paste report: outcome=${pasteA.outcome} conflicts=${pasteA.conflicts} `
			+ `targets=${pasteA.targets} created=${pasteA.created}`);
		note(`shape A destination after paste: ${afterPasteA.join(", ") || "(empty)"}`);
		check(pasteA.raised !== true && pasteA.outcome === "refused" && pasteA.conflicts === 1,
			"SHAPE A (plain entity record): a paste onto a target occupied by a solar-panel is REFUSED "
			+ "— the conflict branch that prints PASTE REFUSED is REACHED",
			`outcome=${pasteA.outcome || "(none)"} conflicts=${pasteA.conflicts}`);
		check(!afterPasteA.some(h => h.startsWith("wooden-chest:"))
			&& afterPasteA.some(h => h.startsWith("solar-panel:")),
			"SHAPE A physical arm: nothing was placed at the refused target and the blocker is untouched "
			+ "(the refusal is a fact about the world, not a self-report)",
			afterPasteA.join(", ") || "(empty)");

		// --- Shape A, paste onto the capture's own source -----------------------------------------
		const pasteSelf = drive("paste", 6, 2, 8, 4);
		check(pasteSelf.raised !== true && pasteSelf.outcome === "refused",
			"SHAPE A self-paste: pasting a capture back onto the area it came from is REFUSED, because "
			+ "the source entity occupies the target — pinned deliberately, this is the honest reading "
			+ "of an occupied target and not a defect",
			`outcome=${pasteSelf.outcome || "(none)"} conflicts=${pasteSelf.conflicts}`);

		// --- Shape A force: the blocker branch of force_execute -----------------------------------
		const forceA = drive("force", 22, 2, 24, 4);
		const afterForceA = scanArea(SURF, 21, 1, 25, 5);
		note(`shape A force report: outcome=${forceA.outcome} blockers_replaced=${forceA.blockers_replaced} `
			+ `blockers_guarded=${forceA.blockers_guarded} created=${forceA.created} ${forceA.error_detail}`);
		note(`shape A force destination: ${afterForceA.join(", ") || "(empty)"}`);
		check(forceA.raised !== true && forceA.outcome === "force_pasted" && forceA.blockers_replaced === 1,
			"SHAPE A force: force-pasting over the same class of blocker REPLACES it — force_execute's "
			+ "blocker-snapshot branch is REACHED",
			`outcome=${forceA.outcome || "(none)"} replaced=${forceA.blockers_replaced} guarded=${forceA.blockers_guarded}`);
		check(afterForceA.some(h => h.startsWith("wooden-chest:"))
			&& !afterForceA.some(h => h.startsWith("solar-panel:")),
			"SHAPE A force physical arm: the chest is really there and the solar-panel is really gone",
			afterForceA.join(", ") || "(empty)");

		// --- Shape B: an entity-ghost record over an entity blocker -------------------------------
		const copyB = drive("copy", 6, 8, 8, 10);
		const ghostRec = lua(`
			local st = storage.selection_lab and storage.selection_lab[${LAB_PLAYER}]
			local rec = st and st.export and st.export.records and st.export.records[1]
			if not rec then return { present = false } end
			return { present = true, name = tostring(rec.name), type = tostring(rec.type),
				ghost_name = tostring(rec.specific_data and rec.specific_data.ghost_name or '') }
		`);
		note(`shape B captured record: name=${ghostRec.name} type=${ghostRec.type} ghost_name=${ghostRec.ghost_name}`);
		check(copyB.raised !== true && copyB.outcome === "copied" && ghostRec.name === "entity-ghost"
			&& ghostRec.ghost_name === "wooden-chest",
			"shape B setup: the capture really is an entity-ghost record whose name is the EntityID "
			+ "place_spec passes and whose ghost_name becomes inner_name",
			`outcome=${copyB.outcome} name=${ghostRec.name} ghost_name=${ghostRec.ghost_name}`);

		const pasteB = drive("paste", 14, 8, 16, 10);
		const afterPasteB = scanArea(SURF, 13, 7, 17, 11);
		note(`shape B paste report: outcome=${pasteB.outcome} conflicts=${pasteB.conflicts} `
			+ `created=${pasteB.created} ${pasteB.err || pasteB.error_detail}`);
		note(`shape B destination after paste: ${afterPasteB.join(", ") || "(empty)"}`);
		check(pasteB.raised !== true && pasteB.outcome === "refused" && pasteB.conflicts === 1,
			"SHAPE B (entity-ghost record, unexempted by plan_targets): a paste onto a target occupied "
			+ "by a solar-panel is REFUSED",
			`outcome=${pasteB.outcome || "(none)"} conflicts=${pasteB.conflicts}`);
		check(!afterPasteB.some(h => h.includes(":entity-ghost@")),
			"SHAPE B physical arm: no ghost was placed at the refused target",
			afterPasteB.join(", ") || "(empty)");

		// --- Shape C: an item-on-ground record — EXEMPTED in plan_targets, unexempted in force -----
		const copyC = drive("copy", 6, 14, 8, 16);
		check(copyC.raised !== true && copyC.outcome === "copied" && copyC.records === 1,
			"shape C setup: the lab copies the iron-plate item-on-ground record",
			`outcome=${copyC.outcome} records=${copyC.records} ${copyC.err}`);

		const pasteC = drive("paste", 14, 14, 16, 16);
		const afterPasteC = scanArea(SURF, 13, 13, 17, 17);
		note(`shape C paste report: outcome=${pasteC.outcome} conflicts=${pasteC.conflicts} created=${pasteC.created}`);
		note(`shape C destination after paste: ${afterPasteC.join(", ") || "(empty)"}`);
		check(pasteC.raised !== true && pasteC.outcome === "pasted" && pasteC.conflicts === -1,
			"SHAPE C (item-on-ground): the plan_targets exemption still holds — a ground item pastes "
			+ "onto an entity-occupied target instead of being refused, because an item can lie under "
			+ "a machine",
			`outcome=${pasteC.outcome || "(none)"} conflicts=${pasteC.conflicts}`);
		check(afterPasteC.some(h => h.startsWith("item-on-ground:"))
			&& afterPasteC.some(h => h.startsWith("solar-panel:")),
			"SHAPE C physical arm: the ground item really landed and the solar-panel is untouched",
			afterPasteC.join(", ") || "(empty)");

		const forceC = drive("force", 22, 14, 24, 16);
		const afterForceC = scanArea(SURF, 21, 13, 25, 17);
		note(`shape C FORCE report: raised=${forceC.raised} outcome=${forceC.outcome} `
			+ `err=${String(forceC.err || forceC.error_detail).slice(0, 220)}`);
		note(`shape C force destination: ${afterForceC.join(", ") || "(empty)"}`);
		check(forceC.raised !== true,
			"SHAPE C force: a force-paste whose capture holds a ground item does not RAISE out of the "
			+ "lab — force_execute must not hand an item prototype name to can_place_entity as an EntityID",
			String(forceC.err).slice(0, 300));

		// --- Shape D: an item-request-proxy record ------------------------------------------------
		const copyD = drive("copy", 6, 20, 8, 22);
		const proxyRecs = lua(`
			local st = storage.selection_lab and storage.selection_lab[${LAB_PLAYER}]
			local recs = (st and st.export and st.export.records) or {}
			local kinds = {}
			for _, rec in ipairs(recs) do kinds[#kinds + 1] = tostring(rec.type) .. '/' .. tostring(rec.name) end
			table.sort(kinds)
			return { kinds = kinds }
		`);
		const kindsD = asArray(proxyRecs.kinds);
		note(`shape D captured records: ${kindsD.join(", ") || "(none)"}`);
		check(copyD.raised !== true && copyD.outcome === "copied"
			&& kindsD.some(k => k.startsWith("item-request-proxy/")),
			"shape D setup: the capture really holds an item-request-proxy record sharing its target's "
			+ "position (this is the shape plan_targets exempts by name)",
			`outcome=${copyD.outcome} kinds=${kindsD.join(",")} ${copyD.err}`);

		const pasteD = drive("paste", 14, 20, 16, 22);
		const afterPasteD = scanArea(SURF, 13, 19, 17, 23);
		note(`shape D paste report: outcome=${pasteD.outcome} created=${pasteD.created} `
			+ `conflicts=${pasteD.conflicts} ${pasteD.error_detail}`);
		note(`shape D destination after paste: ${afterPasteD.join(", ") || "(empty)"}`);
		check(pasteD.raised !== true && pasteD.outcome === "pasted",
			"SHAPE D (item-request-proxy on its target): a proxy capture still pastes onto a CLEAR "
			+ "destination — the conflict check must not refuse a proxy that legitimately shares its "
			+ "target's position",
			`outcome=${pasteD.outcome || "(none)"} ${pasteD.error_detail}`);
		check(afterPasteD.some(h => h.startsWith("wooden-chest:"))
			&& afterPasteD.some(h => h.startsWith("item-request-proxy:")),
			"SHAPE D physical arm: both the chest and its proxy are really at the destination",
			afterPasteD.join(", ") || "(empty)");
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
			if storage.__labconflict_saved ~= nil then
				storage.selection_lab = storage.selection_lab or {}
				storage.selection_lab[${LAB_PLAYER}] = storage.__labconflict_saved
			elseif storage.selection_lab then
				storage.selection_lab[${LAB_PLAYER}] = nil
				local n = 0
				for _ in pairs(storage.selection_lab) do n = n + 1 end
				if n == 0 then storage.selection_lab = nil end
			end
			storage.__labconflict_saved = nil
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
				scratch = storage.__labconflict_saved ~= nil,
				lab = (storage.selection_lab ~= nil and storage.selection_lab[${LAB_PLAYER}] ~= nil) }
		`);
		const leftoverSurfaces = asArray(residue.surfaces);
		check(leftoverSurfaces.length === 0 && residue.platforms === 0,
			"zero leftovers: no probe surface or platform survives",
			`surfaces=${leftoverSurfaces.join(",") || "(none)"} platforms=${residue.platforms}`);
		check(residue.scratch === false, "zero leftovers: the storage.__labconflict_saved scratch key is cleared");
		check(residue.lab === (setup?.lab_state_was_live === true),
			"zero leftovers: storage.selection_lab is back to the state the probe found",
			`live_before=${setup?.lab_state_was_live === true} live_after=${residue.lab}`);
	} catch (sweepError) {
		failures += 1;
		process.exitCode = 1;
		console.error(`  FAIL  cleanup threw: ${sweepError && sweepError.message ? sweepError.message : sweepError}`);
		console.error("  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix labconflict- is in its sweep list)");
	}
}

if (failures) {
	console.log(`=== lab-paste-conflict: ${failures} FAILURE(S) ===`);
	process.exit(1);
}
console.log("=== lab-paste-conflict: ALL PASS ===");
