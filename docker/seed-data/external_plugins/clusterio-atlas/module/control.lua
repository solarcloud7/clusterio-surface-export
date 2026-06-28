-- Clusterio Atlas Module (Save-patched)
-- Ingests Factorio map data: captures per-chunk entity data and ships it over
-- Clusterio IPC to the host plugin, which lands it in the atlas database.
--
-- IMPORTANT: This module uses the event_handler interface required by Clusterio.
-- Do NOT use script.on_init, script.on_event, etc. directly — that would
-- overwrite Clusterio's own event handlers and break initialization.
-- See: https://github.com/clusterio/clusterio/blob/main/docs/developing-for-clusterio.md

local clusterio_api = require("modules/clusterio/api")

local Atlas = {}
local e = defines.events

-- Backpressure: drain at most CHUNKS_PER_TICK dirty chunks every TICK_INTERVAL
-- ticks so capturing never stalls the game on a busy map.
local CHUNKS_PER_TICK = 4
local TICK_INTERVAL = 30

-- ============================================================================
-- Storage / init (event_handler callbacks)
-- ============================================================================

local function init_storage()
	storage.atlas = storage.atlas or {}
	storage.atlas.dirty = storage.atlas.dirty or {}   -- "si_cx_cy" -> {si, cx, cy}
end

function Atlas.on_init()
	init_storage()
	log("[Atlas] Save-patched module loaded")
end

function Atlas.on_configuration_changed()
	init_storage()
end

-- ============================================================================
-- Dirty-chunk tracking
-- ============================================================================

local function mark(si, cx, cy)
	storage.atlas.dirty[si .. "_" .. cx .. "_" .. cy] = { si = si, cx = cx, cy = cy }
end

local function mark_pos(surface, pos)
	mark(surface.index, math.floor(pos.x / 32), math.floor(pos.y / 32))
end

-- ============================================================================
-- Capture: absolute-coordinate entity data for one chunk.
-- Scope (Phase 0): player-built entities + resources only. Natural clutter
-- (trees, rocks, cliffs, decoratives) and enemies are excluded to keep fresh
-- chunks from dumping thousands of low-value rows.
-- ============================================================================

local function capture(surface, area)
	local out = {}
	local function add(ent)
		if ent.valid then
			out[#out + 1] = {
				name = ent.name,
				type = ent.type,
				x = ent.position.x,
				y = ent.position.y,
				dir = ent.direction,
				force = ent.force and ent.force.name or nil,
				amount = (ent.type == "resource") and ent.amount or nil,
				recipe = (ent.type == "assembling-machine" and ent.get_recipe()) and ent.get_recipe().name or nil,
			}
		end
	end
	for _, ent in pairs(surface.find_entities_filtered { area = area, force = "player" }) do add(ent) end
	for _, ent in pairs(surface.find_entities_filtered { area = area, type = "resource" }) do add(ent) end
	return out
end

local function process(c)
	local surface = game.surfaces[c.si]
	if not surface then return end
	local area = {
		left_top = { c.cx * 32, c.cy * 32 },
		right_bottom = { (c.cx + 1) * 32, (c.cy + 1) * 32 },
	}
	clusterio_api.send_json("atlas_chunk", {
		surface = surface.name,
		cx = c.cx,
		cy = c.cy,
		entities = capture(surface, area),
	})
end

-- ============================================================================
-- Event handlers (event_handler interface)
-- ============================================================================

Atlas.events = {
	[e.on_chunk_generated]     = function(ev) mark(ev.surface.index, ev.position.x, ev.position.y) end,
	[e.on_built_entity]        = function(ev) mark_pos(ev.entity.surface, ev.entity.position) end,
	[e.on_robot_built_entity]  = function(ev) mark_pos(ev.entity.surface, ev.entity.position) end,
	[e.on_player_mined_entity] = function(ev) mark_pos(ev.entity.surface, ev.entity.position) end,
	[e.on_robot_mined_entity]  = function(ev) mark_pos(ev.entity.surface, ev.entity.position) end,

	[e.on_tick] = function()
		if game.tick % TICK_INTERVAL ~= 0 then return end
		local n = 0
		for key, c in pairs(storage.atlas.dirty) do
			storage.atlas.dirty[key] = nil
			process(c)
			n = n + 1
			if n >= CHUNKS_PER_TICK then break end
		end
	end,

	[clusterio_api.events.on_server_startup] = function()
		init_storage()
	end,
}

-- ============================================================================
-- Commands
-- ============================================================================

function Atlas.add_commands()
	commands.add_command("atlas_rescan_all", "Queue all generated chunks for atlas ingest", function(cmd)
		local count = 0
		for _, s in pairs(game.surfaces) do
			for ch in s.get_chunks() do
				mark(s.index, ch.x, ch.y)
				count = count + 1
			end
		end
		local p = cmd.player_index and game.players[cmd.player_index]
		if p then p.print("Queued " .. count .. " chunks for atlas ingest.") end
	end)
end

return Atlas
