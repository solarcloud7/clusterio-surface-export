local BeltRestoration = require("modules/surface_export/import_phases/belt_restoration")
local InventoryScanner = require("modules/surface_export/export_scanners/inventory-scanner")
local SourceCargoIntegrity = require("modules/surface_export/export_scanners/source-cargo-integrity")
local CargoCounter = require("modules/surface_export/validators/cargo-counter")
local Util = require("modules/surface_export/utils/util")

local SourceBeltCargo = {}

local QUALITY_NORMAL = Util.QUALITY_NORMAL
local DEFAULT_BUDGET = 100
local BELT_TYPES = { "transport-belt", "underground-belt", "splitter", "loader", "loader-1x1", "linked-belt", "lane-splitter" }

function SourceBeltCargo.budget()
	local cfg = storage.surface_export_config
	local value = cfg and tonumber(cfg.belt_capture_budget)
	if value and value >= 1 then return math.floor(value) end
	return DEFAULT_BUDGET
end

function SourceBeltCargo.owning_lock(job)
	local lock = storage.locked_platforms and storage.locked_platforms[job.platform_index] or nil
	if type(lock) == "table" and lock.kind == "transfer" and lock.transfer_job_id == job.job_id then return lock end
	return nil
end

function SourceBeltCargo.capture_active(record)
	if type(record) ~= "table" or record.complete then return false end
	local job = storage.async_jobs and storage.async_jobs[record.job_id] or nil
	return type(job) == "table" and not job.completion_interrupted
end

local function owned_record(job, state)
	local lock = SourceBeltCargo.owning_lock(job)
	if not lock then
		error(string.format("belt capture for %s stopped: the platform's transfer lock is no longer held by this job", tostring(job.job_id)), 0)
	end
	local record = lock.cleared_belts
	if type(record) ~= "table" or record.job_id ~= job.job_id or (state and record.groups ~= state.groups) then
		error(string.format("belt capture for %s stopped: the lock no longer carries this job's cleared-cargo record", tostring(job.job_id)), 0)
	end
	return lock, record
end

local function pin(record, reason)
	if record and not record.pinned then record.pinned = { tick = game.tick, reason = reason } end
end

local function root_of(state, gi)
	local parent = state.group_parent
	while parent[gi] ~= gi do parent[gi] = parent[parent[gi]]; gi = parent[gi] end
	return gi
end

local function join_groups(state, a, b)
	a, b = root_of(state, a), root_of(state, b)
	if a ~= b then state.group_parent[math.max(a, b)] = math.min(a, b) end
end

function SourceBeltCargo.begin(job)
	local lock = SourceBeltCargo.owning_lock(job)
	if not lock then
		error(string.format("belt capture for %s refused: the platform's transfer lock is not held by this job", tostring(job.job_id)), 0)
	end
	if lock.cleared_belts then
		error(string.format("belt capture for %s refused: the lock already carries a cleared-cargo record for %s", tostring(job.job_id), tostring(lock.cleared_belts.job_id)), 0)
	end
	local units = {}
	for serialized_index, entity in pairs(job.belt_entities or {}) do
		local entity_data = job.export_data.entities[serialized_index]
		if entity and entity.valid and entity_data then
			units[#units + 1] = { entity = entity, id = entity_data.entity_id, serialized_index = serialized_index,
				unit_number = entity.unit_number }
		else
			log(string.format("[Belt Scan] WARNING: Belt entity at index %d became invalid before capture", serialized_index))
		end
	end
	table.sort(units, function(a, b) return a.serialized_index < b.serialized_index end)
	local groups, line_group = BeltRestoration.partition_side_groups(units)
	local state = { units = units, cursor = 1, sweeping = false, done = false, cleared = {}, groups = groups,
		line_group = line_group, group_parent = {}, unit_numbers = {}, stacks = 0, sweep_stacks = 0, merged = 0,
		callbacks = 0, started_tick = game.tick }
	for gi in ipairs(groups) do state.group_parent[gi] = gi end
	for _, unit in ipairs(units) do state.unit_numbers[unit.id] = unit.unit_number end
	job.belt_capture = state
	lock.cleared_belts = { job_id = job.job_id, platform_uid = job.platform_uid, groups = groups,
		group_parent = state.group_parent, unit_numbers = state.unit_numbers }
	log(string.format("[Belt Scan] Staggered capture of %d belt(s) in %d side group(s) begins (budget %d belt(s) per callback)",
		#units, #groups, SourceBeltCargo.budget()))
	return state
end

local function append_line_items(entity_data, lines_out)
	entity_data.specific_data = entity_data.specific_data or {}
	local existing = entity_data.specific_data.items
	if not existing then
		entity_data.specific_data.items = lines_out
		return
	end
	for _, line_data in ipairs(lines_out) do
		local target
		for _, present in ipairs(existing) do
			if present.line == line_data.line then target = present break end
		end
		if target then
			for _, item in ipairs(line_data.items) do target.items[#target.items + 1] = item end
		else
			existing[#existing + 1] = line_data
		end
	end
end

local function capture_unit(job, state, record, unit, cache, seen, sweeping)
	local entity = unit.entity
	if not (entity and entity.valid) then
		error(string.format("belt %s became invalid during capture", tostring(unit.id)), 0)
	end
	local entity_data = job.export_data.entities[unit.serialized_index]
	local lines, lines_out, pending = {}, {}, {}
	for li = 1, entity.get_max_transport_line_index() do
		local line = entity.get_transport_line(li)
		local gi = root_of(state, state.line_group[tostring(unit.id) .. "/" .. li])
		local items = {}
		for _, it in ipairs(line.get_detailed_contents()) do
			local stack = it.stack
			if stack and stack.valid_for_read then
				local uid = tostring(it.unique_id)
				if state.cleared[uid] then
					local reason = string.format("belt cargo contract violated: item %s (%s) reappeared on %s line %d after it was cleared",
						uid, tostring(stack.name), tostring(unit.id), li)
					pin(record, reason)
					error(reason, 0)
				end
				local name, count = stack.name, stack.count
				local quality = (stack.quality and stack.quality.name) or QUALITY_NORMAL
				items[#items + 1] = { name = name, count = count, quality = quality }
				local owner = seen[uid]
				if owner then
					if owner ~= gi then
						join_groups(state, owner, gi)
						state.merged = state.merged + 1
					end
				else
					seen[uid] = gi
					pending[#pending + 1] = { gi = gi, li = li, position = math.floor((it.position or 0) * 256 + 0.5),
						slot = { n = name, q = quality, ct = count, st = BeltRestoration.belt_item_state(stack, cache) } }
				end
			end
		end
		if #items > 0 then lines_out[#lines_out + 1] = { line = li, items = items } end
		lines[#lines + 1] = line
	end
	if #lines_out > 0 or not sweeping then
		SourceCargoIntegrity.record(job.census, entity, { entity_id = entity_data.entity_id, specific_data = { items = lines_out } })
	end
	for _, entry in ipairs(pending) do
		local g = state.groups[root_of(state, entry.gi)]
		g.slots[#g.slots + 1] = entry.slot
		local s = g.item_source_positions
		s[#s + 1] = unit.id
		s[#s + 1] = entry.li
		s[#s + 1] = entry.position
	end
	state.stacks = state.stacks + #pending
	if sweeping then state.sweep_stacks = state.sweep_stacks + #pending end
	append_line_items(entity_data, lines_out)
	local cleared_ok, clear_err = pcall(function()
		for _, line in ipairs(lines) do line.clear() end
	end)
	if not cleared_ok then
		local reason = string.format("clearing belt %s failed after its cargo was recorded: %s", tostring(unit.id), tostring(clear_err))
		pin(record, reason)
		error(reason, 0)
	end
end

function SourceBeltCargo.step(job, budget)
	local state = job.belt_capture
	if not state or state.done then return true end
	local _, record = owned_record(job, state)
	state.callbacks = state.callbacks + 1
	local cache_ok, cache = pcall(InventoryScanner.new_item_state_cache)
	if not cache_ok then
		log(string.format("[BeltRestoration] item-state cache unavailable (%s) — this callback's slots ship stateless", tostring(cache)))
		cache = nil
	end
	local seen = {}
	local ok, err = pcall(function()
		if not state.sweeping then
			local processed = 0
			while state.cursor <= #state.units and processed < budget do
				capture_unit(job, state, record, state.units[state.cursor], cache, seen, false)
				state.cursor = state.cursor + 1
				processed = processed + 1
			end
			if state.cursor > #state.units then state.sweeping = true end
			return
		end
		for _, unit in ipairs(state.units) do capture_unit(job, state, record, unit, cache, seen, true) end
		state.done = true
	end)
	Util.pcall_warn("[BeltRestoration] item-state cache release", function()
		InventoryScanner.release_item_state_cache(cache)
	end)
	for uid in pairs(seen) do state.cleared[uid] = true end
	if not ok then error(err, 0) end
	return state.done
end

local function coalesce(state)
	local out, index_of = {}, {}
	for gi, g in ipairs(state.groups) do
		local r = root_of(state, gi)
		local target = index_of[r]
		if not target then
			target = { members = {}, slots = {}, item_source_positions = {} }
			index_of[r] = target
			out[#out + 1] = target
		end
		for _, m in ipairs(g.members) do target.members[#target.members + 1] = m end
		for _, slot in ipairs(g.slots) do target.slots[#target.slots + 1] = slot end
		for _, v in ipairs(g.item_source_positions) do target.item_source_positions[#target.item_source_positions + 1] = v end
	end
	return out
end

function SourceBeltCargo.finish(job)
	local state = job.belt_capture
	local _, record = owned_record(job, state)
	local groups = coalesce(state)
	local stateful = 0
	for _, g in ipairs(groups) do
		for _, slot in ipairs(g.slots) do if slot.st then stateful = stateful + 1 end end
	end
	job.export_data.belt_side_groups = groups
	record.groups = groups
	record.group_parent = nil
	record.complete = true
	log(string.format("[Belt Scan] Staggered capture done for '%s': %d belt(s), %d stack(s) (%d picked up by the final sweep), %d side group(s) (%d merged at a straddling item), %d slot(s) carry non-default item state, %d callback(s) over %d tick(s)",
		tostring(job.platform_name), #state.units, state.stacks, state.sweep_stacks, #groups, state.merged, stateful, state.callbacks, game.tick - state.started_tick))
	return { belts = #state.units, stacks = state.stacks, sweep_stacks = state.sweep_stacks, groups = #groups, callbacks = state.callbacks }
end

local function record_summary(record)
	local slots, items = 0, 0
	local groups = record.groups or {}
	if record.group_parent then groups = coalesce({ groups = groups, group_parent = record.group_parent }) end
	for _, g in ipairs(groups) do
		for _, slot in ipairs(g.slots) do slots = slots + 1; items = items + (slot.ct or 0) end
	end
	return slots, items
end

function SourceBeltCargo.describe(record)
	if type(record) ~= "table" then return "no captured belt cargo is recorded" end
	local slots, items = record_summary(record)
	local parts = { string.format("job %s: %d stack(s) / %d item(s) cleared from the belts%s", tostring(record.job_id), slots, items,
		record.complete and " (capture finished)" or " (capture was still in progress)") }
	if record.pinned then parts[#parts + 1] = "pinned: " .. tostring(record.pinned.reason) end
	if record.attempt then
		parts[#parts + 1] = string.format("an earlier restore attempt placed %s item(s) and then failed: %s",
			tostring(record.attempt.placed or "an unknown number of"), tostring(record.attempt.error))
	end
	return table.concat(parts, "; ")
end

function SourceBeltCargo.restore(lock_data, label, surface, options)
	local record = lock_data and lock_data.cleared_belts
	if not record then return true, nil end
	options = options or {}
	if not (surface and surface.valid) then return false, "the platform surface is unavailable" end
	if record.pinned then
		return false, string.format("the record is pinned (%s); inspect the platform, then /belt-cargo abandon or restore-present", tostring(record.pinned.reason))
	end
	if record.attempt then
		return false, string.format("an earlier restore attempt placed %s item(s) and then failed (%s); inspect the platform, then /belt-cargo abandon",
			tostring(record.attempt.placed or "an unknown number of"), tostring(record.attempt.error))
	end
	local groups = record.groups
	if record.group_parent then
		groups = coalesce({ groups = record.groups, group_parent = record.group_parent })
	end
	for _, g in ipairs(groups) do
		for _, slot in ipairs(g.slots) do
			if not prototypes.item[slot.n] or (slot.q and not prototypes.quality[slot.q]) then
				return false, string.format("captured item %s (%s) has no prototype on this server", tostring(slot.n), tostring(slot.q))
			end
		end
	end
	local by_unit = {}
	for _, entity in ipairs(surface.find_entities_filtered({ type = BELT_TYPES })) do
		if entity.valid and entity.unit_number then by_unit[entity.unit_number] = entity end
	end
	local entity_map, missing_belts, missing_ids = {}, 0, {}
	for entity_id, unit_number in pairs(record.unit_numbers or {}) do
		local entity = by_unit[unit_number]
		if entity then entity_map[entity_id] = entity else missing_belts = missing_belts + 1; missing_ids[entity_id] = true end
	end
	local missing_slots, missing_items = 0, 0
	for _, g in ipairs(groups) do
		local positions = g.item_source_positions or {}
		for si, slot in ipairs(g.slots) do
			if missing_ids[positions[(si - 1) * 3 + 1]] then missing_slots = missing_slots + 1; missing_items = missing_items + (slot.ct or 0) end
		end
	end
	if missing_belts > 0 and not options.allow_missing then
		return false, string.format("%d belt(s) whose cargo was captured are no longer on the platform (%d stack(s) / %d item(s) captured from them); /belt-cargo restore-present places the rest",
			missing_belts, missing_slots, missing_items)
	end
	local ok, placed, unplaced, anomalies = pcall(BeltRestoration.restore_side_groups, groups, entity_map, label)
	if not ok then
		record.attempt = { tick = game.tick, error = tostring(placed) }
		return false, tostring(placed)
	end
	if unplaced ~= missing_items or anomalies > 0 then
		local reason = string.format("%d item(s) unplaced (%d expected from missing belts), %d side group(s) mismatched after placing %d",
			unplaced, missing_items, anomalies, placed)
		record.attempt = { tick = game.tick, placed = placed, error = reason }
		return false, reason
	end
	local census = "capture was still in progress, so only the per-group check applies"
	if record.complete then
		local expected, actual = {}, {}
		for _, g in ipairs(groups) do
			local positions = g.item_source_positions or {}
			for si, slot in ipairs(g.slots) do
				if not missing_ids[positions[(si - 1) * 3 + 1]] then
					local key = Util.make_quality_key(slot.n, slot.q or QUALITY_NORMAL)
					expected[key] = (expected[key] or 0) + slot.ct
				end
			end
		end
		local census_ok, census_err = pcall(function()
			for _, entity in pairs(entity_map) do
				for key, count in pairs(CargoCounter.count_entity_items(entity, "belts")) do actual[key] = (actual[key] or 0) + count end
			end
		end)
		if not census_ok then
			record.attempt = { tick = game.tick, placed = placed, error = "belt census after the restore failed: " .. tostring(census_err) }
			return false, record.attempt.error
		end
		local mismatched = {}
		for key, count in pairs(expected) do if actual[key] ~= count then mismatched[#mismatched + 1] = string.format("%s captured %d, on belts %d", key, count, actual[key] or 0) end end
		for key, count in pairs(actual) do if not expected[key] then mismatched[#mismatched + 1] = string.format("%s captured 0, on belts %d", key, count) end end
		if #mismatched > 0 then
			table.sort(mismatched)
			local reason = string.format("belt census after the restore differs from the capture in %d item key(s): %s", #mismatched, table.concat(mismatched, "; ", 1, math.min(#mismatched, 5)))
			record.attempt = { tick = game.tick, placed = placed, error = reason }
			return false, reason
		end
		census = "belt census after the restore matches the capture exactly"
	end
	lock_data.cleared_belts = nil
	if missing_belts > 0 then
		log(string.format("[Belt Scan] Restored %d captured belt item(s) onto '%s'; %d belt(s) were gone, so %d stack(s) / %d item(s) captured from them could not be placed and are lost; %s",
			placed, tostring(label), missing_belts, missing_slots, missing_items, census))
	else
		log(string.format("[Belt Scan] Restored %d captured belt item(s) onto '%s' after the transfer did not complete; %s", placed, tostring(label), census))
	end
	return true, placed
end

function SourceBeltCargo.override(lock_data, action, label, surface)
	local record = lock_data and lock_data.cleared_belts
	if not record then return false, "no captured belt cargo is recorded for this platform" end
	if SourceBeltCargo.capture_active(record) then
		return false, "the capture is still running; interrupt or finish the transfer first"
	end
	if action == "abandon" then
		local summary = SourceBeltCargo.describe(record)
		lock_data.cleared_belts = nil
		log(string.format("[Belt Scan] Captured belt cargo record for '%s' abandoned by an operator; the belts keep whatever is on them now (%s)", tostring(label), summary))
		return true, summary
	elseif action == "restore-present" then
		if record.attempt and record.attempt.placed then
			return false, string.format("an earlier attempt already placed %s item(s); placing again would duplicate them, so abandon instead", tostring(record.attempt.placed))
		end
		record.attempt = nil
		record.pinned = nil
		return SourceBeltCargo.restore(lock_data, label, surface, { allow_missing = true })
	end
	return false, "unknown action; use abandon or restore-present"
end

return SourceBeltCargo
