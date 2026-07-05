-- FactorioSurfaceExport - Transfer-lock expiry self-test (remote)
-- Pure storage-level checks for SurfaceLock.scan_transfer_expiries.

local SurfaceLock = require("modules/surface_export/utils/surface-lock")

--- Run transfer-lock expiry self-test.
--- @return table { passed, failed, total, details = { {name, ok, msg}, ... } }
local function transfer_lock_selftest()
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

	local old_locks = storage.locked_platforms
	local old_unlock = SurfaceLock.unlock_platform
	local unlocks = {}

	-- pcall:allow selftest must restore SurfaceLock/storage before reporting the exception
	local ok, err = pcall(function()
		storage.locked_platforms = {
			[1] = {
				kind = "transfer",
				platform_name = "expired",
				platform_index = 1,
				force_name = "player",
				locked_tick = game.tick - 120,
				expires_tick = game.tick - 1,
			},
			[2] = {
				platform_name = "manual",
				platform_index = 2,
				force_name = "player",
				locked_tick = game.tick - 999999,
			},
			[3] = {
				kind = "transfer",
				platform_name = "old-save",
				platform_index = 3,
				force_name = "player",
			},
			[4] = {
				kind = "transfer",
				platform_name = "fallback",
				platform_index = 4,
				force_name = "player",
				locked_tick = game.tick - SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS - 1,
			},
			[5] = {
				kind = "transfer",
				platform_name = "fresh",
				platform_index = 5,
				force_name = "player",
				locked_tick = game.tick,
				expires_tick = game.tick + SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS,
			},
			[6] = {
				kind = "export",
				platform_name = "expired-export",
				platform_index = 6,
				force_name = "player",
				locked_tick = game.tick - 120,
				expires_tick = game.tick - 1,
			},
		}

		SurfaceLock.unlock_platform = function(platform_index, expected_name)
			unlocks[#unlocks + 1] = { index = platform_index, name = expected_name }
			storage.locked_platforms[platform_index] = nil
			return true, nil
		end

		local summary = SurfaceLock.scan_transfer_expiries()

		check("expired_transfer_unlocked", storage.locked_platforms[1] == nil,
			"expired transfer lock should be removed")
		check("manual_lock_untouched", storage.locked_platforms[2] ~= nil,
			"manual lock without kind must not be touched")
		check("old_save_without_locked_tick_skipped", storage.locked_platforms[3] ~= nil,
			"old-save transfer lock without locked_tick must be skipped")
		check("fallback_ttl_unlocked", storage.locked_platforms[4] == nil,
			"missing expires_tick should fall back to locked_tick + DEFAULT_TRANSFER_LOCK_TTL_TICKS")
		check("fresh_transfer_untouched", storage.locked_platforms[5] ~= nil,
			"fresh transfer lock must not be touched")
		local unlocked_names = {}
		for _, unlock in pairs(unlocks) do
			unlocked_names[unlock.name] = true
		end
		check("unlock_uses_name_tripwire",
			#unlocks == 3 and unlocked_names.expired and unlocked_names.fallback and unlocked_names["expired-export"],
			"expired unlocks must pass the stored platform_name tripwire (order-independent: the set {expired, fallback, expired-export})")
		check("summary_counts",
			summary.checked == 5 and summary.expired == 3 and summary.skipped == 1 and summary.failed == 0,
			"unexpected summary: checked=" .. tostring(summary.checked) ..
				" expired=" .. tostring(summary.expired) .. " skipped=" .. tostring(summary.skipped) ..
				" failed=" .. tostring(summary.failed))
		check("ttl_exceeds_worst_case_transfer_duration",
			SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS >= SurfaceLock.MIN_WORST_CASE_TRANSFER_TTL_TICKS,
			"TTL must exceed the worst-case total transfer duration, not only validation timeout")
	end)

	SurfaceLock.unlock_platform = old_unlock
	storage.locked_platforms = old_locks

	if not ok then
		failed = failed + 1
		details[#details + 1] = { name = "selftest_exception", ok = false, msg = tostring(err) }
	end

-- Pitfall #31 — the source-delete identity gate keys on surface.index, NEVER platform.name. Exercise the pure
	-- SurfaceLock.transfer_delete_identity_ok directly (no storage/game state needed).
	local function fake_surface(index, valid) return { index = index, valid = valid ~= false } end
	check("delete_identity_same_surface_ok",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7 }, fake_surface(7)) == true,
		"a locked transfer whose surface.index still matches must be deletable")
	check("delete_identity_ignores_rename",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7, platform_name = "OLD" }, fake_surface(7)) == true,
		"a RENAMED source (same surface.index, different name) must STILL delete — closes the rename dup exploit")
	check("delete_identity_refuses_released",
		SurfaceLock.transfer_delete_identity_ok(nil, fake_surface(7)) == false,
		"a released/absent lock (TTL/admin unlocked) must REFUSE the delete — the source is live")
	check("delete_identity_refuses_non_transfer_lock",
		SurfaceLock.transfer_delete_identity_ok({ surface_index = 7 }, fake_surface(7)) == false,
		"a non-transfer (kind-less) lock must REFUSE the transfer delete")
	check("delete_identity_refuses_reused_index",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7 }, fake_surface(9)) == false,
		"a DIFFERENT surface.index at the index (reuse) must REFUSE the delete")
	check("delete_identity_refuses_invalid_surface",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7 }, fake_surface(7, false)) == false,
		"an invalid current surface must REFUSE the delete")
	-- Request-vs-lock correlation (re-audit P1): the request's job id (== exportId) must match the lock's
	-- transfer_job_id, else a stale/reused-index delete would tear down a DIFFERENT in-flight transfer.
	check("delete_identity_job_id_match_ok",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7, transfer_job_id = "job_A" }, fake_surface(7), "job_A") == true,
		"a matching job_id (same transfer) must be deletable")
	check("delete_identity_refuses_job_id_mismatch",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7, transfer_job_id = "job_B" }, fake_surface(7), "job_A") == false,
		"a DIFFERENT transfer's lock (job_id mismatch) must REFUSE even when surface.index matches — the stale/reused-index delete (P1)")
	check("delete_identity_degrades_without_lock_job_id",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7 }, fake_surface(7), "job_A") == true,
		"an old-save lock with no transfer_job_id degrades to the surface.index check (no correlation available)")

	-- re-audit P1 (both PR reviews): the SAME-transfer backfill in lock_platform must only upgrade the SAME
	-- transfer (existing token unset or equal); a DIFFERENT/second transfer must be REJECTED so it can't
	-- overwrite the first transfer's correlation token → a live-source + committed-dest dup. Universal — covers
	-- the in-game trigger AND the web/ctl export_platform route (both lock through lock_platform).
	check("lock_upgrade_same_handoff_ok",
		SurfaceLock.is_same_transfer_upgrade(nil, "job_A") == true,
		"the transfer-trigger→export-pipeline handoff (existing token unset) may upgrade")
	check("lock_upgrade_idempotent_ok",
		SurfaceLock.is_same_transfer_upgrade("job_A", "job_A") == true,
		"an idempotent re-lock of the SAME transfer (equal token) may upgrade")
	check("lock_upgrade_refuses_second_transfer",
		SurfaceLock.is_same_transfer_upgrade("job_A", "job_B") == false,
		"a SECOND transfer (different job_id) must be REJECTED — must not overwrite the first transfer's token (P1)")
	check("lock_upgrade_refuses_tokenless_second_lock",
		SurfaceLock.is_same_transfer_upgrade("job_A", nil) == false,
		"a token-less lock attempt on an already-tokened transfer (the in-game 2nd trigger) must be REJECTED")

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return transfer_lock_selftest
