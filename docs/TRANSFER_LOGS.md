# Transfer history and audit evidence

The Transaction Logs tab shows searchable recent history beside the selected operation. The initial
snapshot requests 100 operations; live updates can increase the loaded set. Search covers platform,
instance names/IDs, and operation IDs within that set. Outcome and operation filters and pagination
run in the browser. Selection, detail tabs, and audit filters survive live updates. Below 1280px,
history and details stack vertically.

The persistent detail header shows the route, outcome, timestamps, elapsed duration, and downloads.
Overview presents item and fluid audit cards plus major recorded stages. Timing expands the shared
timeline into a stage/step table with start offsets, durations, measurement basis, and aligned bars.
Tick-derived measurements remain distinct from elapsed time. Sub-tick work is not called instant;
overlapping stages are not summed. Unattributed time remains visible.

## Meaning of the verdicts

- **Arrived and verified / Imported and verified:** a completed operation with explicit validation
  success and both item and fluid count gates passed.
- **Completed; audit evidence unavailable:** completion is recorded, but the evidence required to
  claim verification is absent.
- **Mismatch:** the recorded gate failed. Equal aggregate totals do not override that verdict.
- **Pending:** the operation is still active and no gate result is recorded yet.
- **Not applicable:** a standalone export has no destination audit.
- **Evidence unavailable:** a terminal operation has no retained gate result. Missing maps are not
  silently turned into zero counts. Explicit empty maps represent measured empty cargo.
- **Rollback succeeded:** requires a recorded `rollback_success` event. A failed transfer alone does
  not prove recovery. Cleanup failure requires inspecting its events; it does not imply arrival.
- **Intentional test:** shown only for explicit validation test flags.

Items and Fluids list the union of recorded source/destination keys, with quantities, differences,
search, and a differences-only filter. Keys retain quality/temperature distinctions. Raw fluid
quantities and recorded thermal aggregates are separate views; reconciliation uses the recorded
verdict, not a browser inference from similar totals. A count audit does not prove each item's full
internal state. Full precision remains available in the diagnostic report.

Technical details retain operation metrics, entity breakdown, raw validation, overflow exclusions,
force bonus comparisons, latch rearm scheduling, and the event history. A scheduled rearm does not
prove completion. Server failure-black-box paths are references, not browser download endpoints.

## Downloads and preview

Download platform retains the existing stored-export action and explains when the artifact is
unavailable. Download diagnostic report creates JSON from already authorized browser data:
`schemaVersion: 1`, export time, operation ID/summary, transfer metadata, events, retention status,
and a preview flag. Expired detail still permits a summary report. This does not extend retention.

**Preview logs** is available in the history header and gateway debug panel. It reuses the real
detail components without a live plugin reference. Success and rollback fixtures are sanitized
local runtime records captured on 2026-09-06. Missing evidence, pending, cleanup, failed-gate,
reconciliation, standalone operations, expiry, loading, and retry scenarios are constructed display
cases. Replay detail update exercises stable tabs and expansion. No platform operations or gateway
configuration writes occur.

## Verification

Run `node tests/integration/log-evidence/run-tests.mjs` after building and deploying the local web
bundle. It authenticates only to localhost and confirms the browser loaded the current manifest.
Sanitized recorded data is injected only into the test browser's read responses so the suite also
works on a freshly seeded cluster. It checks search, filters, pagination, keyboard selection,
responsive layout, audit states, raw/thermal views, reports, preview isolation, and error retry. A
delayed response test verifies that an intervening log push retains its outcome and merges with
earlier events without resetting selection, search, or page. Screenshots go to
`ci-artifacts/log-evidence/`.

The redesign was also checked against the local retained `mptransfer-mtonvmga` success and
`lab-omnibus-state-v1` rollback failure. Browser fixtures verify presentation and data handling;
they do not verify server transfer correctness. Existing timing and validation tests remain in place.
No controller schema, messages, Lua instrumentation, gate rules, or transfer behavior changed.
