# Transfer history and audit evidence

The Transaction Logs tab shows searchable recent history beside the selected operation. The initial
snapshot requests 100 operations; live updates can increase the loaded set. Search covers platform,
instance names/IDs, and operation IDs within that set. Outcome and operation filters and pagination
run in the browser. Selection, detail tabs, and audit filters survive live updates. Revisiting a record
and reconnecting both refresh its detailed evidence to recover missed events. Below 1280px,
history and details stack vertically.

The persistent detail header shows the route, outcome, timestamps, elapsed duration, and downloads.
One outcome panel contains the failure reason and a separate recovery section. Overview and the
evidence tabs do not repeat that failure as additional alerts. Overview presents entity, item, and
fluid audit cards plus major recorded stages. The cards describe the destination attempt before
recovery; successful rollback does not change its audit verdicts.

Timing uses separate local-clock waterfalls for Clusterio and Lua. Measured milliseconds determine
geometry; tick counts remain scheduling evidence in step details. Missing boundaries produce no
duration bar. See [batching and timing](async-processing.md) for the measurement contract.

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
force bonus comparisons and the event history. Legacy rearm-scheduling fields remain available in
raw historical evidence, but are not displayed as a permanent status notice. Server failure-black-box paths are references, not browser download endpoints.

Entities shows recorded creation counts and the destination prototype census. These have different
scopes: zero placement failures does not prove restored belt contents or entity state. A census
without a complete comparison is labelled **Partial evidence**, never Passed.

For failures with a retained black-box reference, opening the log also requests a read-only projection
from the destination host. The Entities tab leads with searchable belt-content differences: entity
prototype/icon, position, transport line, item, source count, destination count, and delta. Placement
totals and the icon-labelled census sit in a separate expandable section. These per-line differences
are diagnostic observations, not individual failed checks; permitted movement may also appear.
The operation verdict remains the recorded structural verdict.

Only the controller can request that projection, using the filename, tick, and destination from the
authorized log record. The reader verifies the operation ID and gate tick, restricts files to failure
diagnostics inside script-output, limits files to 64 MiB and results to 500 differences, and reports
truncation. Missing, oversized, malformed or inaccessible files remain explicitly unavailable.
The optional request has a three-second controller timeout and does not change retained transaction
state or run Lua. Download diagnostic report includes the projected evidence received by the browser,
but does not include the full replay payload. Historical records work while their referenced file is
still present on the destination host. No source/destination matching is inferred for an unassociated
diagnostic.

### Observed belt refusal, Factorio 2.1.17

Operation `836570928:099_lab-transfer-fixture-v1` reproduced the earlier belt refusal. The destination
engine log reports explosive-rocket side-group deltas of 48 versus 52 expected (group 226), and 20
versus 16 expected (group 248). Its retained diagnostic is
`failure_black_box_lab-transfer-fixture-v1_16979845.json` on host 2.

The black box records line 2 of `turbo-transport-belt` at `(-6.5, -1.5)` with 20 source rockets and
16 destination rockets; the adjacent belt at `(-5.5, -1.5)` has 16 source and 20 destination rockets.
These are two side-group discrepancies consistent with one displaced stack of four, not two failed
transfers or a net cargo loss. Item/fluid audits passed and rollback succeeded. The source contains
five stacks on the first belt, including source positions 74/256 and 118/256; the destination has
four stacks there. Engine logs pair an unmatched placement on the first belt with an unmatched
physical stack on the second. A subsequent [bounded insertion probe](../tests/instruments/belt-boundary/README.md)
reproduced the cause on 2.1.17: after empty belts form their internal segments, insertion of the
thirteenth stack succeeds but adds four rockets to the neighboring group. The intended group count
does not change. No simulation tick advances during the measured insertions. The restore loop
counts the accepted write as placement in its intended group; the final census correctly rejects
it. At that point the restoration fix remained outstanding; the structural rejection must not be removed merely
because aggregate cargo matches.

The follow-up candidate experiment reproduced that baseline three times, then restored the small
fixture exactly with `force_insert_at` at captured positions: 17 stacks, 68 rockets, matching
entity/line/position/item/quality/stack-size tuples. This is a bounded candidate result, not a
production fix or full-transfer acceptance. Details and proof limits are in the probe notes above.

The subsequent real-helper experiment (2026-09-07, Factorio 2.1.17) reproduced the two anomalies
using the current helper, then passed three candidate repetitions. The candidate also preserved
eight stateful/quality stacks and restored the retained failure's entire belt geometry exactly:
596 belt entities, 300 side groups, 5,772 stacks and 19,700 items. All captured physical positions
and stack contents matched; the existing structural gate reported zero anomalies. This exercised
the real restoration and item-state code in an isolated bundle, not the complete controller
transfer path. Production restoration remains unchanged. No belt movement between ticks was used
to make the candidate pass. See the probe notes for fixture coverage, hashes and cleanup evidence.

The placement fix was subsequently integrated and deployed locally on 2026-09-07. The deployed
belt self-test passed 21 checks, a stateful full-platform transfer passed, and a second disposable
clone completed a round trip with successful item/fluid and overall validation in both directions.
Source deletion and test cleanup were verified. The structural gate remains active. See the
notebook's integrated results for operation IDs. The subsequent connected-network batching
change records multiple belt work ticks and separate per-callback profiler measurements;
see [batching controls and measured limits](async-processing.md#connected-belt-network-batches-2026-09-07).

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
structural-failure fixture asserts exactly one visible failure alert and one recovery result on
Overview, Entities, and Technical details, while both cargo cards pass. A
delayed response test verifies that an intervening log push retains its outcome and merges with
earlier events without resetting selection, search, or page. Screenshots go to
`ci-artifacts/log-evidence/`.

The redesign was also checked against the local retained `mptransfer-mtonvmga` success and
`lab-omnibus-state-v1` rollback failure. Browser fixtures verify presentation and data handling;
they do not verify server transfer correctness. Existing timing and validation tests remain in place.
No controller schema, messages, Lua instrumentation, gate rules, or transfer behavior changed.
