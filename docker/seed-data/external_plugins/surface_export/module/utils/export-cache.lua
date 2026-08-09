local clear_old_exports = require("modules/surface_export/interfaces/remote/clear-old-exports")

local ExportCache = {}

local DEFAULT_CAP = 10
local DEFAULT_CONCURRENCY = 3
local concurrency = DEFAULT_CONCURRENCY

function ExportCache.set_cap(value)
	storage.surface_export_config = storage.surface_export_config or {}
	storage.surface_export_config.max_export_cache_size = value
end

function ExportCache.get_cap()
	local configured = storage.surface_export_config and storage.surface_export_config.max_export_cache_size
	if type(configured) ~= "number" or configured < 1 then
		return DEFAULT_CAP
	end
	return configured
end

function ExportCache.set_concurrency(value)
	concurrency = value
end

function ExportCache.get_concurrency()
	return concurrency
end

function ExportCache.resolve_keep_count()
	return ExportCache.resolve_keep_count_for(ExportCache.get_cap(), concurrency)
end

function ExportCache.resolve_keep_count_for(configured, concurrency_limit)
	if type(configured) ~= "number" or configured < 1 then
		configured = DEFAULT_CAP
	end
	local floor = concurrency_limit
	if type(floor) ~= "number" or floor < 1 then
		floor = DEFAULT_CONCURRENCY
	end
	floor = floor + 1
	if configured < floor then
		return floor, true
	end
	return configured, false
end

function ExportCache.record(export_id, entry)
	storage.platform_exports = storage.platform_exports or {}
	storage.platform_export_seq = (storage.platform_export_seq or 0) + 1
	entry.cache_seq = storage.platform_export_seq
	storage.platform_exports[export_id] = entry
	return entry
end

local function protected_export_ids()
	local protected = {}
	for _, lock in pairs(storage.locked_platforms or {}) do
		if lock.transfer_job_id then
			protected[lock.transfer_job_id] = true
		end
		if lock.committed_transfer_id then
			protected[lock.committed_transfer_id] = true
		end
	end
	return protected
end

function ExportCache.prune_to_configured_cap()
	local keep_count, was_raised = ExportCache.resolve_keep_count()
	local removed = clear_old_exports(keep_count, nil, protected_export_ids())
	if was_raised then
		log(string.format(
			"[ExportCache] max_export_cache_size=%s is below the max_concurrent_jobs+1 sanity floor; keeping %d instead",
			tostring(ExportCache.get_cap()), keep_count))
	end
	if removed > 0 then
		log(string.format("[ExportCache] Pruned %d old export(s), keeping newest %d", removed, keep_count))
	end
	return removed
end

return ExportCache
