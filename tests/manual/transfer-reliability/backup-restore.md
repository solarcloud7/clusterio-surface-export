# Coordinated volume restore contract

This manually invoked Docker experiment uses the existing pinned 2.1.17 lab and
physical cargo fixture. It does not target the running development cluster.

Before implementation, the acceptance boundary is fixed as follows:

- Complete one transfer, then withhold the real successful source-deletion reply
  for a second transfer. Keep its destination held and its controller intent pending.
- Save both instances, stop both instances and all three services. No new requests
  are admitted by the harness during this interval. Verify the pending intent on disk.
- Archive every lab volume: controller data, both hosts' data, tokens, static assets,
  staged plugin and seed. Preserve metadata, hash each archive and record the exact
  volume set. Backups stay in an owned Docker volume; credentials never enter reports.
- Erase the contents of the stopped lab's original volumes and prove they are empty.
  Restore only the captured archives and compare their contents before restarting.
- Require exact physical item/quality, belt-side and fluid cargo, at most one usable
  copy at every sampled boundary, one import per canonical transfer, normal recovery
  completion, and preserved completed-transfer history. Retain raw observations for
  offline analysis. Missing observations are harness errors, not absence or zero.

Forbidden assists: changing receipts, journals, recovery timers, cargo, verdicts,
locks or holds. Disabling the owned reply-withholding hook before snapshot is allowed;
its already-held response remains unresolved. Normal recovery must perform the retry.

Bounds: existing ten-minute setup and ten-minute case limits; each storage operation
at most 60 seconds; seven archives, at most 2 GiB each. First prove cleanup after an
injected failure following archive creation. Then run one full drill; stop on a valid
invariant violation. Offline analyzer fixes do not justify another live run.

The measured backup interval begins at coordinated save initiation; restore time
begins before erasure and ends when recovery and observations complete. Report them
separately from each operation's clocks. Fixed saves, fixture, scripts, staged runtime
and image hashes identify the run. No new Factorio API surface is introduced.

Limits: planned, quiesced backup; same container definitions and same image/runtime;
loss of all owned volume contents, not loss of Docker service definitions or the host.
No crash during backup, stale mixed backup generations, destination-only rollback,
off-host archive transport, released-package compatibility or continuous tick-level
safety claim. The static volume is included even though this headless lab does not
generate graphical locale/icon assets. Lab resources are removed on pass or failure.

## Recorded result: Factorio 2.1.17, 2026-09-10

- Cleanup proof `se-manual-mtv0cgdd-a7c451ae` reached seven verified archives, then
  deliberately threw. It ended `HARNESS_ERROR` for that injection with
  `cleanup.success: true`. [Raw report](evidence/backup-cleanup-2.1.17.json).
- Full drill `se-manual-mtv0g7tf-bec67ec6` passed. All seven original volumes were
  empty before restoration; all seven restored archives passed `tar --compare`.
  Their combined size was 17,551,360 bytes. [Raw report](evidence/backup-restore-2.1.17.json).
- The uncertain transfer completed through a real source-deletion retry with one
  import. Its four physical observations preserved exact cargo and never showed
  two usable copies. The completed transfer retained its completed history, one
  import and exact destination cargo in both observations.
- The backup interval took 20.9 seconds; erasure, restoration, restart, normal
  recovery and final observations took 62.8 seconds. These are measured intervals
  for this small fixture, not recovery-time guarantees. The recovery point is the
  coordinated saved/stopped state; no concurrent user writes were exercised.
- Both runs removed every owned container, volume (including archives) and network.
  No product code, live data, timers, receipts or validation rules were changed.

Replay the successful report without Docker:

```powershell
node tests/manual/transfer-reliability/run.mjs --analyze tests/manual/transfer-reliability/evidence/backup-restore-2.1.17.json
```

This closes the quiesced, same-runtime volume-content-loss rung. Full host rebuild,
mixed backup generations, graphical assets and released-package upgrades remain
separate acceptance work. The six offline restore tests also reject incomplete
archives, unproved erasure, changed generations, cargo loss, duplicate copies,
repeated imports, missing authority/history and unsafe mutation boundaries.
