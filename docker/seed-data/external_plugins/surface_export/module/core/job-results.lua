-- FactorioSurfaceExport - Async Job Results
-- Shared helper for trimming the async_job_results store to a bounded size.
-- Extracted from export-pipeline.lua and import-completion.lua (identical copies).

local JobResults = {}

--- Extract the shared async job-id counter for age ordering. Two id formats
--- share storage.async_job_id_counter: import jobs "import_<n>" (trailing
--- number) and export jobs "<nnn>_<name>" (leading zero-padded number).
--- Returns nil for an unrecognized format (caller falls back to string compare).
local function job_counter(id)
	return tonumber(string.match(id, "^(%d+)_")) or tonumber(string.match(id, "_(%d+)$"))
end

--- Trim storage.async_job_results to at most max_entries, evicting the
--- oldest (lowest job counter) results first.
--- @param max_entries number: Maximum number of stored results to keep
function JobResults.prune(max_entries)
	local keys = {}
	for key in pairs(storage.async_job_results) do
		table.insert(keys, key)
	end
	-- Order by embedded job counter (true creation order), not lexicographically,
	-- so "import_10" is not evicted before "import_2".
	table.sort(keys, function(a, b)
		local ca, cb = job_counter(a), job_counter(b)
		if ca and cb and ca ~= cb then
			return ca < cb
		end
		return a < b
	end)
	while #keys > max_entries do
		local oldest = table.remove(keys, 1)
		storage.async_job_results[oldest] = nil
	end
end

return JobResults
