local Deserializer = require("modules/surface_export/core/deserializer")
local ConnectionScanner = require("modules/surface_export/export_scanners/connection-scanner")

local SCRATCH_NAME = "pole-copper-prune-selftest-scratch"
local POLE = "small-electric-pole"
local PAIR_FAR = 10
local PAIR_NEAR = 4
local BAND_STEP = 10
local COLUMN_X = -20
local TILE_MARGIN = 6

local function copper_id()
	return defines.wire_connector_id.pole_copper
end

local function find_scratch_platforms()
	local out = {}
	for _, platform in pairs(game.forces.player.platforms) do
		if platform.valid and platform.name == SCRATCH_NAME then
			out[#out + 1] = platform
		end
	end
	return out
end

local function sweep_prior_leftovers()
	local swept = 0
	for _, platform in ipairs(find_scratch_platforms()) do
		if platform.surface and platform.surface.valid then
			game.delete_surface(platform.surface)
			swept = swept + 1
		end
	end
	return swept
end

local function connector(entity, create)
	if not (entity and entity.valid) then return nil end
	return entity.get_wire_connector(copper_id(), create)
end

local function links_to(list, peer)
	for _, conn in ipairs(list) do
		local owner = conn.target and conn.target.owner
		if owner and owner.valid and owner.unit_number == peer.unit_number then return true end
	end
	return false
end

local function linked(a, b, real_only)
	local c = connector(a, false)
	if c == nil then return false end
	if real_only then return links_to(c.real_connections, b) end
	return links_to(c.connections, b)
end

local function origins_holding(a, b)
	local ca = connector(a, false)
	local cb = connector(b, false)
	local held = {}
	if ca == nil or cb == nil then return held end
	for name, value in pairs(defines.wire_origin) do
		-- intentional probe; an origin the engine declines to answer for must not stop the sweep
		local ok, connected = pcall(function() return ca.is_connected_to(cb, value) end)
		if ok and connected then held[#held + 1] = name end
	end
	table.sort(held)
	return held
end

local function holds(held, name)
	for _, entry in ipairs(held) do
		if entry == name then return true end
	end
	return false
end

local function origins_text(a, b)
	local held = origins_holding(a, b)
	if #held == 0 then return "none" end
	return table.concat(held, "+")
end

local function place_pair(surface, force, band, gap, ghost)
	local y = band * BAND_STEP
	local function one(x)
		local params = { name = ghost and "entity-ghost" or POLE, position = { x, y }, force = force }
		if ghost then params.inner_name = POLE end
		return surface.create_entity(params)
	end
	return one(COLUMN_X), one(COLUMN_X + gap)
end

local function armed_pair(surface, force, band, gap, ghost)
	local a, b = place_pair(surface, force, band, gap, ghost)
	if not (a and a.valid and b and b.valid) then
		return nil, nil, "pole pair create failed at band " .. band
	end
	if not (a.unit_number and b.unit_number) then
		return nil, nil, string.format("pole pair at band %d carries no unit_number (a=%s b=%s)",
			band, tostring(a.unit_number), tostring(b.unit_number))
	end
	local ca = connector(a, true)
	local cb = connector(b, true)
	if not (ca and cb) then
		return nil, nil, "pole pair at band " .. band .. " has no copper connector"
	end
	ca.disconnect_all()
	cb.disconnect_all()
	return a, b, nil
end

local function payload_for(a, b, carried)
	local copper = copper_id()
	local function row(entity, peer)
		local conns = {}
		if carried then
			conns[#conns + 1] = { source_circuit_id = copper, target_circuit_id = copper,
				target_entity_id = peer.unit_number }
		end
		return { entity_id = entity.unit_number, circuit_connections = conns }
	end
	return { row(a, b), row(b, a) }, { [a.unit_number] = a, [b.unit_number] = b }
end

local function exp_origin_enum()
	local origins = defines.wire_origin
	if type(origins) ~= "table" then
		return { ok = false, detail = "defines.wire_origin is " .. type(origins) .. ", not a table — the prune "
			.. "would pass nil, which the engine reads as the player origin" }
	end
	local members = {}
	for name, value in pairs(origins) do members[#members + 1] = string.format("%s=%s", name, tostring(value)) end
	table.sort(members)
	return {
		ok = origins.player ~= nil and origins.script ~= nil,
		detail = string.format("members {%s} (want player and script present)", table.concat(members, ",")),
	}
end

local function exp_autoconnect_origin(surface, force, band)
	local a, b = place_pair(surface, force, band, PAIR_NEAR, false)
	if not (a and a.valid and b and b.valid) then
		return { ok = false, detail = "in-reach pole pair create failed at band " .. band }
	end
	local auto_wired = linked(a, b, true)
	local auto_origins = origins_holding(a, b)
	local auto_text = origins_text(a, b)

	local ca = connector(a, true)
	local cb = connector(b, true)
	ca.disconnect_all()
	cb.disconnect_all()
	local cleared = linked(a, b, false)
	local reconnected = ca.connect_to(cb, true)
	local default_origins = origins_text(a, b)

	return {
		ok = auto_wired and holds(auto_origins, "player") and cleared == false and reconnected == true
			and default_origins == auto_text,
		detail = string.format("in-reach pair %.1f apart: create_entity alone left real_wire=%s at "
			.. "origins=[%s]; disconnect_all with no origin cleared it (%s); connect_to with no origin "
			.. "argument re-made it at origins=[%s] (want player, cleared, and the same origin — this is "
			.. "the wire the destination prune actually removes, and the origin the restore replays)",
			PAIR_NEAR, tostring(auto_wired), auto_text, tostring(cleared == false), default_origins),
	}
end

local function exp_origin_less_disconnect(surface, force, band)
	local a, b, err = armed_pair(surface, force, band, PAIR_FAR, false)
	if err then return { ok = false, detail = err } end
	local ca = connector(a, true)
	local cb = connector(b, true)
	local armed = ca.connect_to(cb, false, defines.wire_origin.script)
	local before = linked(a, b, false)
	local returned = ca.disconnect_from(cb)
	local after = linked(a, b, false)
	return {
		ok = armed == true and before == true and returned == false and after == true,
		detail = string.format("script-origin wire armed=%s present=%s; disconnect_from with NO origin "
			.. "returned=%s and the wire is %s afterwards (want false / still present) origins=[%s]",
			tostring(armed), tostring(before), tostring(returned),
			after and "STILL THERE" or "gone", origins_text(a, b)),
	}
end

local function exp_origin_targeted_disconnect(surface, force, band)
	local a, b, err = armed_pair(surface, force, band, PAIR_FAR, false)
	if err then return { ok = false, detail = err } end
	local ca = connector(a, true)
	local cb = connector(b, true)
	local armed = ca.connect_to(cb, false, defines.wire_origin.script)
	local before = linked(a, b, false)
	local returned = ca.disconnect_from(cb, defines.wire_origin.script)
	local after = linked(a, b, false)
	return {
		ok = armed == true and before == true and returned == true and after == false,
		detail = string.format("script-origin wire armed=%s present=%s; disconnect_from with origin=script "
			.. "returned=%s and the wire is %s afterwards (want true / gone)",
			tostring(armed), tostring(before), tostring(returned), after and "STILL THERE" or "gone"),
	}
end

local function exp_wrong_origin_disconnect(surface, force, band)
	local a, b, err = armed_pair(surface, force, band, PAIR_FAR, false)
	if err then return { ok = false, detail = err } end
	local ca = connector(a, true)
	local cb = connector(b, true)
	local armed = ca.connect_to(cb, false)
	-- intentional probe; whether an origin holding no wire throws is the law under test
	local call_ok, returned = pcall(function() return ca.disconnect_from(cb, defines.wire_origin.script) end)
	local survived = linked(a, b, false)
	local removed = ca.disconnect_from(cb, defines.wire_origin.player)
	return {
		ok = armed == true and call_ok == true and returned == false and survived == true and removed == true
			and linked(a, b, false) == false,
		detail = string.format("player-origin wire armed=%s; disconnect_from(origin=script) threw=%s "
			.. "returned=%s wire_survived=%s; disconnect_from(origin=player) returned=%s left=%s "
			.. "(want no throw / false / survived / true / gone — the prune attempts every origin "
			.. "unconditionally)",
			tostring(armed), tostring(not call_ok), tostring(returned), tostring(survived),
			tostring(removed), tostring(linked(a, b, false))),
	}
end

local function exp_radars_origin(surface, force, band)
	local a, b, err = armed_pair(surface, force, band, PAIR_FAR, false)
	if err then return { ok = false, detail = err } end
	local ca = connector(a, true)
	local cb = connector(b, true)
	-- intentional probe; a refusal here is the finding, not an error
	local call_ok, returned = pcall(function()
		return ca.connect_to(cb, false, defines.wire_origin.radars)
	end)
	local created = linked(a, b, false)
	local removable = false
	local remove_returned = "not attempted"
	if created then
		-- intentional probe; a script-unremovable wire is the finding, not an error
		local rm_ok, rm = pcall(function() return ca.disconnect_from(cb, defines.wire_origin.radars) end)
		remove_returned = tostring(rm_ok and rm)
		removable = rm_ok and rm == true and linked(a, b, false) == false
	end
	return {
		ok = (not created) or removable,
		detail = string.format("connect_to(origin=radars) threw=%s returned=%s created=%s origins=[%s] "
			.. "removable_by_script=%s (disconnect returned %s) — a radars wire a script can create but "
			.. "not remove is a class the prune cannot reach",
			tostring(not call_ok), tostring(returned), tostring(created), origins_text(a, b),
			tostring(removable), remove_returned),
	}
end

local function exp_capture_sees_script_wire(surface, force, band)
	local a, b, err = armed_pair(surface, force, band, PAIR_FAR, false)
	if err then return { ok = false, detail = err } end
	local ca = connector(a, true)
	local cb = connector(b, true)
	local armed = ca.connect_to(cb, false, defines.wire_origin.script)
	local captured = ConnectionScanner.extract_circuit_connections(a)
	local copper = copper_id()
	local matching = 0
	local carries_origin = false
	for _, conn in ipairs(captured) do
		if conn.source_circuit_id == copper and conn.target_circuit_id == copper
			and conn.target_entity_id == b.unit_number then
			matching = matching + 1
			for key in pairs(conn) do
				if key == "origin" or key == "wire_origin" then carries_origin = true end
			end
		end
	end
	return {
		ok = armed == true and matching == 1 and carries_origin == false,
		detail = string.format("extract_circuit_connections on the script-wired pole returned %d row(s), "
			.. "%d of them naming the peer at the copper connector; the row carries an origin field: %s "
			.. "(want 1 / no origin field — the capture records the wire but not which origin held it, so "
			.. "the restore replays it at the connect_to default)",
			#captured, matching, tostring(carries_origin)),
	}
end

local function exp_prune(surface, force, band, origin_name, carried, ghost)
	local a, b, err = armed_pair(surface, force, band, PAIR_FAR, ghost)
	if err then return { ok = false, detail = err } end
	local ca = connector(a, true)
	local cb = connector(b, true)
	local armed = ca.connect_to(cb, false, defines.wire_origin[origin_name])
	local before = linked(a, b, false)
	local real_before = linked(a, b, true)
	local origins_before = origins_text(a, b)
	local entities_to_create, entity_map = payload_for(a, b, carried)
	local pruned = Deserializer.prune_pole_copper(entities_to_create, entity_map)
	local after = linked(a, b, false)
	local want_pruned = carried and 0 or 1
	return {
		ok = armed == true and before == true and after == carried and pruned == want_pruned,
		detail = string.format("%s %s-origin wire the payload %s: armed=%s present=%s in_real_connections=%s "
			.. "origins=[%s]; prune_pole_copper returned %d (want %d) and the wire is %s afterwards (want %s)",
			ghost and "ghost-pair" or "real-pair", origin_name,
			carried and "DOES carry" or "does NOT carry",
			tostring(armed), tostring(before), tostring(real_before), origins_before, pruned, want_pruned,
			after and "still there" or "gone", carried and "still there" or "gone"),
	}
end

local function run_row(name, fn)
	local ok, result = pcall(fn)
	if not ok then
		log("[pole-copper-prune-selftest] " .. name .. " threw: " .. tostring(result))
		return { name = name, ok = false, detail = "threw: " .. tostring(result) }
	end
	result.name = name
	if result.ok == nil then result.ok = false end
	return result
end

local BANDS = 13

local function pole_copper_prune_selftest()
	if not (storage.surface_export_config and storage.surface_export_config.debug_mode) then
		return { ok = false, err = "debug_mode off" }
	end

	sweep_prior_leftovers()

	local force = game.forces.player
	local platform = force.create_space_platform({
		name = SCRATCH_NAME,
		planet = "nauvis",
		starter_pack = "space-platform-starter-pack",
	})
	if not platform then
		return { ok = false, err = "create_space_platform failed", rows = {}, teardown_clean = true }
	end
	platform.apply_starter_pack()
	platform.paused = true
	local surface = platform.surface
	if not surface then
		return { ok = false, err = "no surface after apply_starter_pack", rows = {}, teardown_clean = false }
	end

	local tiles = {}
	for x = COLUMN_X - TILE_MARGIN, 0 do
		for y = -TILE_MARGIN, BANDS * BAND_STEP + TILE_MARGIN do
			tiles[#tiles + 1] = { name = "space-platform-foundation", position = { x, y } }
		end
	end
	surface.set_tiles(tiles, true, false, true, false)

	local reach = prototypes.entity[POLE].get_max_wire_distance()
	local rows = {}
	rows[#rows + 1] = run_row("wire reach separates the pair spacings", function()
		return {
			ok = reach >= PAIR_NEAR and reach < PAIR_FAR,
			detail = string.format("%s reach=%s — the near pair (%.1f) must be inside it and every other "
				.. "pair (%.1f, bands %d apart) outside, or an engine auto-connect feeds the wire sets below",
				POLE, tostring(reach), PAIR_NEAR, PAIR_FAR, BAND_STEP),
		}
	end)
	rows[#rows + 1] = run_row("defines.wire_origin members", exp_origin_enum)
	rows[#rows + 1] = run_row("the origin the engine's own connect_to default writes", function()
		return exp_autoconnect_origin(surface, force, 0)
	end)
	rows[#rows + 1] = run_row("disconnect_from with no origin cannot remove a script wire", function()
		return exp_origin_less_disconnect(surface, force, 1)
	end)
	rows[#rows + 1] = run_row("disconnect_from with origin=script removes it", function()
		return exp_origin_targeted_disconnect(surface, force, 2)
	end)
	rows[#rows + 1] = run_row("disconnect_from at an origin holding no wire is false, not a throw", function()
		return exp_wrong_origin_disconnect(surface, force, 3)
	end)
	rows[#rows + 1] = run_row("a script cannot leave an unremovable radars-origin copper wire", function()
		return exp_radars_origin(surface, force, 4)
	end)
	rows[#rows + 1] = run_row("the export capture sees a script wire but records no origin", function()
		return exp_capture_sees_script_wire(surface, force, 5)
	end)
	rows[#rows + 1] = run_row("prune removes a foreign player-origin wire", function()
		return exp_prune(surface, force, 6, "player", false, false)
	end)
	rows[#rows + 1] = run_row("prune keeps a payload-carried player-origin wire", function()
		return exp_prune(surface, force, 7, "player", true, false)
	end)
	rows[#rows + 1] = run_row("prune removes a foreign script-origin wire", function()
		return exp_prune(surface, force, 8, "script", false, false)
	end)
	rows[#rows + 1] = run_row("prune keeps a payload-carried script-origin wire", function()
		return exp_prune(surface, force, 9, "script", true, false)
	end)
	rows[#rows + 1] = run_row("ghost prune removes a foreign player-origin wire", function()
		return exp_prune(surface, force, 10, "player", false, true)
	end)
	rows[#rows + 1] = run_row("ghost prune removes a foreign script-origin wire", function()
		return exp_prune(surface, force, 11, "script", false, true)
	end)
	rows[#rows + 1] = run_row("ghost prune keeps a payload-carried script-origin wire", function()
		return exp_prune(surface, force, 12, "script", true, true)
	end)

	local teardown_ok, teardown_err = pcall(function()
		if platform.valid and platform.surface and platform.surface.valid then
			game.delete_surface(platform.surface)
		end
	end)
	if not teardown_ok then
		log("[pole-copper-prune-selftest] teardown error: " .. tostring(teardown_err))
	end

	local all_ok = true
	local pass_n, fail_n = 0, 0
	for _, row in ipairs(rows) do
		if row.ok then pass_n = pass_n + 1 else all_ok = false; fail_n = fail_n + 1 end
	end

	local summary = string.format(
		"[pole-copper-prune-selftest] ok=%s pass=%d fail=%d teardown_clean=%s",
		tostring(all_ok), pass_n, fail_n, tostring(teardown_ok == true))
	game.print(summary)
	if rcon then rcon.print(summary) end

	return { ok = all_ok, rows = rows, teardown_clean = teardown_ok == true }
end

return pole_copper_prune_selftest
