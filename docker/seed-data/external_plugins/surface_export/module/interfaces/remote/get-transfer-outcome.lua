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

	-- Is an ASYNC IMPORT job for this transfer still running (post-assembly, no terminal outcome yet)? A
	-- `found` outcome takes precedence controller-side, so in_progress only refines the !found case.
	--
	-- NOTE (#106 review [2]): this deliberately does NOT report in_progress for a payload still in CHUNK
	-- DELIVERY (storage.chunked_imports). Those sessions are keyed by platform_name, not transferId (the
	-- transferId lives inside the un-parsed JSON), AND after a CONTROLLER restart the controller never resumes
	-- sending the remaining chunks, so such a session is permanently STUCK. Reporting in_progress for it would
	-- make the reconcile retry FOREVER; leaving it !found + !in_progress lets the controller retry briefly then
	-- ESCALATE (source stays locked for admin review) — the reconcile never UNLOCKS on !found, so no dup.
	for _, job in pairs(storage.async_jobs or {}) do
		if job and job.type == "import" and job.transfer_id == transfer_id then
			result.in_progress = true
			break
		end
	end

	return result
end

return get_transfer_outcome
