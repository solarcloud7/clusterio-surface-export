-- FactorioSurfaceExport - Import Session Manager
-- Handles chunked RCON import sessions for assembling large payloads

local Util = require("modules/surface_export/utils/util")

local MAX_IMPORT_SESSIONS = 4
local MAX_SESSION_AGE_TICKS = 3600  -- ~60 seconds at 60 UPS
local MAX_TOTAL_CHUNKS = 256

local ImportSession = {}

local function prune()
	local sessions = storage.import_sessions
	if not sessions then return end

	local now = game.tick
	local keys = {}
	for key, session in pairs(sessions) do
		if (now - (session.started_tick or now)) > MAX_SESSION_AGE_TICKS then
			log(string.format("[Import Session] Pruned session '%s' (age: %d ticks, platform: %s)",
				key, now - (session.started_tick or now), tostring(session.platform_name)))
			sessions[key] = nil
		else
			table.insert(keys, key)
		end
	end

	-- Keep only newest MAX_IMPORT_SESSIONS by started_tick
	table.sort(keys, function(a, b)
		local sa = sessions[a]
		local sb = sessions[b]
		return (sa and sa.started_tick or 0) < (sb and sb.started_tick or 0)
	end)

	while #keys > MAX_IMPORT_SESSIONS do
		local oldest = table.remove(keys, 1)
		sessions[oldest] = nil
	end
end

--- Begin a chunked import session
--- @param session_id string
--- @param total_chunks number
--- @param platform_name string|nil
--- @param force_name string|nil
--- @return boolean, string|nil
function ImportSession.begin(session_id, total_chunks, platform_name, force_name)
	storage.import_sessions = storage.import_sessions or {}
	prune()

	log(string.format("[Import Session] begin_import_session: session_id=%s, total_chunks=%s, platform=%s, force=%s",
		tostring(session_id), tostring(total_chunks), tostring(platform_name), tostring(force_name)))

	if not session_id or session_id == "" then
		log("[Import Session] FAILED: session_id required")
		return false, "session_id required"
	end
	if storage.import_sessions[session_id] then
		log(string.format("[Import Session] FAILED: session '%s' already exists", session_id))
		return false, "session already exists"
	end

	if not total_chunks or total_chunks < 1 or total_chunks > MAX_TOTAL_CHUNKS then
		return false, "invalid total_chunks"
	end

	local active = 0
	for _ in pairs(storage.import_sessions) do
		active = active + 1
	end
	if active >= MAX_IMPORT_SESSIONS then
		return false, "too many active sessions"
	end

	storage.import_sessions[session_id] = {
		total_chunks = total_chunks,
		received = {},
		received_count = 0,
		platform_name = platform_name,
		force_name = force_name,
		started_tick = game.tick
	}

	log(string.format("[Import Session] Session '%s' created: expecting %d chunks for platform '%s'",
		session_id, total_chunks, tostring(platform_name)))

	return true, nil
end

--- Enqueue a chunk into a session
--- @param session_id string
--- @param chunk_index number
--- @param chunk_data string
--- @return boolean, string|nil
function ImportSession.enqueue_chunk(session_id, chunk_index, chunk_data)
	storage.import_sessions = storage.import_sessions or {}
	prune()

	local session = storage.import_sessions[session_id]
	if not session then
		return false, "session not found"
	end

	if not chunk_index or chunk_index < 1 or chunk_index > session.total_chunks then
		return false, "invalid chunk index"
	end

	if session.received[chunk_index] then
		return false, "chunk already received"
	end

	session.received[chunk_index] = chunk_data or ""
	session.received_count = session.received_count + 1

	log(string.format("[Import Session] Chunk received: session=%s, chunk=%d/%d, size=%d bytes",
		session_id, session.received_count, session.total_chunks, #(chunk_data or "")))

	return true, nil
end

--- Finalize a session, assemble payload, and queue async import
--- @param session_id string
--- @param checksum string|nil
--- @param queue_fn function: function(json_data, platform_name, force_name, requester) → job_id, err
--- @return string|nil, string|nil: job_id or nil + error
function ImportSession.finalize(session_id, checksum, queue_fn)
	storage.import_sessions = storage.import_sessions or {}
	prune()

	log(string.format("[Import Session] finalize_import_session: session_id=%s, checksum=%s",
		tostring(session_id), tostring(checksum ~= nil)))

	local session = storage.import_sessions[session_id]
	if not session then
		log(string.format("[Import Session] FAILED: session '%s' not found (may have been pruned)", tostring(session_id)))
		return nil, "session not found"
	end

	if session.received_count ~= session.total_chunks then
		log(string.format("[Import Session] FAILED: session '%s' incomplete - received %d/%d chunks",
			session_id, session.received_count, session.total_chunks))
		return nil, "incomplete session"
	end

	local ordered = {}
	for i = 1, session.total_chunks do
		local chunk = session.received[i]
		if not chunk then
			storage.import_sessions[session_id] = nil
			return nil, "missing chunk " .. i
		end
		table.insert(ordered, chunk)
	end

	local assembled = table.concat(ordered)

	log(string.format("[Import Session] Session '%s' assembled: %d chunks -> %d bytes",
		session_id, session.total_chunks, #assembled))

	if checksum and checksum ~= Util.simple_checksum(assembled) then
		storage.import_sessions[session_id] = nil
		return nil, "checksum mismatch"
	end

	local job_id, err = queue_fn(
		assembled,
		session.platform_name,
		session.force_name or "player",
		"RCON"
	)

	storage.import_sessions[session_id] = nil

	if not job_id then
		return nil, err
	end

	return job_id, nil
end

--- Prune stale sessions (called from AsyncProcessor.process_tick)
function ImportSession.prune()
	prune()
end

return ImportSession
