-- FactorioSurfaceExport - Transaction History
-- Persistent transaction history for in-game dashboard display.
--
-- CRITICAL: Profiler objects cannot be serialized, so we store them as LocalisedString
-- snapshots. This is the ONLY way to persist profiler time values across save/load.
--
-- LocalisedString format for profilers:
--   {"", "Phase Name: ", profiler_object}
-- This array is serializable and the game engine renders the profiler value when displayed.

local TransactionHistory = {}

--- Initialize storage.transaction_history if not present
local function ensure_storage()
	if not storage.transaction_history then
		storage.transaction_history = {
			entries = {},
			max_entries = 100,
			sequence = 0
		}
	end
end

--- Snapshot profiler values as LocalisedStrings (the ONLY serializable form)
--- @param perf table|nil: PhaseProfiler.get() result (phase_name → LuaProfiler)
--- @return table: { phase_name → LocalisedString }
local function snapshot_profilers(perf)
	if not perf then return {} end
	local snapshot = {}
	for phase_name, profiler_obj in pairs(perf) do
		-- CRITICAL: Store as LocalisedString array, not tostring()
		-- tostring() returns "userdata: 0x..." (useless)
		-- LocalisedString array is serializable and renders correctly in GUI
		snapshot[phase_name] = {"", profiler_obj}
	end
	return snapshot
end

--- Record a completed import transaction
--- @param job table: Import job data
--- @param validation_result table|nil: Validation result if this was a transfer
--- @param perf table|nil: PhaseProfiler.get() result (must be called BEFORE discard)
function TransactionHistory.record_import(job, validation_result, perf)
	ensure_storage()
	
	local hist = storage.transaction_history
	hist.sequence = hist.sequence + 1
	
	local entry = {
		seq = hist.sequence,
		tick = game.tick,
		op_type = job.transfer_id and "transfer" or "import",
		platform_name = job.platform_name,
		entity_count = job.total_entities,
		duration_ticks = (job.metrics.import_completed_tick or game.tick) - (job.metrics.import_started_tick or game.tick),
		status = "complete",
		-- Serializable phase snapshots (LocalisedString arrays)
		phase_snapshots = snapshot_profilers(perf),
		-- Plain data validation summary
		validation = validation_result and {
			success = validation_result.success,
			mismatch_summary = validation_result.mismatch_summary
		} or nil,
		-- Additional metadata
		transfer_id = job.transfer_id,
		source_instance_id = job.source_instance_id,
		tiles_count = job.metrics.tiles_placed or 0,
		fluids_count = job.metrics.fluids_restored or 0
	}
	
	table.insert(hist.entries, 1, entry)  -- Insert at front (newest first)
	
	-- Prune old entries
	while #hist.entries > hist.max_entries do
		table.remove(hist.entries)
	end
	
	log(string.format("[TransactionHistory] Recorded import seq=%d, platform=%s, entities=%d",
		entry.seq, entry.platform_name, entry.entity_count))
end

--- Record a completed export transaction
--- @param job table: Export job data
--- @param perf table|nil: PhaseProfiler.get() result (must be called BEFORE discard)
function TransactionHistory.record_export(job, perf)
	ensure_storage()
	
	local hist = storage.transaction_history
	hist.sequence = hist.sequence + 1
	
	local duration_ticks = (job.metrics and job.metrics.export_completed_tick or game.tick) - 
	                       (job.metrics and job.metrics.export_started_tick or game.tick)
	
	local entry = {
		seq = hist.sequence,
		tick = game.tick,
		op_type = job.destination_instance_id and "transfer" or "export",
		platform_name = job.platform_name,
		entity_count = job.total_entities,
		duration_ticks = duration_ticks,
		status = "complete",
		-- Serializable phase snapshots (LocalisedString arrays)
		phase_snapshots = snapshot_profilers(perf),
		-- Additional metadata
		destination_instance_id = job.destination_instance_id,
		export_id = job.export_id or ("export_" .. hist.sequence)
	}
	
	table.insert(hist.entries, 1, entry)  -- Insert at front (newest first)
	
	-- Prune old entries
	while #hist.entries > hist.max_entries do
		table.remove(hist.entries)
	end
	
	log(string.format("[TransactionHistory] Recorded export seq=%d, platform=%s, entities=%d",
		entry.seq, entry.platform_name, entry.entity_count))
end

--- Get recent transaction history
--- @param limit number|nil: Max entries to return (default: 25)
--- @return table: Array of transaction entries (newest first)
function TransactionHistory.list(limit)
	ensure_storage()
	limit = limit or 25
	
	local result = {}
	for i = 1, math.min(limit, #storage.transaction_history.entries) do
		table.insert(result, storage.transaction_history.entries[i])
	end
	return result
end

--- Clear all transaction history (admin only)
function TransactionHistory.clear()
	ensure_storage()
	storage.transaction_history.entries = {}
	storage.transaction_history.sequence = 0
	log("[TransactionHistory] History cleared")
end

--- Get entry count
--- @return number: Total entries in history
function TransactionHistory.count()
	ensure_storage()
	return #storage.transaction_history.entries
end

return TransactionHistory
