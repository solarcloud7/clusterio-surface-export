local Util = require("modules/surface_export/utils/util")

local GatewayConfigStaging = {}

GatewayConfigStaging.MAX_TOTAL_CHUNKS = 64
GatewayConfigStaging.STAGING_MAX_AGE_TICKS = 3600

function GatewayConfigStaging.prune()
	local staging = storage.surface_export_gateway_staging
	if staging and game.tick - (staging.started_tick or 0) > GatewayConfigStaging.STAGING_MAX_AGE_TICKS then
		log(string.format("[GatewayConfigStaging] pruned stale staging (token=%s, %d/%d chunks, age %d ticks)",
			tostring(staging.token), staging.received_count or 0, staging.total_chunks or 0,
			game.tick - (staging.started_tick or 0)))
		storage.surface_export_gateway_staging = nil
	end
end

function GatewayConfigStaging.begin(token, total_chunks, checksum)
	GatewayConfigStaging.prune()
	if type(token) ~= "string" or token == "" then
		error("gateway staging begin: token required")
	end
	total_chunks = tonumber(total_chunks)
	if not total_chunks or total_chunks % 1 ~= 0 or total_chunks < 1
		or total_chunks > GatewayConfigStaging.MAX_TOTAL_CHUNKS then
		error(string.format("gateway staging begin: total_chunks must be an integer in [1,%d]",
			GatewayConfigStaging.MAX_TOTAL_CHUNKS))
	end
	if type(checksum) ~= "string" or checksum == "" then
		error("gateway staging begin: checksum required")
	end
	local prior = storage.surface_export_gateway_staging
	if prior then
		log(string.format("[GatewayConfigStaging] superseding staging token=%s (%d/%d chunks) with token=%s",
			tostring(prior.token), prior.received_count or 0, prior.total_chunks or 0, token))
	end
	storage.surface_export_gateway_staging = {
		token = token,
		total_chunks = total_chunks,
		checksum = checksum,
		parts = {},
		received_count = 0,
		started_tick = game.tick,
	}
end

local function checked_staging(token, what)
	GatewayConfigStaging.prune()
	local staging = storage.surface_export_gateway_staging
	if not staging then
		error("gateway staging " .. what .. ": no staging in progress (call configure_gateways_begin first)")
	end
	if staging.token ~= token then
		error("gateway staging " .. what .. ": superseded by a newer begin")
	end
	return staging
end

function GatewayConfigStaging.add_chunk(token, index, part)
	local staging = checked_staging(token, "chunk")
	index = tonumber(index)
	if not index or index % 1 ~= 0 or index < 1 or index > staging.total_chunks then
		error(string.format("gateway staging chunk: index must be an integer in [1,%d]",
			staging.total_chunks))
	end
	if staging.parts[index] ~= nil then
		error(string.format("gateway staging chunk: index %d already received", index))
	end
	if type(part) ~= "string" or part == "" then
		error("gateway staging chunk: part must be a non-empty string")
	end
	staging.parts[index] = part
	staging.received_count = staging.received_count + 1
	return staging.received_count
end

function GatewayConfigStaging.take(token)
	local staging = checked_staging(token, "commit")
	storage.surface_export_gateway_staging = nil
	if staging.received_count ~= staging.total_chunks then
		error(string.format("gateway staging commit: incomplete — got %d/%d chunks",
			staging.received_count, staging.total_chunks))
	end
	local parts = {}
	for i = 1, staging.total_chunks do parts[i] = staging.parts[i] end
	local assembled = table.concat(parts)
	local actual = Util.simple_checksum(assembled)
	if actual ~= staging.checksum then
		error(string.format("gateway staging commit: checksum mismatch — got %s, expected %s",
			actual, staging.checksum))
	end
	return assembled
end

return GatewayConfigStaging
