-- FactorioSurfaceExport - Async Job Results
-- Shared helper for trimming the async_job_results store to a bounded size.
-- Extracted from export-pipeline.lua and import-completion.lua (identical copies).

local JobResults = {}

--- Trim storage.async_job_results to at most max_entries, evicting the
--- lowest-sorted (oldest) job ids first.
--- @param max_entries number: Maximum number of stored results to keep
function JobResults.prune(max_entries)
	local keys = {}
	for key in pairs(storage.async_job_results) do
		table.insert(keys, key)
	end
	table.sort(keys)
	while #keys > max_entries do
		local oldest = table.remove(keys, 1)
		storage.async_job_results[oldest] = nil
	end
end

return JobResults
