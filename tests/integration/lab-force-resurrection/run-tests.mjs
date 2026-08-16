#!/usr/bin/env node
// lab-force-resurrection — when the selection lab's FORCE replaces a blocker, does that blocker come
// back WHOLE on undo, and what does force do with a blocker it refuses to destroy?
//
// requires: a running surface-export cluster (host-1); debug_mode togglable via the configure remote;
//           a player record at index 1 (force_execute dereferences player.force and player.index)
// produces: exit 0 when a resurrected blocker arrives with its container inventory AND its belt items,
//           when one unrestorable record does not void its siblings' restores, when a foreign-force
//           blocker is not silently overlapped, when the item-request-proxy plan exemption still
//           admits a proxy whose target already stands at the destination, and when a resurrected
//           belt run does not gain items; plus measured NOTE lines for both fluid arms
// does not: measure the interactive selection-lab GUI tool (every arm drives the selection_lab_drive
//           remote), perform a transfer, re-assert the paste conflict-refusal predicate (that is
//           tests/integration/lab-paste-conflict), exercise redo, or exercise the character and
//           space-platform-hub arms of the blocker guard (no character stands on a probe platform and
//           the hub is the platform's own) — only the foreign-force arm of that guard is measured

import { execFileSync } from "node:child_process";

const INSTANCE = process.env.SE_LAB_INSTANCE || "clusterio-host-1-instance-1";
const TAG = Date.now().toString(36);
const PROBE = `labforce-${TAG}`;
const PROBE_PREFIX = "labforce-";
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

console.log(`=== lab-force-resurrection: does a replaced blocker come back whole? (${PROBE}) ===`);

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
		storage.__labforce_saved = storage.selection_lab[${LAB_PLAYER}]
		storage.selection_lab[${LAB_PLAYER}] = nil
		local p = game.forces.player.create_space_platform{ name = '${PROBE}', planet = 'nauvis',
			starter_pack = 'space-platform-starter-pack' }
		if not p then return { ok = false, err = 'platform not created' } end
		p.apply_starter_pack()
		local s, force = p.surface, game.forces.player
		local tiles = {}
		for x = 4, 44 do for y = 0, 54 do tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } } end end
		s.set_tiles(tiles)
		local made = {}
		local function put(spec)
			local ok, e = pcall(function() return s.create_entity(spec) end)
			made[#made + 1] = spec.name .. '@' .. tostring(spec.position[2]) .. '='
				.. (ok and tostring(e ~= nil and e.valid) or ('RAISED ' .. tostring(e)))
			return ok and e or nil
		end
		local function belt_at(x, y, direction)
			return put{ name = 'transport-belt', position = { x, y }, direction = direction, force = force }
		end
		local function fill_line(entity, item, slots)
			local placed = 0
			if not entity then return 0 end
			local line = entity.get_transport_line(1)
			for i = 1, slots do
				if line.insert_at(i * 0.25, { name = item }) then placed = placed + 1 end
			end
			return placed
		end
		put{ name = 'wooden-chest', position = { 6.5, 2.5 }, force = force }
		put{ name = 'wooden-chest', position = { 8.5, 2.5 }, force = force }
		local filled_a = fill_line(belt_at(14.5, 2.5, defines.direction.east), 'copper-plate', 3)
		local ca = put{ name = 'wooden-chest', position = { 16.5, 2.5 }, force = force }
		if ca then ca.insert{ name = 'iron-plate', count = 7 } end
		put{ name = 'wooden-chest', position = { 6.5, 8.5 }, force = force }
		put{ name = 'wooden-chest', position = { 8.5, 8.5 }, force = force }
		local filled_b = fill_line(belt_at(14.5, 8.5, defines.direction.east), 'copper-plate', 3)
		local cb = put{ name = 'wooden-chest', position = { 16.5, 8.5 }, force = force }
		if cb then cb.insert{ name = 'iron-plate', count = 9 } end
		put{ name = 'wooden-chest', position = { 6.5, 14.5 }, force = force }
		local pipe_iso = put{ name = 'pipe', position = { 14.5, 14.5 }, force = force }
		if pipe_iso then pipe_iso.insert_fluid{ name = 'water', amount = 60 } end
		put{ name = 'wooden-chest', position = { 6.5, 20.5 }, force = force }
		local pipe_a = put{ name = 'pipe', position = { 14.5, 20.5 }, force = force }
		local pipe_b = put{ name = 'pipe', position = { 15.5, 20.5 }, force = force }
		if pipe_a then pipe_a.insert_fluid{ name = 'water', amount = 120 } end
		put{ name = 'wooden-chest', position = { 6.5, 26.5 }, force = force }
		put{ name = 'wooden-chest', position = { 8.5, 26.5 }, force = force }
		put{ name = 'wooden-chest', position = { 14.5, 26.5 }, force = game.forces.enemy }
		local src_proxy_target = put{ name = 'wooden-chest', position = { 6.5, 32.5 }, force = force }
		put{ name = 'item-request-proxy', position = { 6.5, 32.5 }, force = force, target = src_proxy_target,
			modules = { { id = { name = 'iron-plate' },
				items = { in_inventory = { { inventory = defines.inventory.chest, stack = 1, count = 10 } } } } } }
		put{ name = 'wooden-chest', position = { 14.5, 32.5 }, force = force }
		put{ name = 'wooden-chest', position = { 6.5, 38.5 }, force = force }
		put{ name = 'entity-ghost', inner_name = 'wooden-chest', position = { 14.5, 38.5 }, force = force }
		put{ name = 'wooden-chest', position = { 6.5, 44.5 }, force = force }
		put{ name = 'wooden-chest', position = { 6.5, 50.5 }, force = force }
		put{ name = 'wooden-chest', position = { 7.5, 50.5 }, force = force }
		put{ name = 'solar-panel', position = { 15.5, 50.5 }, force = force }
		local run_head = belt_at(14.5, 44.5, defines.direction.east)
		belt_at(15.5, 44.5, defines.direction.east)
		belt_at(16.5, 44.5, defines.direction.east)
		local filled_run = 0
		local run_length = run_head and run_head.get_transport_line(1).line_length or -1
		local pl = game.get_player(${LAB_PLAYER})
		local ghost = s.find_entities_filtered{ area = { { 14, 38 }, { 15, 39 } }, name = 'entity-ghost' }[1]
		local proxy = s.find_entities_filtered{ area = { { 6, 32 }, { 7, 33 } }, name = 'item-request-proxy' }[1]
		return { ok = true, surface = s.name, made = made,
			filled = string.format('arm1=%d arm2=%d run=%d (run line_length %s)', filled_a, filled_b,
				filled_run, tostring(run_length)),
			player = (pl ~= nil and pl.valid), player_force = (pl and pl.force.name) or '',
			ghost_unit_number = (ghost and ghost.unit_number) or -1,
			proxy_unit_number = (proxy and proxy.unit_number) or -1,
			enemy_force_exists = game.forces.enemy ~= nil,
			lab_state_was_live = storage.__labforce_saved ~= nil }
	`);
	if (setup.ok !== true) throw new Error(`probe setup refused: ${setup.err}`);
	const SURF = setup.surface;
	note(`fixtures: ${asArray(setup.made).join(" ")}`);
	note(`belt fill (items actually seated by insert_at): ${setup.filled}`);
	if (setup.player !== true) {
		throw new Error(`no player record at index ${LAB_PLAYER} on ${INSTANCE} — force_execute dereferences `
			+ "player.force before it reaches any blocker branch, so every arm below would be unexercised");
	}
	note(`game.get_player(${LAB_PLAYER}) resolves (force ${setup.player_force})`);

	const drive = (mode, x1, y1, x2, y2) => lua(`
		local ok, r = pcall(remote.call, 'surface_export', 'selection_lab_drive', '${mode}',
			${LAB_PLAYER}, ${x1}, ${y1}, ${x2}, ${y2}, '${SURF}')
		if not ok then return { raised = true, err = tostring(r) } end
		return { raised = false, ok = r.ok == true, err = tostring(r.err or ''),
			outcome = (r.report and r.report.outcome) or '',
			records = (r.report and r.report.records) or -1,
			created = (r.report and r.report.created) or -1,
			create_failed = (r.report and r.report.create_failed) or -1,
			conflicts = (r.report and r.report.conflicts) or -1,
			blockers_replaced = (r.report and r.report.blockers_replaced) or -1,
			blockers_guarded = (r.report and r.report.blockers_guarded) or -1,
			records_refused = (r.report and r.report.records_refused) or -1,
			blockers_resurrected = (r.report and r.report.blockers_resurrected) or -1,
			error_detail = (r.report and tostring(r.report.error or '')) or '' }
	`);

	const undo = () => lua(`
		local ok, r = pcall(remote.call, 'surface_export', 'selection_lab_drive', 'undo',
			${LAB_PLAYER}, nil, nil, nil, nil, '${SURF}')
		if not ok then return { raised = true, err = tostring(r) } end
		return { raised = false, ok = r.ok == true }
	`);

	// Every claim below is paired with one of these physical reads of the destination.
	const chestAt = (x, y) => lua(`
		local s = game.surfaces['${SURF}']
		local e = s.find_entity('wooden-chest', { ${x}, ${y} })
		if not (e and e.valid) then return { present = false, count = -1 } end
		return { present = true, count = e.get_item_count() }
	`);

	const beltRun = (x1, y1, x2, y2) => lua(`
		local s = game.surfaces['${SURF}']
		local seen, total, pieces = {}, 0, 0
		for _, e in pairs(s.find_entities_filtered{ area = { { ${x1}, ${y1} }, { ${x2}, ${y2} } },
			type = 'transport-belt' }) do
			pieces = pieces + 1
			for li = 1, e.get_max_transport_line_index() do
				for _, it in ipairs(e.get_transport_line(li).get_detailed_contents()) do
					local uid = tostring(it.unique_id)
					if not seen[uid] then seen[uid] = true total = total + it.stack.count end
				end
			end
		end
		return { total = total, pieces = pieces }
	`);

	const pipeAt = (x, y) => lua(`
		local s = game.surfaces['${SURF}']
		local e = s.find_entity('pipe', { ${x}, ${y} })
		if not (e and e.valid) then return { present = false, amount = -1 } end
		local total = 0
		for _, amount in pairs(e.get_fluid_contents()) do total = total + amount end
		return { present = true, amount = total }
	`);

	const scanArea = (x1, y1, x2, y2) => asArray(lua(`
		local s = game.surfaces['${SURF}']
		local hits = {}
		for _, e in pairs(s.find_entities_filtered{ area = { { ${x1}, ${y1} }, { ${x2}, ${y2} } } }) do
			hits[#hits + 1] = string.format('%s:%s:%s@%.2f,%.2f', e.name, e.type, e.force.name, e.position.x, e.position.y)
		end
		table.sort(hits)
		return { hits = hits }
	`).hits);

	note(`blocker-eligibility probe: entity-ghost unit_number=${setup.ghost_unit_number} `
		+ `item-request-proxy unit_number=${setup.proxy_unit_number} `
		+ "(blocking_entities admits any entity carrying a unit_number except item-entity)");

	// ---------------------------------------------------------------------------------------------
	// Arm 1 — the core resurrection: one force replaces a BELT (items on it) and a CHEST (items in
	// it); undo must bring both back with their contents.
	// ---------------------------------------------------------------------------------------------
	const copy1 = drive("copy", 6, 2, 9, 4);
	check(copy1.raised !== true && copy1.outcome === "copied" && copy1.records === 2,
		"arm 1 setup: the lab copies the two-chest capture that will land on the belt and the full chest",
		`outcome=${copy1.outcome} records=${copy1.records} ${copy1.err || copy1.error_detail}`);
	const belt1Before = beltRun(13, 1, 15, 4);
	const chest1Before = chestAt(16.5, 2.5);
	note(`arm 1 before force: belt items=${belt1Before.total} (${belt1Before.pieces} piece(s)) `
		+ `chest items=${chest1Before.count}`);
	const force1 = drive("force", 14, 2, 17, 4);
	note(`arm 1 force report: outcome=${force1.outcome} replaced=${force1.blockers_replaced} `
		+ `guarded=${force1.blockers_guarded} created=${force1.created} ${force1.error_detail}`);
	check(force1.raised !== true && force1.outcome === "force_pasted" && force1.blockers_replaced === 2,
		"arm 1: the force replaces BOTH blockers (the belt and the full chest) — the destroy/snapshot "
		+ "branch is reached for a belt-type blocker, which is the shape that used to void the batch",
		`outcome=${force1.outcome || "(none)"} replaced=${force1.blockers_replaced}`);
	const undo1 = undo();
	check(undo1.raised !== true, "arm 1: undo does not raise out of the lab", String(undo1.err || ""));
	const belt1After = beltRun(13, 1, 15, 4);
	const chest1After = chestAt(16.5, 2.5);
	note(`arm 1 after undo: belt items=${belt1After.total} (${belt1After.pieces} piece(s)) `
		+ `chest present=${chest1After.present} items=${chest1After.count}`);
	note(`arm 1 destination after undo: ${scanArea(13, 1, 18, 4).join(", ") || "(empty)"}`);
	check(chest1After.present === true && chest1After.count === chest1Before.count,
		"ARM 1 CHEST: a resurrected container blocker comes back with its inventory — the sibling of a "
		+ "belt record still gets restore_inventories",
		`before=${chest1Before.count} after=${chest1After.count}`);
	check(belt1After.pieces === belt1Before.pieces && belt1After.total === belt1Before.total,
		"ARM 1 BELT: a resurrected belt blocker comes back with its items — resurrection carries a side "
		+ "partition captured at destroy time",
		`before=${belt1Before.total} after=${belt1After.total} pieces=${belt1After.pieces}`);

	// ---------------------------------------------------------------------------------------------
	// Arm 2 — isolation. The journal's captured side partition is STRIPPED after the force, so the
	// belt record is unrestorable for a reason no capture fix can repair. Its sibling chest must
	// still be restored.
	// ---------------------------------------------------------------------------------------------
	const copy2 = drive("copy", 6, 8, 9, 10);
	check(copy2.raised !== true && copy2.outcome === "copied" && copy2.records === 2,
		"arm 2 setup: the lab copies the second two-chest capture",
		`outcome=${copy2.outcome} records=${copy2.records} ${copy2.err || copy2.error_detail}`);
	const chest2Before = chestAt(16.5, 8.5);
	const belt2Before = beltRun(13, 7, 15, 10);
	const force2 = drive("force", 14, 8, 17, 10);
	check(force2.raised !== true && force2.outcome === "force_pasted",
		"arm 2 setup: the second force replaces both blockers",
		`outcome=${force2.outcome || "(none)"} replaced=${force2.blockers_replaced} ${force2.error_detail}`);
	const stripped = lua(`
		local st = storage.selection_lab and storage.selection_lab[${LAB_PLAYER}]
		local entry = st and st.undo and st.undo[#st.undo]
		if not entry then return { found = false } end
		local had = entry.destroyed_side_groups ~= nil
		local belt_recs = 0
		for _, rec in ipairs(entry.destroyed_records or {}) do
			if rec.type == 'transport-belt' then belt_recs = belt_recs + 1 end
		end
		entry.destroyed_side_groups = nil
		return { found = true, had_side_groups = had, belt_records = belt_recs,
			destroyed_records = #(entry.destroyed_records or {}) }
	`);
	note(`arm 2 journal before the strip: entry found=${stripped.found} `
		+ `destroyed_side_groups present=${stripped.had_side_groups} `
		+ `destroyed_records=${stripped.destroyed_records} (belt records: ${stripped.belt_records})`);
	check(stripped.found === true && stripped.belt_records === 1,
		"arm 2 setup: the force journal really holds the belt blocker's record, so stripping its side "
		+ "partition makes exactly one record unrestorable",
		`found=${stripped.found} belt_records=${stripped.belt_records}`);
	const undo2 = undo();
	check(undo2.raised !== true, "arm 2: undo does not raise out of the lab even with a record it cannot "
		+ "restore", String(undo2.err || ""));
	const chest2After = chestAt(16.5, 8.5);
	const belt2After = beltRun(13, 7, 15, 10);
	note(`arm 2 after undo: chest present=${chest2After.present} items=${chest2After.count} `
		+ `(before ${chest2Before.count}) | belt items=${belt2After.total} (before ${belt2Before.total})`);
	check(chest2After.present === true && chest2After.count === chest2Before.count,
		"ARM 2 ISOLATION: one record whose belt items cannot be restored does NOT void its siblings' "
		+ "restores — the chest still comes back full",
		`before=${chest2Before.count} after=${chest2After.count}`);
	check(belt2After.pieces === belt2Before.pieces,
		"arm 2: the unrestorable belt is still re-created (only its items are lost)",
		`pieces before=${belt2Before.pieces} after=${belt2After.pieces}`);

	// ---------------------------------------------------------------------------------------------
	// Arm 3 — fluid, isolated blocker. MEASURED, not assumed: run_restores skips the fluid write
	// entirely when a restored entity's fluidbox touches an entity outside the batch.
	// ---------------------------------------------------------------------------------------------
	const copy3 = drive("copy", 6, 14, 8, 16);
	const pipe3Before = pipeAt(14.5, 14.5);
	const force3 = drive("force", 14, 14, 16, 16);
	const undo3 = undo();
	const pipe3After = pipeAt(14.5, 14.5);
	note(`arm 3 (isolated pipe blocker): copy=${copy3.outcome} force=${force3.outcome} `
		+ `undo_raised=${undo3.raised} | fluid before=${pipe3Before.amount} `
		+ `after undo present=${pipe3After.present} amount=${pipe3After.amount}`);
	check(force3.raised !== true && force3.outcome === "force_pasted" && pipe3After.present === true,
		"arm 3 setup: the isolated pipe blocker was replaced and is back after undo",
		`force=${force3.outcome || "(none)"} pipe_back=${pipe3After.present}`);
	check(Math.abs(pipe3After.amount - pipe3Before.amount) < 1e-6,
		"ARM 3 FLUID: an ISOLATED fluid blocker comes back with its fluid — the blocker snapshot's "
		+ "fluid-segment registry is captured at destroy time and written on resurrection",
		`before=${pipe3Before.amount} after=${pipe3After.amount}`);

	// ---------------------------------------------------------------------------------------------
	// Arm 4 — fluid, blocker connected to a pipe OUTSIDE the replaced set.
	// ---------------------------------------------------------------------------------------------
	const copy4 = drive("copy", 6, 20, 8, 22);
	const pipe4aBefore = pipeAt(14.5, 20.5);
	const pipe4bBefore = pipeAt(15.5, 20.5);
	const force4 = drive("force", 14, 20, 16, 22);
	const pipe4bMid = pipeAt(15.5, 20.5);
	const undo4 = undo();
	const pipe4aAfter = pipeAt(14.5, 20.5);
	const pipe4bAfter = pipeAt(15.5, 20.5);
	note(`arm 4 (pipe blocker connected to a live neighbour): copy=${copy4.outcome} force=${force4.outcome} `
		+ `undo_raised=${undo4.raised} | destroyed pipe before=${pipe4aBefore.amount} `
		+ `after undo=${pipe4aAfter.amount} | neighbour before=${pipe4bBefore.amount} `
		+ `after force=${pipe4bMid.amount} after undo=${pipe4bAfter.amount}`);
	check(force4.raised !== true && force4.outcome === "force_pasted" && pipe4aAfter.present === true,
		"arm 4 setup: the connected pipe blocker was replaced and is back after undo",
		`force=${force4.outcome || "(none)"} pipe_back=${pipe4aAfter.present}`);
	check(pipe4aAfter.amount + pipe4bAfter.amount <= pipe4bMid.amount + 1e-6,
		"ARM 4 FLUID: resurrecting a blocker whose fluid system rejoins the LIVE network creates no "
		+ "fluid — run_restores skips the segment write whenever a restored fluidbox has a neighbour "
		+ "outside the batch, so the pair holds what survived the force and not a written copy on top",
		`survived the force=${pipe4bMid.amount} after undo=${pipe4aAfter.amount}+${pipe4bAfter.amount}`);

	// ---------------------------------------------------------------------------------------------
	// Arm 5 — a GUARDED blocker (foreign force). force skips the destroy; script placement does not
	// refuse an occupied tile, so the question is whether the record lands on top of it.
	// ---------------------------------------------------------------------------------------------
	const copy5 = drive("copy", 6, 26, 9, 28);
	check(copy5.raised !== true && copy5.outcome === "copied" && copy5.records === 2,
		"arm 5 setup: the lab copies a two-chest capture — one record will land on a foreign-force "
		+ "blocker, the other on clear foundation",
		`outcome=${copy5.outcome} records=${copy5.records} ${copy5.err}`);
	const force5 = drive("force", 14, 26, 17, 28);
	const after5 = scanArea(13, 25, 18, 29);
	note(`arm 5 force report: outcome=${force5.outcome} created=${force5.created} `
		+ `guarded=${force5.blockers_guarded} refused=${force5.records_refused} `
		+ `replaced=${force5.blockers_replaced} ${force5.error_detail}`);
	note(`arm 5 destination after force: ${after5.join(", ") || "(empty)"}`);
	const guardedTile = after5.filter(h => h.includes("@14.50,26.50"));
	const clearTile = after5.filter(h => h.includes("@16.50,26.50"));
	check(guardedTile.length === 1 && guardedTile[0].includes(":enemy@"),
		"ARM 5 GUARD: the tile held by a foreign-force blocker carries exactly ONE entity after the "
		+ "force — the guarded blocker itself. A second entity here is a silent overlap",
		`tile=${guardedTile.join(", ") || "(empty)"}`);
	check(force5.blockers_guarded === 1 && force5.records_refused === 1,
		"ARM 5 REPORT: force names the guarded blocker AND the record it refused, rather than reporting "
		+ "a protected blocker it then pasted over",
		`guarded=${force5.blockers_guarded} refused=${force5.records_refused}`);
	check(clearTile.some(h => h.startsWith("wooden-chest:")),
		"ARM 5 SIBLING: the record whose target was CLEAR still lands — a guarded blocker refuses its "
		+ "own record, not the whole force",
		`tile=${clearTile.join(", ") || "(empty)"}`);

	// ---------------------------------------------------------------------------------------------
	// Arm 6 — the item-request-proxy plan exemption, exercised. The chest record is dropped from the
	// capture so the proxy travels alone onto a destination where its TARGET already stands: without
	// the exemption the proxy's own footprint scan finds that target and refuses.
	// ---------------------------------------------------------------------------------------------
	const copy6 = drive("copy", 6, 32, 8, 34);
	const dropped = lua(`
		local st = storage.selection_lab and storage.selection_lab[${LAB_PLAYER}]
		local cap = st and st.export
		if not (cap and cap.records) then return { found = false } end
		local kept, dropped_n = {}, 0
		for _, rec in ipairs(cap.records) do
			if rec.type == 'item-request-proxy' then kept[#kept + 1] = rec else dropped_n = dropped_n + 1 end
		end
		cap.records = kept
		return { found = true, kept = #kept, dropped = dropped_n,
			target_x = (kept[1] and kept[1].specific_data and kept[1].specific_data.target_position
				and kept[1].specific_data.target_position.x) or -1 }
	`);
	note(`arm 6 capture after dropping every non-proxy record: kept=${dropped.kept} dropped=${dropped.dropped} `
		+ `proxy target_position.x=${dropped.target_x}`);
	check(dropped.found === true && dropped.kept === 1,
		"arm 6 setup: the capture is now a single item-request-proxy record whose target_position "
		+ "translates onto the chest already standing at the destination",
		`kept=${dropped.kept} dropped=${dropped.dropped}`);
	const paste6 = drive("paste", 14, 32, 16, 34);
	const after6 = scanArea(13, 31, 16, 34);
	note(`arm 6 paste report: outcome=${paste6.outcome} conflicts=${paste6.conflicts} `
		+ `created=${paste6.created} ${paste6.error_detail}`);
	note(`arm 6 destination after paste: ${after6.join(", ") || "(empty)"}`);
	check(paste6.raised !== true && paste6.outcome === "pasted",
		"ARM 6 PROXY EXEMPTION: a proxy record pastes onto a target that ALREADY EXISTS at the "
		+ "destination — the UNBLOCKABLE_RECORD_TYPES exemption is what admits it, and this arm is the "
		+ "one that fires when the exemption is removed",
		`outcome=${paste6.outcome || "(none)"} conflicts=${paste6.conflicts}`);
	check(after6.some(h => h.startsWith("item-request-proxy:")),
		"ARM 6 physical arm: the proxy really landed on the pre-existing chest",
		after6.join(", ") || "(empty)");

	// ---------------------------------------------------------------------------------------------
	// Arm 7 — an entity-ghost standing at the destination. It carries a unit_number, so the footprint
	// scan counts it. Pinned so the reading is a decision and not an accident.
	// ---------------------------------------------------------------------------------------------
	const copy7 = drive("copy", 6, 38, 8, 40);
	const paste7 = drive("paste", 14, 38, 16, 40);
	const after7 = scanArea(13, 37, 16, 40);
	note(`arm 7 paste-over-ghost report: outcome=${paste7.outcome} conflicts=${paste7.conflicts} `
		+ `created=${paste7.created} ${paste7.error_detail}`);
	note(`arm 7 destination after paste: ${after7.join(", ") || "(empty)"}`);
	check(copy7.outcome === "copied" && paste7.raised !== true && paste7.outcome === "refused"
		&& paste7.conflicts === 1,
		"ARM 7 PIN: an entity-ghost already standing at the destination IS a blocker — a paste onto it "
		+ "is refused rather than stacking a real entity on the ghost. Pinned deliberately: the ghost "
		+ "carries a unit_number, which is the whole of the blocking_entities predicate",
		`outcome=${paste7.outcome || "(none)"} conflicts=${paste7.conflicts}`);
	check(!after7.some(h => h.startsWith("wooden-chest:container:")),
		"ARM 7 physical arm: no chest was placed on the ghost's tile",
		after7.join(", ") || "(empty)");

	// ---------------------------------------------------------------------------------------------
	// Arm 8 — a belt blocker cut out of a RUN that keeps carrying items on the pieces nobody
	// destroyed. One insert_at per RCON round trip seats one item per lane; the belts keep moving
	// between calls, so repeated top-ups back the run up instead of bouncing off an occupied slot.
	// ---------------------------------------------------------------------------------------------
	const topUp = () => lua(`
		local s = game.surfaces['${SURF}']
		local seated = 0
		for _, e in pairs(s.find_entities_filtered{ area = { { 13, 43 }, { 18, 47 } }, type = 'transport-belt' }) do
			for li = 1, e.get_max_transport_line_index() do
				if e.get_transport_line(li).insert_at_back({ name = 'iron-plate' }) then seated = seated + 1 end
			end
		end
		return { seated = seated }
	`).seated;
	let seated = 0;
	for (let i = 0; i < 10; i += 1) seated += topUp();
	const copy8 = drive("copy", 6, 44, 8, 46);
	const run8Before = beltRun(13, 43, 18, 47);
	const force8 = drive("force", 16, 44, 18, 46);
	const run8Mid = beltRun(13, 43, 18, 47);
	const undo8 = undo();
	const run8After = beltRun(13, 43, 18, 47);
	note(`arm 8 (belt run cut at its end piece): seated by top-up=${seated} copy=${copy8.outcome} `
		+ `force=${force8.outcome} replaced=${force8.blockers_replaced} undo_raised=${undo8.raised}`);
	note(`arm 8 items on the run: before=${run8Before.total} (${run8Before.pieces} pieces) `
		+ `after force=${run8Mid.total} (${run8Mid.pieces} pieces) `
		+ `after undo=${run8After.total} (${run8After.pieces} pieces) `
		+ `| destroyed with the piece=${run8Before.total - run8Mid.total} `
		+ `| re-placed by the resurrection=${run8After.total - run8Mid.total}`);
	check(force8.raised !== true && force8.outcome === "force_pasted" && run8Mid.pieces === 2,
		"arm 8 setup: the force really cut one piece out of a three-piece belt run",
		`outcome=${force8.outcome || "(none)"} pieces after force=${run8Mid.pieces}`);
	check(run8Mid.total > 0,
		"arm 8 premise: items really did SURVIVE on the two pieces nobody destroyed — without this the "
		+ "no-duplication arm below is vacuous, because there would be nothing left to duplicate",
		`items still on the run after the force=${run8Mid.total}`);
	check(run8After.total <= run8Before.total,
		"ARM 8 NO DUPLICATION: cutting one piece out of a loaded run and resurrecting it does not grow "
		+ "the run's item total — the items still sitting on the surviving pieces are not re-placed on "
		+ "top of themselves",
		`before=${run8Before.total} after force=${run8Mid.total} after undo=${run8After.total}`);

	// ---------------------------------------------------------------------------------------------
	// Arm 9 — ONE 3x3 blocker under TWO 1x1 targets. The blocker is destroyed once, so it must be
	// journaled once: a second journal entry resurrects a second copy on top of the first.
	// ---------------------------------------------------------------------------------------------
	const copy9 = drive("copy", 6, 50, 8, 52);
	check(copy9.raised !== true && copy9.outcome === "copied" && copy9.records === 2,
		"arm 9 setup: the lab copies two adjacent 1x1 records whose destination footprints both fall "
		+ "inside one 3x3 solar-panel",
		`outcome=${copy9.outcome} records=${copy9.records} ${copy9.err}`);
	const force9 = drive("force", 14, 50, 16, 52);
	note(`arm 9 force report: outcome=${force9.outcome} replaced=${force9.blockers_replaced} `
		+ `created=${force9.created} ${force9.error_detail}`);
	check(force9.raised !== true && force9.outcome === "force_pasted" && force9.blockers_replaced === 1,
		"ARM 9 DEDUPE: two records sharing one physical blocker replace it ONCE — the blocker is "
		+ "journaled once, not once per record it blocked",
		`outcome=${force9.outcome || "(none)"} replaced=${force9.blockers_replaced}`);
	const undo9 = undo();
	const after9 = scanArea(13, 49, 18, 53);
	note(`arm 9 after undo (raised=${undo9.raised}): ${after9.join(", ") || "(empty)"}`);
	check(after9.filter(h => h.startsWith("solar-panel:")).length === 1,
		"ARM 9 physical arm: exactly ONE solar-panel stands after undo — a duplicated journal entry "
		+ "would stack a second panel on the first",
		after9.filter(h => h.startsWith("solar-panel:")).join(", ") || "(none)");
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
			if storage.__labforce_saved ~= nil then
				storage.selection_lab = storage.selection_lab or {}
				storage.selection_lab[${LAB_PLAYER}] = storage.__labforce_saved
			elseif storage.selection_lab then
				storage.selection_lab[${LAB_PLAYER}] = nil
				local n = 0
				for _ in pairs(storage.selection_lab) do n = n + 1 end
				if n == 0 then storage.selection_lab = nil end
			end
			storage.__labforce_saved = nil
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
				scratch = storage.__labforce_saved ~= nil,
				lab = (storage.selection_lab ~= nil and storage.selection_lab[${LAB_PLAYER}] ~= nil) }
		`);
		const leftoverSurfaces = asArray(residue.surfaces);
		check(leftoverSurfaces.length === 0 && residue.platforms === 0,
			"zero leftovers: no probe surface or platform survives",
			`surfaces=${leftoverSurfaces.join(",") || "(none)"} platforms=${residue.platforms}`);
		check(residue.scratch === false, "zero leftovers: the storage.__labforce_saved scratch key is cleared");
		check(residue.lab === (setup?.lab_state_was_live === true),
			"zero leftovers: storage.selection_lab is back to the state the probe found",
			`live_before=${setup?.lab_state_was_live === true} live_after=${residue.lab}`);
	} catch (sweepError) {
		failures += 1;
		process.exitCode = 1;
		console.error(`  FAIL  cleanup threw: ${sweepError && sweepError.message ? sweepError.message : sweepError}`);
		console.error("  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix labforce- is in its sweep list)");
	}
}

if (failures) {
	console.log(`=== lab-force-resurrection: ${failures} FAILURE(S) ===`);
	process.exit(1);
}
console.log("=== lab-force-resurrection: ALL PASS ===");
