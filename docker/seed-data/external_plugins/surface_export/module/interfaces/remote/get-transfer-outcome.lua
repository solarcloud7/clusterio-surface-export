-- FactorioSurfaceExport - get_transfer_outcome (remote)
--
-- #106 restart reconciliation: answer the controller's "what did THIS (destination) instance do with
-- transferId X?" query. The controller feeds the answer to resolvePendingTransfer() to decide whether a
-- source platform, left locked by a controller restart, should be deleted (dest committed), unlocked (dest
-- never committed), or waited on. Reads the AUTHORITATIVE terminal outcome recorded at import-completion
-- plus a scan of active import jobs for the in-progress signal.

--- @param transfer_id string
--- @return table { found, success, in_progress, platform_name }
local function get_transfer_outcome(transfer_id)
	local result = { found = false, success = false, in_progress = false, platform_name = nil }
	if type(transfer_id) ~= "string" or transfer_id == "" then
		return result
	end

	-- Terminal outcome recorded at import-completion (present ⇒ this instance finished + validated the import).
	local outcomes = storage.surface_export_transfer_outcomes
	local rec = outcomes and outcomes[transfer_id]
	if rec then
		result.found = true
		result.success = rec.success and true or false
		result.platform_name = rec.platform_name
	end

	-- Is an import for this transfer still RUNNING (no terminal outcome yet)? A `found` outcome takes
	-- precedence controller-side, so this only decides the !found case (still importing vs. never received).
	for _, job in pairs(storage.async_jobs or {}) do
		if job and job.type == "import" and job.transfer_id == transfer_id then
			result.in_progress = true
			break
		end
	end

	return result
end

return get_transfer_outcome
