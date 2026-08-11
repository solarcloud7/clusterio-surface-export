# Config survey — hardcoded operational values, classified

Classification of every hardcoded operational value in the plugin, with the rule that decides whether
each one becomes a setting. Produced 2026-08-04 as the review gate for the config-not-constants
migration; kept because the classification (and the reasoning behind each LAW entry) is worth more
than the migration it gated.

Scope swept: root `*.ts`, `lib/`, `shared/`, `web/`, `module/**/*.lua`. Excluded: tests, lint tooling,
build config.

## Status — what has shipped since this was written

| Row | Status |
|---|---|
| `VALIDATION_TIMEOUT_MS` | **SHIPPED** as `surface_export.transfer_validation_timeout_seconds`, default 30, clamped 5–120. The Lua mirror feeding the TTL floor is NOT yet migrated, so the drift warned about below is still live. |
| `max_export_cache_size` (extra finding 1) | **SHIPPED** — field wired end to end and the instance-side cache bounded. |
| store-wait timeout, "one field or two?" | **DECIDED**: one field, default 60 s. Not yet implemented. |
| `title` on config fields — "UNVERIFIED" below | **VERIFIED**: `title` renders correctly. Three fields now ship one (`max_storage_size`, `transaction_log_detail_entries`, `transfer_validation_timeout_seconds`); the warning below is obsolete. |
| Extra finding 2 (stubbed success literal) | **STILL OPEN.** |

Two controller fields were added after this survey and are not in the tables below:
`surface_export.transaction_log_detail_entries` (detail-retention window) and the title/description
on `surface_export.max_storage_size`.

## OWNER RULINGS 2026-08-04

1. **Store-wait timeout → ONE field, default 60 s.** Both call sites wait for the same event; the
   10 s transfer-path value is the anomaly, not the 60 s one (it sits where payloads are largest).
   Raising a timeout cannot break a working transfer — it only changes how long a broken one takes
   to report. `transfer-orchestrator.ts:31` default and the `controller.ts:426` override both go.
2. **`max_export_cache_size` (dead field + unbounded cache) → its own PR, BEFORE D.** It is a
   behavior fix, not a migration; keeping it out of D preserves the commit label as an audit boundary.
3. **D splits in two PRs: controller fields first, instance→Lua second.** The instance→Lua half
   carries the four-place silent-drop pitfall and each field must be proven live end to end.
4. **Transfer-lock TTL → restart-required, clamped.** Owner asked whether a Factorio mod setting
   requiring a restart would do. Restart-required semantics: YES, adopted. Mod setting as the
   MECHANISM: NO — see the row's note below for the three reasons. It becomes an instance config
   field read once at instance start (so changing it needs a restart, as asked), clamped in Lua
   against the derived floor.

## The classification rule

> **If changing the value can flip a transfer's verdict from FAIL to PASS, it is LAW** — tuning it is
> tuning away data-loss detection, not tuning performance. Wire-schema bounds and values derived from
> an engine hard limit are also LAW. TTLs, caps, retention windows and timeouts are TUNABLE. Values
> with no operator-meaningful effect (log cadence, UI page size, diagnostic sample depth) are INTERNAL.

Side markers: **(controller)** = plain controller config field · **(instance-Node)** = instance field read in Node, never reaches Lua · **(instance→Lua)** = must be wired in FOUR places (see pitfall section) or it silently drops.

## TUNABLE — migrate to settings (defaults = today's values)

| value | default | file:line | proposed field | title | failure behavior |
|---|---|---|---|---|---|
| `VALIDATION_TIMEOUT_MS` *(migrating in Workstream C)* | 120 000 | helpers.ts:14 | `surface_export.validation_timeout_ms` (controller) | Transfer validation timeout | No verdict within the window → transfer force-failed, destination discarded, source rolled back; a slow-but-healthy import is treated as a failure. **Mirrored in Lua** as `VALIDATION_TIMEOUT_TICKS` (surface-lock.lua:14) feeding the TTL floor — migrate both or they drift. |
| `DEFAULT_TRANSFER_LOCK_TTL_TICKS` | 36 000 | surface-lock.lua:10 | `surface_export.transfer_lock_ttl_ticks` (instance→Lua, read once at start) | Source transfer-lock TTL (ticks) | Locked source auto-unlocks after this; too low → a still-in-flight transfer unlocks the source while the destination copy exists (duplication). **Documented floor**: `MIN_WORST_CASE_TRANSFER_TTL_TICKS = 19200` with a selftest asserting `DEFAULT >= MIN` — the migration must keep that check AND clamp the live value to it. |

**Why NOT a Factorio mod setting** (ruling 4 — the mechanism, not the restart requirement):
1. **The only mod is `surfexp_gateways`, and it is gateway-scoped** (`info.json`: pure data-stage,
   no control.lua). The transfer-lock TTL governs every transfer including non-gateway ones; hanging
   a core-transfer knob off the gateway mod couples them for no reason.
2. **An absent mod fails silently — the exact class D exists to kill.** A save without
   `surfexp_gateways` reads `settings.startup[...]` as nil and falls back to the constant, so the
   setting silently does nothing. That is the `configure.lua` allowlist pitfall wearing a different hat.
3. **The engine-enforced `minimum_value` cannot express THIS floor.** `MIN_WORST_CASE_TRANSFER_TTL_TICKS`
   is DERIVED (surface-lock.lua:19-24) and one component is the validation-timeout budget, which is
   itself now an operator-settable controller field. A static prototype minimum cannot track it.
   Splitting the two knobs across two config systems makes the already-unenforced link
   (surface-lock.lua:16-18 confesses it: "nothing enforces that link") harder to close, not easier.

Restart-required is kept — an instance config field read once at start gives exactly that, with no
mod dependency and no second settings surface for operators to discover.

> **CARRIED FORWARD, not solved here:** raising the validation timeout past the 120 s budget should
> raise this TTL too, and nothing enforces it across the controller/instance boundary. The migration
> should at minimum make the violation *loud* (log at arm time when the budget exceeds the headroom);
> a real cross-boundary clamp needs the timeout value pushed to the instance and is its own design.
| `COMMITTED_SOURCE_TOMBSTONE_RETENTION_TICKS` | 39 000 (derived) | surface-lock.lua:24 | *no new field* — stays derived from the TTL | — | Do NOT add a second knob; it is `TTL + WORST_CASE_MARGIN`. |
| `PENDING_TRANSFER_INTENT_RETENTION_MS` | 900 000 | controller.ts:39 | `surface_export.pending_transfer_intent_retention_ms` (controller) | Pending transfer intent retention | Older intents dropped at boot-reconcile → a transfer in flight across a controller restart loses its only observability record. |
| `SOURCE_COMMIT_MARKER_RETENTION_MS` | 2× above | controller.ts:40 | *no new field* — derived | — | Same treatment as the tombstone row. |
| activeTransfers prune cap | 100 (×2!) | transfer-orchestrator.ts:563,:566 | `surface_export.max_active_transfer_records` (controller) | In-memory transfer records kept | Evicted transfer IDs no longer block same-ID retries and vanish from the `active` half of `list-transfers` (a documented known hole). |
| `JobResults.prune(25)` | 25 (×3 call sites) | export-pipeline.lua:712,:818; import-completion.lua:953 | `surface_export.max_async_job_results` (instance→Lua) | Async job results retained | Older results evicted → a late poll returns "not found" and the caller must re-run. All three sites must change together. |
| TransactionHistory `max_entries` | 100 | transaction-history.lua:18 | `surface_export.transaction_history_max_entries` (instance→Lua) | In-game transaction history entries | Oldest dashboard entries drop irrecoverably. **Pitfall**: written into `storage` only when absent — an existing save needs a migration to pick up a change. |
| `MAX_IMPORT_SESSIONS` | 4 | import-session.lua:6 | `surface_export.max_import_sessions` (instance→Lua) | Concurrent chunked-import sessions | A 5th session evicts the oldest mid-assembly; its remaining chunks land in a dead session and that import silently dead-ends. |
| `MAX_SESSION_AGE_TICKS` | 3600 | import-session.lua:7 | `surface_export.import_session_max_age_ticks` (instance→Lua) | Chunked-import session TTL (ticks) | A slow chunk stream loses its partial payload and the import fails. |
| `MAX_TOTAL_CHUNKS` | 256 | import-session.lua:8 | `surface_export.import_max_total_chunks` (instance→Lua) | Max chunks per import session | Larger payloads rejected outright (~25 MB cap at current chunk size). Coupled to chunk size. |
| `RCON_CHUNK_SIZE` | 100 000 (×2!) | helpers.ts:11 AND :167 default param | `surface_export.rcon_chunk_size` (instance-Node) | RCON payload chunk size (bytes) | Too large → mid-send failure aborts the import (rollback); smaller only costs round trips. Both sites together — the :167 default currently shadows the constant. |
| `EXPORT_POLL_TIMEOUT_MS` | 30 000 | helpers.ts:12 | `surface_export.export_poll_timeout_ms` (instance-Node) | Export data poll timeout | The instance gives up and fails the export even though the Lua job may still complete. |
| `EXPORT_POLL_INTERVAL_MS` | 500 | helpers.ts:13 | `surface_export.export_poll_interval_ms` (instance-Node) | Export data poll interval | Larger adds latency; smaller adds RCON load. |
| `waitForStoredExport` timeout | 10 000 / **60 000 override!** | transfer-orchestrator.ts:31 / controller.ts:426 | `surface_export.await_stored_export_timeout_ms` (controller) | Controller store-wait timeout | "Timed out waiting for export" and no transfer starts. **DECIDED: ONE field, default 60 s** — both call sites wait for the same event, and raising a timeout cannot break a working transfer, only change how long a broken one takes to report. |
| web log-list fetch depth | 100 | web/index.tsx:261 | `surface_export.web_log_page_size` (controller) | Web UI transaction-log fetch size | Older transfers invisible in the web UI with no indication; bounded by the wire max 500. |
| `RateLimiter maxRate` | 2 | subscription-manager.ts:25 | `surface_export.tree_broadcast_max_rate` (controller) | Web UI tree broadcast rate limit (/s) | Bursts coalesce; the platform tree lags reality by up to 1/rate seconds. |
| ~~`PATIENCE_TICKS`~~ | ~~1800~~ | DELETED 2026-08-11 | — (the proposed `latch_rearm_patience_ticks` was never implemented and is withdrawn) | Was: latch re-arm patience for paused platforms | The pause-rung measured combinators evaluating on paused platforms at 2.1.11 — the wait guarded nothing and gateway-parked transfers now re-arm; there is no constant left to make configurable. |

## LAW — deliberately NOT knobs (each with the reason)

| value | where | why it is law |
|---|---|---|
| `EXACT_EPSILON` 1e-6 | census-accumulator.lua:43; transfer-validation.lua:13 | The gate's definition of "exact"; widening forgives real loss (verdict-flipping). |
| `LOSS_TOLERANCE_PCT/ABS` 0.05/25 | loss-analysis.lua:15-16 | High-temp reconciliation forgiveness — verdict-flipping. |
| `STORAGE_TOLERANCE`/`TOTAL_LOSS_TOLERANCE`/`MIN_ABSOLUTE_LOSS` 5/0.95/100 | transfer-validation.lua:215-217 | Loose-path verdict thresholds (already bypassed on the strict transfer path). |
| `HIGH_TEMP_THRESHOLD` 10000 | game-utils.lua:105 + util.lua:27 + **3 web mirrors** | Partitions fluids into the reconciliation bucket — verdict-flipping; four sites must agree or the UI disagrees with the gate. |
| web fluid-delta epsilons 0.0001 | web/utils.ts ×6; TransactionLogsTab.tsx:451 | Display must mirror the gate epsilon or the UI labels a gate-failing delta "Match". |
| `TICKS_TO_MS` 16.67 | helpers.ts:10 + phase-recorder.lua:153-154 | Baked into the metrics wire format; changing it rescales all history. |
| `MAX_RCON_COMMAND_BYTES` 7000 (×2) | lua-interface.ts:69,:94 | Derived from Factorio's ~8 KB RCON hard limit; raising converts a loud throw into silent truncation. |
| Prometheus buckets | metrics.ts:50 | Changing invalidates every recorded series (the file documents a prior series break). |
| `GATEWAY_COUNT`/`GATEWAY_PREFIX` | shared/dto.ts:8-9 | Hand-mirror of the data mod's prototypes; solo change yields gateways with no prototypes. |
| list-transfers max 500 (+default 50 ×4 sites) | messages.ts:329,336; control.ts:50,57-59 | Wire-schema bound both ends must agree on. Duplication flagged. |
| `%03d` job-id format, `:` canonical-id separator, `STORAGE_FILENAME`, JSON byte constants | various | Wire/persisted identity — changing breaks every existing id/file. |
| latch re-arm tick spacings 2/2/2 | latch_rearm.lua:45-47 | Engine evaluation-order requirements; correctness, not speed. |

## INTERNAL — left alone (samples; full list in the migration PR)

Lock-expiry scan cadence (60 ticks — 0.17 % of the TTL it polices) · log cadences · sync-mode
sentinel 1000000 · overflow-entity sample cap 50 (the gate never reads `.entities`; documented as a
sample) · latch `MAX_KEPT_RESULTS` 8 · name-sanitizer truncation 200 · selftest preview lengths ·
`PROPERTY_MAX_DEPTH` 8 · dashboard scan depth 200 (no-op until history cap > 200 — coupling noted) ·
Ant Design pageSizes · poll granularities (100 ms / 500 ms waits) · selection-lab GUI constants ·
test-hook magnitudes · fixture geometry.

## The four-place wiring pattern for instance→Lua fields (`debug_mode` is the template)

1. `index.ts` `instanceConfigFields` declaration.
2. `instance.ts` — read via `this.cfg(...)`, pass into `this.lua.configure({...})`.
3. `lib/lua-interface.ts` `configure()` — add to the interface AND the hand-built Lua table string
   (**the actual drop point**: no generic conversion; a field missing from the string vanishes silently).
4. `module/interfaces/remote/configure.lua` — the matching `if config.x ~= nil then` branch.

`title` on config fields is VERIFIED and in use — see `max_storage_size`,
`transaction_log_detail_entries` and `transfer_validation_timeout_seconds` in `index.ts`. (This
paragraph previously warned it was unverified.)

## Extra findings the survey turned up (not config, but real)

1. **`surface_export.max_export_cache_size` is a DEAD config field — and the cache it names is
   unbounded.** Declared (initialValue 10), validated at instance.ts:972-975, then discarded: never
   pushed to Lua, never enforced. `clear-old-exports.lua:8` has its own hardcoded `keep_count or 10`
   not wired to it, and `clear_old_exports` is never called by the Node plugin. The instance-side
   export cache grows without bound in normal operation.
2. **A stubbed verification that always reports success**: instance.ts:633-640 waits 500 ms "to
   verify the import was queued", then runs `sendRcon("/sc rcon.print('{\"success\":true}')")` — a
   hardcoded literal reporting success regardless of actual queue state. Correctness gap, not config.
3. The "~100 entities/tick batch size" figure from planning does not exist — the real constant is
   `batch_size = 50` and it is ALREADY configurable. Already-configured boundary: `batch_size`,
   `max_concurrent_jobs`, `show_progress`, `debug_mode`, `max_export_cache_size` (dead), `max_storage_size`.
4. Duplicate-constant pairs the migration must fix together: RCON_CHUNK_SIZE ×2 ·
   MAX_RCON_COMMAND_BYTES ×2 · VALIDATION_TIMEOUT ms↔ticks · HIGH_TEMP_THRESHOLD ×5 · TICKS_TO_MS ×2 ·
   JobResults.prune ×3 · limit 500/50 ×4 · EXACT_EPSILON ×2 · activeTransfers cap ×2 · store-wait 10s/60s.
