local SurfaceLock = require("modules/surface_export/utils/surface-lock")

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
	local old_unlock = SurfaceLock.unlock_current_lock
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
			[7] = {
				kind = "transfer",
				phase = SurfaceLock.SOURCE_TRANSFER_PHASE_COMMITTED,
				platform_name = "committed",
				platform_index = 7,
				force_name = "player",
				locked_tick = game.tick - SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS - 1,
				expires_tick = game.tick - 1,
			},
		}

		SurfaceLock.unlock_current_lock = function(platform_index, observed_lock)
			unlocks[#unlocks + 1] = { index = platform_index, lock = observed_lock }
			storage.locked_platforms[platform_index] = nil
			return true, nil
		end

		local summary = SurfaceLock.scan_transfer_expiries()

		check("expired_transfer_retained", storage.locked_platforms[1] ~= nil,
			"elapsed ticks cannot release unresolved transfer ownership")
		check("manual_lock_untouched", storage.locked_platforms[2] ~= nil,
			"manual lock without kind must not be touched")
		check("old_save_without_locked_tick_skipped", storage.locked_platforms[3] ~= nil,
			"old-save transfer lock without locked_tick must be skipped")
		check("transfer_without_expiry_retained", storage.locked_platforms[4] ~= nil,
			"missing expiry cannot authorize transfer source release")
		check("fresh_transfer_untouched", storage.locked_platforms[5] ~= nil,
			"fresh transfer lock must not be touched")
		check("committed_ttl_retained", storage.locked_platforms[7] ~= nil,
			"committed transfer locks must survive TTL expiry and remain non-live tombstones")
		check("unlock_uses_observed_lock",
			#unlocks == 1 and unlocks[1].index == 6 and unlocks[1].lock.platform_name == "expired-export",
			"only the orphaned standalone export may expire using its observed lock")
		check("summary_counts",
			summary.checked == 6 and summary.expired == 1 and summary.skipped == 5 and summary.failed == 0 and summary.committed == 1,
			"unexpected summary: checked=" .. tostring(summary.checked) ..
				" expired=" .. tostring(summary.expired) .. " skipped=" .. tostring(summary.skipped) ..
				" failed=" .. tostring(summary.failed) .. " committed=" .. tostring(summary.committed))
		check("orphan_export_default_exceeds_legacy_floor",
			SurfaceLock.DEFAULT_TRANSFER_LOCK_TTL_TICKS >= SurfaceLock.MIN_WORST_CASE_TRANSFER_TTL_TICKS,
			"legacy orphan-export expiry floor changed")
	end)

	SurfaceLock.unlock_current_lock = old_unlock
	storage.locked_platforms = old_locks

	if not ok then
		failed = failed + 1
		details[#details + 1] = { name = "selftest_exception", ok = false, msg = tostring(err) }
	end

	local function fake_surface(index, valid) return { index = index, valid = valid ~= false } end
	check("delete_identity_refuses_index_only",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7 }, fake_surface(7)) == false,
		"an index alone cannot authorize deletion")
	check("delete_identity_refuses_name_without_uid",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7, platform_name = "OLD" }, fake_surface(7)) == false,
		"a saved display name cannot replace missing copy and job identity")
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
	check("delete_identity_refuses_missing_uid",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7, transfer_job_id = "job_A" }, fake_surface(7), "job_A") == false,
		"job identity cannot replace missing platform UID")
	check("delete_identity_refuses_job_id_mismatch",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7, transfer_job_id = "job_B" }, fake_surface(7), "job_A") == false,
		"a DIFFERENT transfer's lock (job_id mismatch) must REFUSE even when surface.index matches — the stale/reused-index delete (P1)")
	check("delete_identity_refuses_missing_job_id",
		SurfaceLock.transfer_delete_identity_ok({ kind = "transfer", surface_index = 7 }, fake_surface(7), "job_A") == false,
		"a lock without its owning job must refuse deletion")

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

	local old_locks_for_commit = storage.locked_platforms
	local old_tombstones = storage.committed_source_transfer_tombstones
	storage.locked_platforms = {
		[9] = { kind = "transfer", phase = SurfaceLock.SOURCE_TRANSFER_PHASE_COMMITTED, platform_name = "committed-unlock", platform_index = 9, force_name = "player" },
	}
	local unlock_ok = SurfaceLock.unlock_platform(9)
	check("committed_unlock_refused",
		unlock_ok == false and storage.locked_platforms[9] ~= nil,
		"normal unlock must refuse and retain committed transfer locks")
	check("legacy_phase_is_pre_commit",
		SurfaceLock.source_lock_phase({ kind = "transfer" }) == SurfaceLock.SOURCE_TRANSFER_PHASE_PRE_COMMIT,
		"phase-less legacy transfer locks must normalize to pre_commit")
	storage.locked_platforms[10] = { kind = "transfer", platform_name = "lock-time-name", platform_index = 10, force_name = "player", transfer_job_id = "rename-pre" }
	local renamed_pre = SurfaceLock.get_source_transfer_lock_state("rename-pre", 10, "live-renamed", "player")
	check("source_query_pre_commit_requires_uid",
		renamed_pre.state == "identity_mismatch",
		"unverified synthetic platform cannot certify pre-commit ownership")
	storage.locked_platforms[11] = { kind = "transfer", phase = SurfaceLock.SOURCE_TRANSFER_PHASE_COMMITTED, platform_name = "lock-time-name", platform_index = 11, force_name = "player", transfer_job_id = "rename-committed" }
	local renamed_committed = SurfaceLock.get_source_transfer_lock_state("rename-committed", 11, "live-renamed", "player")
	check("source_query_committed_requires_uid",
		renamed_committed.state == "identity_mismatch",
		"unverified synthetic platform cannot certify committed ownership")
	storage.committed_source_transfer_tombstones = {
		fresh = { committed_tick = game.tick },
		stale = { committed_tick = game.tick - SurfaceLock.COMMITTED_SOURCE_TOMBSTONE_RETENTION_TICKS - 1 },
		invalid = { committed_tick = "not-a-number" },
	}
	local tombstone_pruned = SurfaceLock.prune_committed_source_tombstones(game.tick)
	check("committed_tombstone_pruned",
		tombstone_pruned == 2 and storage.committed_source_transfer_tombstones.fresh ~= nil and storage.committed_source_transfer_tombstones.stale == nil and storage.committed_source_transfer_tombstones.invalid == nil,
		"committed source tombstones must be bounded, not immortal save growth")
	storage.locked_platforms = old_locks_for_commit
	storage.committed_source_transfer_tombstones = old_tombstones

	return { passed = passed, failed = failed, total = passed + failed, details = details }
end

return transfer_lock_selftest
