# Operator Runbook — degraded persistence recovery

Two on-disk stores can become unreadable (partial write, disk fault, hand-editing). Since the
persistence hardening (PR #81), the plugin **never overwrites a file it could not read** — corruption
is a visible, recoverable outage instead of silent data destruction. This runbook covers both scenarios.

**The one rule: never delete the damaged file.** Back it up, repair it or move it aside, restart.
Deleting it does by hand exactly what the old bug did automatically.

## Scenario 1 — Stored exports (`exports.json`, controller database dir)

**Symptoms**
- Web UI Exports tab is unexpectedly empty.
- Controller log contains: `Stored exports could not be loaded from <path>: <error>` (at startup) and,
  on any later save attempt, `Refusing to persist stored exports to <path>: the startup load failed …`.

**What is and isn't lost**
- Nothing on disk is lost: the file is preserved byte-for-byte; persistence is disabled for the session
  (a latched degraded mode, `storageLoadError` in `controller.ts`).
- At risk: stored exports **created during the degraded session** — they will NOT survive a restart.
  Exports are reproducible (re-run the export); the old payloads on disk are not — which is why the
  trade goes this way.

**Recovery**
1. Stop the controller.
2. Back up the file (the log line names the exact path).
3. Repair it (it is a JSON array of stored-export records — often a truncated tail from a partial
   write) **or** move it aside to start fresh, accepting the loss of its contents.
4. Restart the controller. A successful load clears degraded mode; the Exports tab repopulates.

## Scenario 2 — Transaction history (`transactions.json`)

**Symptoms**
- Transaction Logs tab appears empty (or a completed transfer never appears in it).
- Controller log contains: `Failed to load transaction history from <path>: <error>` (at load) and/or
  `Transaction history file <path> is unreadable (<error>); skipping this write …` (on a write attempt).

**What is and isn't lost**
- The on-disk history is preserved; every write against an unreadable file is skipped (the write path
  re-reads the file first, so it can never truncate history it could not read).
- At risk: transaction records for operations completed while the file is unreadable — including the
  validation verdicts that serve as transfer forensics. The in-game transaction dashboard
  (`/transaction-dashboard`) and any banked failure black boxes (`script-output/failure_black_box_*.json`)
  are independent stores and remain available.

**Recovery**
Same four steps as Scenario 1 (the path is in the log line). No restart is strictly required for the
write path to recover — it retries the read on every persist — but a restart is needed to reload the
history into the UI.

## Verifying health after recovery
- Log shows `Loaded <n> stored platforms from disk` / `Loaded <n> transaction logs` with no errors.
- Exports and Transaction Logs tabs populate.
- No `Refusing to persist` lines after the next export/transfer completes.

Related: [metrics-cookbook.md](metrics-cookbook.md) for alerting on failure rates;
docs/superpowers/plans/2026-07-11-hardening-campaign-plan.md W3.1 tracks the planned in-UI degraded
banner (today these conditions are log-visible only).
