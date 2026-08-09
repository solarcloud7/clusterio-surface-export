local JobResults = {}

local function job_counter(id)
	return tonumber(string.match(id, "^(%d+)_")) or tonumber(string.match(id, "_(%d+)$"))
end

function JobResults.prune(max_entries)
	local keys = {}
	for key in pairs(storage.async_job_results) do
		table.insert(keys, key)
	end
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
