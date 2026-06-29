-- FactorioSurfaceExport - Gateway identification + unlock
--
-- Gateways are surfaceless `space-location` prototypes added by the `surfexp_gateways` data mod
-- (surfexp_gateway_1..N). A platform can route to and PARK at one (they have no fly_condition). This
-- module identifies them and unlocks them per-force so platforms can route there. It caches NOTHING:
-- prototypes are always queryable at runtime, so a stored gateway set would just be redundant state.
--
-- All gateway *logic* (arrival detection, transfer trigger, hop-strip) lives in the save-patched
-- module, not the data mod. See docs/GATEWAY_TRANSFER_PRD.md.

local Gateway = {}

-- Every gateway space-location name starts with this. Kept in lockstep with surfexp_gateways/data.lua.
Gateway.PREFIX = "surfexp_gateway_"

--- Is `name` a gateway space-location? Prefix match AND a real prototype, so a renamed/stale name
--- (or an arbitrary station that merely starts with the prefix) cannot masquerade as a gateway.
--- @param name string|nil
--- @return boolean
function Gateway.is_gateway(name)
	if type(name) ~= "string" then
		return false
	end
	if name:sub(1, #Gateway.PREFIX) ~= Gateway.PREFIX then
		return false
	end
	return prototypes.space_location[name] ~= nil
end

--- Unlock every gateway space-location for every force so platforms can route to them. Idempotent and
--- cheap — safe to call on every server startup. pcall-guarded per (force, gateway) so one bad force
--- (e.g. a force without space travel) can't abort the rest.
--- @return number unlocked The number of (force, gateway) unlocks that succeeded.
function Gateway.discover_and_unlock()
	local unlocked = 0
	for name, _ in pairs(prototypes.space_location) do
		if Gateway.is_gateway(name) then
			for _, force in pairs(game.forces) do
				local ok, err = pcall(function()
					force.unlock_space_location(name)
				end)
				if ok then
					unlocked = unlocked + 1
				else
					log(string.format("[Gateway] unlock '%s' for force '%s' failed: %s",
						name, tostring(force.name), tostring(err)))
				end
			end
		end
	end
	log(string.format("[Gateway] discover_and_unlock: %d gateway/force unlocks", unlocked))
	return unlocked
end

--- The gateway a platform is currently PARKED at (waiting_at_station at a gateway space-location), or
--- nil. The single source of truth for the "is this platform at a gateway right now" predicate, shared
--- by the /gateway-transfer command and the on-arrival handler (do not re-inline the check).
--- @param platform LuaSpacePlatform|nil
--- @return string|nil gateway_name
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

--- Players + character entities currently aboard a platform (on its own surface). Two complementary
--- signals: a player is BODILY aboard iff `player.physical_surface_index == platform.surface.index`
--- (catches a connected pilot AND a disconnected player still standing on it), and
--- `surface.count_entities_filtered{type="character"}` catches abandoned character bodies with no player.
--- A remote-view watcher has surface_index == the platform but NOT physical_surface_index → NOT a passenger.
--- This is the input to the passenger COUNT shown in the chooser GUI and the list Gateway.evacuate_passengers
--- teleports off before a transfer deletes the surface (passengers are EVACUATED, never blocked) — one source
--- of truth, shared by the GUI display and the delete-time evacuation.
--- @param platform LuaSpacePlatform|nil
--- @return table players (array of LuaPlayer bodily aboard), number character_count
function Gateway.collect_passengers(platform)
	local players = {}
	if not (platform and platform.valid and platform.surface and platform.surface.valid) then
		return players, 0
	end
	local surf_idx = platform.surface.index
	for _, player in pairs(game.players) do
		-- intentional probe; reading physical_surface_index can fail for an odd/transient player state,
		-- and skipping that player is the correct fallback (they're simply not counted aboard). No log.
		local ok, psi = pcall(function() return player.physical_surface_index end)
		if ok and psi == surf_idx then
			players[#players + 1] = player
		end
	end
	-- The surface is validated above, so count_entities_filtered should SUCCEED. If it throws, this is a
	-- safety check — do NOT swallow it: log so a real failure is visible rather than silently reporting
	-- "nobody aboard". The 0 fallback is acceptable because the per-player loop above is the primary signal.
	local ok_c, char_count = pcall(function()
		return platform.surface.count_entities_filtered{type = "character"}
	end)
	if not ok_c then
		log(string.format("[Gateway] collect_passengers: count_entities_filtered{character} failed for platform '%s': %s",
			tostring(platform.name), tostring(char_count)))
	end
	return players, (ok_c and char_count) or 0
end

--- The number of distinct passengers aboard, for user-facing messages. Uses max(), NOT sum: a CONNECTED
--- player is counted both as a player (physical_surface_index) and via their character entity in
--- aboard_characters, so summing double-counts the common one-player case. max() is exact there and a safe
--- lower bound otherwise — the block decision itself fires on ANY signal, so this is display-only.
--- @param aboard_players table array of LuaPlayer
--- @param aboard_characters number
--- @return number
function Gateway.passenger_count(aboard_players, aboard_characters)
	return math.max(#(aboard_players or {}), aboard_characters or 0)
end

--- Evacuate everyone bodily aboard a platform to a safe planetary surface, called RIGHT BEFORE the platform
--- is deleted on a transfer. A transfer ends in game.delete_surface; without this, anyone aboard is orphaned.
--- This is NATIVE-ALIGNED: the engine itself sends a player "back to the planet they were last at" on hub
--- loss. We do NOT block the transfer (the old hard-block kept finding new bypass entry points); we let it
--- proceed and evacuate at the delete — the ONE chokepoint every transfer path funnels through, so it cannot
--- be bypassed and a delete-time evacuation can never duplicate the platform (the dest copy is already
--- committed by the time the source is deleted).
---
--- Teleports aboard players (connected + disconnected) AND abandoned character bodies to a non-colliding
--- position near the force's Nauvis spawn (fallback: the first planetary surface; if none, log + skip so a
--- clean teardown still beats an orphan). Every move is pcall-guarded + logged; one failure never aborts the
--- rest, and evacuation failure NEVER blocks the delete.
--- @param platform LuaSpacePlatform
--- @return table result {players=number, characters=number, failures=number}
function Gateway.evacuate_passengers(platform)
	local result = { players = 0, characters = 0, failures = 0 }
	if not (platform and platform.valid and platform.surface and platform.surface.valid) then
		return result
	end
	local surface = platform.surface

	-- Destination: a planetary (non-platform) surface — Nauvis by default, else the first planet found.
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

	-- 1) Aboard players first (connected + disconnected) — physical_surface_index match. teleport moves the
	-- player AND their character together; check the boolean return so a failed placement is counted, not lost.
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

	-- 2) Then abandoned character bodies still on the platform (logged-off players with no controller). A
	-- connected player's character was already moved above, so it is no longer on this surface.
	local chars = {}
	-- intentional probe; surface is validated above, the find should succeed — empty list on failure is fine.
	pcall(function() chars = surface.find_entities_filtered{ type = "character" } end)
	for _, char in ipairs(chars) do
		if char and char.valid then
			-- Return the teleport boolean so a FAILED placement (no room) is counted as a failure, not a
			-- phantom success — matching the player branch above. Without the `return`, a character the engine
			-- refuses to place is logged as evacuated and then destroyed with the surface (silent loss).
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

--- Return a copy of schedule_payload with EVERY gateway-station record removed, carrying `current`
--- FORWARD to the record that followed the gateway (NOT reset to 1) so a resumed itinerary continues
--- rather than re-travelling an already-visited stop. Schedules are cyclic, so a gateway in the last
--- position wraps the cursor to 1. Returns nil if removing the gateways would leave no records at all
--- (caller keeps the original schedule then — a lone-gateway schedule stays valid).
--- @param schedule_payload table
--- @return table|nil stripped
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
			-- The first kept record at or after the old cursor → resume forward from here.
			if new_current == nil and i >= orig_current then
				new_current = #kept
			end
		end
	end
	if #kept == 0 then
		return nil
	end
	if new_current == nil then
		new_current = 1 -- cursor was at/after the last kept record (e.g. gateway was last) → wrap to 1
	end
	return {
		current = new_current,
		records = kept,
		interrupts = schedule_payload.interrupts or {},
		group = schedule_payload.group,
	}
end

return Gateway
