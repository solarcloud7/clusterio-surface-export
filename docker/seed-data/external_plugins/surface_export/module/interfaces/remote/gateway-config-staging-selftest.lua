local GatewayConfigStaging = require("modules/surface_export/core/gateway-config-staging")
local configure_gateways = require("modules/surface_export/interfaces/remote/configure-gateways")
local Util = require("modules/surface_export/utils/util")

local function gateway_config_staging_selftest()
	local details = {}
	local passed, failed = 0, 0

	local function check(name, cond, msg)
		if cond then
			passed = passed + 1
			details[#details + 1] = { name = name, ok = true }
		else
			failed = failed + 1
			details[#details + 1] = { name = name, ok = false, msg = msg or "assertion failed" }
		end
	end

	local cfg = storage.surface_export_config or {}
	local saved_gateways = cfg.gateways
	local saved_staging = storage.surface_export_gateway_staging
	storage.surface_export_gateway_staging = nil

	-- intentional probe; failure expected (surfaced via selftest details), no log
	local ok_all, run_err = pcall(function()
		local payload = '{"surfexp_gateway_1":{"targets":[]},"surfexp_gateway_2":{"targets":[]}}'
		local third = math.ceil(#payload / 3)
		local parts = {
			payload:sub(1, third),
			payload:sub(third + 1, 2 * third),
			payload:sub(2 * third + 1),
		}
		local checksum = Util.simple_checksum(payload)

		GatewayConfigStaging.begin("tok-a", 3, checksum)
		GatewayConfigStaging.add_chunk("tok-a", 2, parts[2])
		GatewayConfigStaging.add_chunk("tok-a", 1, parts[1])
		local received = GatewayConfigStaging.add_chunk("tok-a", 3, parts[3])
		check("chunks_are_index_keyed_so_out_of_order_arrival_assembles", received == 3,
			"received=" .. tostring(received))
		local assembled = GatewayConfigStaging.take("tok-a")
		check("commit_assembles_by_index_and_verifies_the_checksum", assembled == payload,
			"assembled bytes differ from the original payload")
		check("commit_clears_the_slot", storage.surface_export_gateway_staging == nil,
			"a committed staging must not leave residue")

		local result = configure_gateways.configure_gateways(payload)
		check("single_shot_apply_echoes_count_and_bytes",
			result.ok == true and result.gateways == 2 and result.bytes == #payload,
			"got " .. tostring(result.gateways) .. " gateways, " .. tostring(result.bytes) .. " bytes")
		check("apply_reaches_storage",
			storage.surface_export_config.gateways ~= nil
				and storage.surface_export_config.gateways["surfexp_gateway_1"] ~= nil,
			"configure did not store the decoded gateway table")

		GatewayConfigStaging.begin("tok-b", 2, checksum)
		GatewayConfigStaging.add_chunk("tok-b", 1, parts[1])
		-- intentional probe; failure expected (the refusal text is asserted), no log
		local dup_ok, dup_err = pcall(GatewayConfigStaging.add_chunk, "tok-b", 1, parts[1])
		check("duplicate_index_is_refused", dup_ok == false and tostring(dup_err):find("already received", 1, true) ~= nil,
			tostring(dup_err))
		-- intentional probe; failure expected (the refusal text is asserted), no log
		local range_ok, range_err = pcall(GatewayConfigStaging.add_chunk, "tok-b", 9, parts[1])
		check("out_of_range_index_is_refused", range_ok == false and tostring(range_err):find("must be an integer", 1, true) ~= nil,
			tostring(range_err))
		-- intentional probe; failure expected (the refusal text is asserted), no log
		local early_ok, early_err = pcall(GatewayConfigStaging.take, "tok-b")
		check("incomplete_commit_is_refused", early_ok == false and tostring(early_err):find("incomplete", 1, true) ~= nil,
			tostring(early_err))
		check("a_refused_commit_clears_the_slot_so_no_residue_survives",
			storage.surface_export_gateway_staging == nil,
			"failure paths must not leave a partial staging behind")

		GatewayConfigStaging.begin("tok-c", 1, checksum)
		GatewayConfigStaging.begin("tok-d", 1, checksum)
		-- intentional probe; failure expected (the refusal text is asserted), no log
		local stale_ok, stale_err = pcall(GatewayConfigStaging.add_chunk, "tok-c", 1, payload)
		check("a_superseded_token_is_refused_loudly", stale_ok == false
			and tostring(stale_err):find("superseded", 1, true) ~= nil, tostring(stale_err))

		GatewayConfigStaging.add_chunk("tok-d", 1, payload .. "x")
		-- intentional probe; failure expected (the refusal text is asserted), no log
		local sum_ok, sum_err = pcall(GatewayConfigStaging.take, "tok-d")
		check("checksum_mismatch_is_refused", sum_ok == false
			and tostring(sum_err):find("checksum mismatch", 1, true) ~= nil, tostring(sum_err))

		GatewayConfigStaging.begin("tok-e", 1, checksum)
		storage.surface_export_gateway_staging.started_tick =
			game.tick - GatewayConfigStaging.STAGING_MAX_AGE_TICKS - 1
		GatewayConfigStaging.prune()
		check("a_stale_staging_is_pruned", storage.surface_export_gateway_staging == nil,
			"an abandoned staging must age out instead of blocking the slot forever")
	end)

	storage.surface_export_config = storage.surface_export_config or {}
	storage.surface_export_config.gateways = saved_gateways
	storage.surface_export_gateway_staging = saved_staging

	if not ok_all then
		failed = failed + 1
		details[#details + 1] = { name = "selftest_body_threw", ok = false, msg = tostring(run_err) }
	end

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return gateway_config_staging_selftest
