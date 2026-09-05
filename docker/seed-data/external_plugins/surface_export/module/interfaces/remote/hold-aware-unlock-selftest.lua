local SurfaceLock = require("modules/surface_export/utils/surface-lock")
local DestinationHold = require("modules/surface_export/core/destination-hold")

local PREFIX = "hold-aware-unlock-selftest-"

local function key(entity)
	return entity.unit_number or tostring(entity.position.x) .. ":" .. tostring(entity.position.y)
end

local function reset_lab()
	if storage.destination_holds then
		for transfer_id, _ in pairs(storage.destination_holds) do
			if type(transfer_id) == "string" and string.find(transfer_id, PREFIX, 1, true) then
				storage.destination_holds[transfer_id] = nil
			end
		end
	end
	if storage.locked_platforms then
		for platform_index, lock in pairs(storage.locked_platforms) do
			if type(lock) == "table" and type(lock.platform_name) == "string" and string.find(lock.platform_name, PREFIX, 1, true) then
				storage.locked_platforms[platform_index] = nil
			end
		end
	end
	for _, surface in pairs(game.surfaces) do
		local p = surface.platform
		if p and p.valid and string.find(p.name, PREFIX, 1, true) then
			local ok, err = pcall(function() game.delete_surface(surface) end)
			if not ok then
				log("[hold-aware-unlock-selftest] cleanup failed for " .. tostring(p.name) .. ": " .. tostring(err))
			end
		end
	end
end

local function make_platform(label)
	local force = game.forces.player
	local platform = force.create_space_platform({
		name = PREFIX .. label .. "-" .. tostring(game.tick),
		planet = "nauvis",
		starter_pack = "space-platform-starter-pack",
	})
	platform.apply_starter_pack()
	platform.paused = false
	platform.hidden = false
	force.set_surface_hidden(platform.surface, false)
	local surface = platform.surface
	local anchor = platform.hub and platform.hub.valid and platform.hub.position or { x = 0, y = 0 }
	local tiles = {}
	for x = -4, 4 do
		for y = -4, 4 do
			tiles[#tiles + 1] = { name = "space-platform-foundation", position = { anchor.x + x, anchor.y + y } }
		end
	end
	surface.set_tiles(tiles, true, false, true, false)
	local entity = surface.create_entity({ name = "assembling-machine-1", position = { anchor.x + 2, anchor.y }, force = force })
	if not (entity and entity.valid) then error("failed to create activatable selftest entity") end
	entity.disabled_by_script = false
	return force, platform, entity
end

local function install_lock(force, platform, entity, opts)
	storage.locked_platforms = storage.locked_platforms or {}
	storage.locked_platforms[platform.index] = {
		platform_name = platform.name,
		platform_index = platform.index,
		surface_index = platform.surface.index,
		force_name = force.name,
		original_hidden = false,
		original_platform_hidden = false,
		locked_tick = opts and opts.locked_tick or game.tick,
		kind = opts and opts.kind or "transfer",
		expires_tick = opts and opts.expires_tick or nil,
		frozen_states = { [key(entity)] = true },
		frozen_count = 1,
	}
end

local function read_state(force, platform, entity)
	return {
		hidden = force.get_surface_hidden(platform.surface),
		platform_hidden = platform.hidden,
		active = entity.active,
		paused = platform.paused,
		locked = storage.locked_platforms and storage.locked_platforms[platform.index] ~= nil or false,
	}
end

local function check(details, name, ok, msg)
	local row = { name = name, ok = ok == true }
	if not row.ok then row.msg = msg end
	details[#details + 1] = row
	return row.ok
end

local function check_state(details, prefix, state, expected)
	local ok = true
	ok = check(details, prefix .. "_hidden", state.hidden == expected.hidden,
		"hidden=" .. tostring(state.hidden) .. " expected=" .. tostring(expected.hidden)) and ok
	ok = check(details, prefix .. "_platform_hidden", state.platform_hidden == expected.hidden,
		"platform_hidden=" .. tostring(state.platform_hidden) .. " expected=" .. tostring(expected.hidden)) and ok
	ok = check(details, prefix .. "_active", state.active == expected.active,
		"active=" .. tostring(state.active) .. " expected=" .. tostring(expected.active)) and ok
	ok = check(details, prefix .. "_paused", state.paused == expected.paused,
		"paused=" .. tostring(state.paused) .. " expected=" .. tostring(expected.paused)) and ok
	return ok
end

local function stage_hold(label, force, platform)
	local transfer_id = PREFIX .. label .. "-" .. tostring(game.tick)
	local ok, result = DestinationHold.stage(transfer_id, platform, force)
	if not ok then error("stage failed: " .. tostring(result)) end
	return transfer_id
end

local function ttl_expiry_unlock_over_hold(details)
	local force, platform, entity = make_platform("ttl")
	local transfer_id = stage_hold("ttl", force, platform)
	install_lock(force, platform, entity, { kind = "transfer", locked_tick = game.tick - 120, expires_tick = game.tick - 1 })
	local summary = SurfaceLock.scan_transfer_expiries()
	check(details, "ttl_expiry_unlock_over_hold", summary.expired == 1 and summary.failed == 0, "summary mismatch")
	local state = read_state(force, platform, entity)
	check_state(details, "ttl_expiry_unlock_over_hold", state, { hidden = true, active = false, paused = true })
	check(details, "ttl_expiry_lock_cleared", state.locked == false, "lock should be cleared")
	check(details, "ttl_expiry_hold_retained", DestinationHold.get(transfer_id) ~= nil, "hold should remain")
end

local function manual_unlock_over_hold(details)
	local force, platform, entity = make_platform("manual")
	local transfer_id = stage_hold("manual", force, platform)
	install_lock(force, platform, entity, { kind = "transfer" })
	local ok, err = SurfaceLock.unlock_platform(platform.index, platform.name)
	check(details, "manual_unlock_over_hold", ok == true, tostring(err))
	local state = read_state(force, platform, entity)
	check_state(details, "manual_unlock_over_hold", state, { hidden = true, active = false, paused = true })
	check(details, "manual_unlock_hold_retained", DestinationHold.get(transfer_id) ~= nil, "hold should remain")
end

local function unlock_after_hold_removed(details)
	local force, platform, entity = make_platform("removed")
	local transfer_id = stage_hold("removed", force, platform)
	storage.destination_holds[transfer_id] = nil
	force.set_surface_hidden(platform.surface, true)
	entity.disabled_by_script = true
	platform.paused = true
	install_lock(force, platform, entity, { kind = "transfer" })
	local ok, err = SurfaceLock.unlock_platform(platform.index, platform.name)
	check(details, "unlock_after_hold_removed", ok == true, tostring(err))
	local state = read_state(force, platform, entity)
	check_state(details, "unlock_after_hold_removed", state, { hidden = false, active = true, paused = true })
end

local function unlock_after_go_live(details)
	local force, platform, entity = make_platform("golive")
	local transfer_id = stage_hold("golive", force, platform)
	local live_ok, live_err = DestinationHold.go_live(transfer_id)
	check(details, "unlock_after_go_live_release", live_ok == true, tostring(live_err))
	force.set_surface_hidden(platform.surface, true)
	entity.disabled_by_script = true
	platform.paused = true
	install_lock(force, platform, entity, { kind = "transfer" })
	local ok, err = SurfaceLock.unlock_platform(platform.index, platform.name)
	check(details, "unlock_after_go_live", ok == true, tostring(err))
	local state = read_state(force, platform, entity)
	check_state(details, "unlock_after_go_live", state, { hidden = false, active = true, paused = true })
end

local function double_unlock(details)
	local force, platform, entity = make_platform("double")
	force.set_surface_hidden(platform.surface, true)
	entity.disabled_by_script = true
	install_lock(force, platform, entity, { kind = "transfer" })
	local first_ok, first_err = SurfaceLock.unlock_platform(platform.index, platform.name)
	local second_ok, second_err = SurfaceLock.unlock_platform(platform.index, platform.name)
	check(details, "double_unlock_first", first_ok == true, tostring(first_err))
	check(details, "double_unlock_second", second_ok == false and string.find(tostring(second_err), "not locked", 1, true) ~= nil, tostring(second_err))
end

local function non_held_unlock_restores(details)
	local force, platform, entity = make_platform("normal")
	force.set_surface_hidden(platform.surface, true)
	entity.disabled_by_script = true
	install_lock(force, platform, entity, { kind = "transfer" })
	local ok, err = SurfaceLock.unlock_platform(platform.index, platform.name)
	check(details, "non_held_unlock_restores", ok == true, tostring(err))
	local state = read_state(force, platform, entity)
	check_state(details, "non_held_unlock_restores", state, { hidden = false, active = true, paused = false })
end

local function hold_aware_unlock_selftest()
	reset_lab()
	local details = {}
	local ok, err = pcall(function()
		ttl_expiry_unlock_over_hold(details)
		manual_unlock_over_hold(details)
		unlock_after_hold_removed(details)
		unlock_after_go_live(details)
		double_unlock(details)
		non_held_unlock_restores(details)
		for _, platform_hidden in ipairs({ false, true }) do
			for _, force_hidden in ipairs({ false, true }) do
				local force, platform = make_platform("visibility")
				platform.hidden = platform_hidden
				force.set_surface_hidden(platform.surface, force_hidden)
				local label = "visibility_" .. tostring(platform_hidden) .. "_" .. tostring(force_hidden)
				local locked, lock_err = SurfaceLock.lock_platform(platform, force)
				check(details, label .. "_lock", locked == true, tostring(lock_err))
				check(details, label .. "_locked_hidden", platform.hidden and force.get_surface_hidden(platform.surface), "both flags must be hidden")
				local unlocked, unlock_err = SurfaceLock.unlock_platform(platform.index)
				check(details, label .. "_unlock", unlocked == true, tostring(unlock_err))
				check(details, label .. "_lock_restored", platform.hidden == platform_hidden and force.get_surface_hidden(platform.surface) == force_hidden, "original flags not restored")
				local id = stage_hold(label, force, platform)
				check(details, label .. "_held_hidden", platform.hidden and force.get_surface_hidden(platform.surface), "both flags must be hidden")
				local released, release_err = DestinationHold.go_live(id)
				check(details, label .. "_go_live", released == true, tostring(release_err))
				check(details, label .. "_hold_restored", platform.hidden == platform_hidden and force.get_surface_hidden(platform.surface) == force_hidden, "original flags not restored")
				local paused = platform.paused
				local complete = SurfaceLock.complete_cargo_pods
				SurfaceLock.complete_cargo_pods = function() error("injected pod completion failure") end
				local call_ok, staged = pcall(DestinationHold.stage, id, platform, force)
				SurfaceLock.complete_cargo_pods = complete
				check(details, label .. "_stage_failed", call_ok and staged == false, "failure was not returned")
				check(details, label .. "_stage_rollback", platform.hidden == platform_hidden and force.get_surface_hidden(platform.surface) == force_hidden and platform.paused == paused and DestinationHold.get(id) == nil, "failed stage changed visibility or pause state")
			end
		end
		local force, platform, entity = make_platform("legacy-visibility")
		platform.hidden = true
		install_lock(force, platform, entity)
		storage.locked_platforms[platform.index].original_platform_hidden = nil
		local unlocked = SurfaceLock.unlock_platform(platform.index)
		check(details, "legacy_lock_preserves_platform_flag", unlocked and platform.hidden, "legacy lock changed unowned flag")
		local id = stage_hold("legacy-visibility", force, platform)
		storage.destination_holds[id].original_platform_hidden = nil
		local released = DestinationHold.go_live(id)
		check(details, "legacy_hold_preserves_platform_flag", released and platform.hidden, "legacy hold changed unowned flag")
	end)
	if not ok then
		log("[hold-aware-unlock-selftest] exception: " .. tostring(err))
		details[#details + 1] = { name = "selftest_exception", ok = false, msg = tostring(err) }
	end
	local passed, failed = 0, 0
	for _, detail in ipairs(details) do
		if detail.ok then passed = passed + 1 else failed = failed + 1 end
	end
	reset_lab()
	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return hold_aware_unlock_selftest
