local Gateway = {}

Gateway.PREFIX = "surfexp_gateway_"

function Gateway.is_gateway(name)
	if type(name) ~= "string" then
		return false
	end
	if name:sub(1, #Gateway.PREFIX) ~= Gateway.PREFIX then
		return false
	end
	return prototypes.space_location[name] ~= nil
end

function Gateway.get_gateway_config(gateway_name)
	local cfg = storage.surface_export_config
	return (cfg and cfg.gateways and cfg.gateways[gateway_name]) or nil
end

function Gateway.is_active_gateway(name)
	local active = storage.surface_export_config and storage.surface_export_config.active_gateways
	if type(active) ~= "table" then
		return true
	end
	for _, active_name in ipairs(active) do
		if active_name == name then
			return true
		end
	end
	return false
end

function Gateway.discover_and_unlock()
	local unlocked = 0
	local locked = 0
	for name, _ in pairs(prototypes.space_location) do
		if Gateway.is_gateway(name) then
			local should_unlock = Gateway.is_active_gateway(name)
			for _, force in pairs(game.forces) do
				local ok, err = pcall(function()
					if should_unlock then
						force.unlock_space_location(name)
					else
						force.lock_space_location(name)
					end
				end)
				if ok then
					if should_unlock then
						unlocked = unlocked + 1
					else
						locked = locked + 1
					end
				else
					log(string.format("[Gateway] %s '%s' for force '%s' failed: %s",
						should_unlock and "unlock" or "lock", name, tostring(force.name), tostring(err)))
				end
			end
		end
	end
	log(string.format("[Gateway] discover_and_unlock: %d gateway/force unlocks, %d locks", unlocked, locked))
	return unlocked
end

function Gateway.parked_at_gateway(platform)
	if not (platform and platform.valid) then
		return nil
	end
	if platform.state ~= defines.space_platform_state.waiting_at_station then
		return nil
	end
	local loc = platform.space_location
	if loc and Gateway.is_gateway(loc.name) then
		return loc.name
	end
	return nil
end

function Gateway.collect_passengers(platform)
	local players = {}
	if not (platform and platform.valid and platform.surface and platform.surface.valid) then
		return players, 0
	end
	local surf_idx = platform.surface.index
	for _, player in pairs(game.players) do
		-- intentional probe; reading physical_surface_index can fail for an odd/transient player state,
		local ok, psi = pcall(function() return player.physical_surface_index end)
		if ok and psi == surf_idx then
			players[#players + 1] = player
		end
	end
	local ok_c, char_count = pcall(function()
		return platform.surface.count_entities_filtered{type = "character"}
	end)
	if not ok_c then
		log(string.format("[Gateway] collect_passengers: count_entities_filtered{character} failed for platform '%s': %s",
			tostring(platform.name), tostring(char_count)))
	end
	return players, (ok_c and char_count) or 0
end

function Gateway.passenger_count(aboard_players, aboard_characters)
	return math.max(#(aboard_players or {}), aboard_characters or 0)
end

function Gateway.evacuate_passengers(platform)
	local result = { players = 0, characters = 0, failures = 0 }
	if not (platform and platform.valid and platform.surface and platform.surface.valid) then
		return result
	end
	local surface = platform.surface

	local dest = game.surfaces["nauvis"]
	if not (dest and dest.valid) then
		for _, s in pairs(game.surfaces) do
			if s.valid and not s.platform then dest = s; break end
		end
	end
	if not (dest and dest.valid) then
		log(string.format("[Gateway] evacuate_passengers: no planetary surface to evacuate to for '%s' — deleting anyway (orphan risk)",
			tostring(platform.name)))
		return result
	end

	local force = platform.force
	local function safe_pos(ref)
		local anchor = (force and force.valid and force.get_spawn_position(dest)) or { x = 0, y = 0 }
		local pos
		-- intentional probe; find_non_colliding_position may return nil (no room) — fall back to the anchor.
		pcall(function() pos = dest.find_non_colliding_position(ref or "character", anchor, 64, 0.5) end)
		return pos or anchor
	end

	local aboard_players = Gateway.collect_passengers(platform)
	for _, player in ipairs(aboard_players) do
		local ref = (player.character and player.character.valid and player.character.name) or "character"
		local ok, moved = pcall(function() return player.teleport(safe_pos(ref), dest) end)
		if ok and moved then
			result.players = result.players + 1
			-- intentional probe; best-effort notify, a print failure must NOT abort evacuation.
			pcall(function()
				player.print({"", "🛟 '", platform.name, "' was transferred — you were returned to ", dest.name, "."})
			end)
		else
			result.failures = result.failures + 1
			log(string.format("[Gateway] evacuate: teleport player '%s' off '%s' failed (ok=%s): %s",
				tostring(player.name), tostring(platform.name), tostring(ok), tostring(moved)))
		end
	end

	local chars = {}
	-- intentional probe; surface is validated above, the find should succeed — empty list on failure is fine.
	pcall(function() chars = surface.find_entities_filtered{ type = "character" } end)
	for _, char in ipairs(chars) do
		if char and char.valid then
			local ok, moved = pcall(function() return char.teleport(safe_pos(char.name), dest) end)
			if ok and moved then
				result.characters = result.characters + 1
			else
				result.failures = result.failures + 1
				log(string.format("[Gateway] evacuate: teleport abandoned character off '%s' failed (ok=%s): %s",
					tostring(platform.name), tostring(ok), tostring(moved)))
			end
		end
	end

	if result.players + result.characters + result.failures > 0 then
		log(string.format("[Gateway] evacuated %d player(s) + %d character(s) from '%s' to '%s' (%d failure(s))",
			result.players, result.characters, tostring(platform.name), dest.name, result.failures))
	end
	return result
end

function Gateway.strip_gateway_records(schedule_payload)
	local records = schedule_payload.records or {}
	local orig_current = schedule_payload.current
	if type(orig_current) ~= "number" or orig_current < 1 then
		orig_current = 1
	elseif orig_current > #records then
		orig_current = #records
	end
	local kept = {}
	local new_current = nil
	for i, r in ipairs(records) do
		if not (type(r) == "table" and Gateway.is_gateway(r.station)) then
			kept[#kept + 1] = r
			if new_current == nil and i >= orig_current then
				new_current = #kept
			end
		end
	end
	if #kept == 0 then
		return nil
	end
	if new_current == nil then
		new_current = 1
	end
	return {
		current = new_current,
		records = kept,
		interrupts = schedule_payload.interrupts or {},
		group = schedule_payload.group,
	}
end

return Gateway
