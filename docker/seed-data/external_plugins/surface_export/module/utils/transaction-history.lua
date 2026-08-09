local TransactionHistory = {}

local function ensure_storage()
	if not storage.transaction_history then
		storage.transaction_history = {
			entries = {},
			max_entries = 100,
			sequence = 0
		}
	end
end

local function snapshot_profilers(perf)
	if not perf then return {} end
	local snapshot = {}
	for phase_name, profiler_obj in pairs(perf) do
		snapshot[phase_name] = {"", profiler_obj}
	end
	return snapshot
end

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
		duration_ticks = game.tick - (job.started_tick or game.tick),
		status = "complete",
		phase_snapshots = snapshot_profilers(perf),
		validation = validation_result and {
			success = validation_result.success,
			mismatch_summary = validation_result.mismatchDetails,
			failed_stage = validation_result.failedStage,
			failure_black_box = validation_result.failureBlackBox,
			cleanup_failed = validation_result.cleanup_failed,
			cleanup_error = validation_result.cleanup_error,
		} or nil,
		transfer_id = job.transfer_id,
		source_instance_id = job.source_instance_id,
		tiles_count = job.metrics.tiles_placed or 0,
		fluids_count = job.metrics.fluids_restored or 0
	}
	
	table.insert(hist.entries, 1, entry)
	
	while #hist.entries > hist.max_entries do
		table.remove(hist.entries)
	end
	
	log(string.format("[TransactionHistory] Recorded import seq=%d, platform=%s, entities=%d",
		entry.seq, entry.platform_name, entry.entity_count))
end

function TransactionHistory.record_export(job, perf)
	ensure_storage()
	
	local hist = storage.transaction_history
	hist.sequence = hist.sequence + 1
	
	local duration_ticks = game.tick - (job.started_tick or game.tick)
	
	local entry = {
		seq = hist.sequence,
		tick = game.tick,
		op_type = job.destination_instance_id and "transfer" or "export",
		platform_name = job.platform_name,
		entity_count = job.total_entities,
		duration_ticks = duration_ticks,
		status = "complete",
		phase_snapshots = snapshot_profilers(perf),
		destination_instance_id = job.destination_instance_id,
		export_id = job.export_id or ("export_" .. hist.sequence)
	}
	
	table.insert(hist.entries, 1, entry)
	
	while #hist.entries > hist.max_entries do
		table.remove(hist.entries)
	end
	
	log(string.format("[TransactionHistory] Recorded export seq=%d, platform=%s, entities=%d",
		entry.seq, entry.platform_name, entry.entity_count))
end

function TransactionHistory.list(limit)
	ensure_storage()
	limit = limit or 25
	
	local result = {}
	for i = 1, math.min(limit, #storage.transaction_history.entries) do
		table.insert(result, storage.transaction_history.entries[i])
	end
	return result
end

function TransactionHistory.clear()
	ensure_storage()
	storage.transaction_history.entries = {}
	storage.transaction_history.sequence = 0
	log("[TransactionHistory] History cleared")
end

function TransactionHistory.count()
	ensure_storage()
	return #storage.transaction_history.entries
end

return TransactionHistory
