# Test a change

Choose a test by the behavior it observes. A unit test can prove a branch handles
a simulated missing reply; it cannot prove Factorio accepted an entity property.
A runtime validator's own totals cannot independently prove cargo conservation.

## Available test paths

| Path | Useful for | Environment and boundary |
|---|---|---|
| Root `npm test` | Tooling, analyzers, manifests and fixtures' offline checks | Node; individual tests declare optional dependencies and skips. |
| Plugin `build-plugin.ps1 test` / `smoke` | Controller, message, timing and recovery regressions | Isolated compilation; mocked engine/transport behavior is not live proof. |
| `tests/lua/` | Lua state transitions, scheduling and guards | Lua 5.2 test harness with simulated engine objects. |
| `tests/integration/` | Real transfers, gallery observations and browser behavior | Configured running cluster; suites can mutate or reload worlds. |
| `tests/instruments/` | A bounded engine or performance question | Fixture-specific setup; some require an idle cluster or consenting client. |
| `tests/manual/` | Crashes, save restoration, installation and backup acceptance | Explicitly invoked disposable Docker resources and recorded cleanup. |

The plugin's `smoke` target selects lifecycle tests already included in `test`.
Use smoke for focused feedback while editing, or run the full target for the final
check. Running smoke again after an unchanged full test adds no coverage. Root
Node tests and Lua harnesses cover different code and remain separate checks.

The `item-state` integration suite prepares inventory blueprints/books and belt
item state on one clone, then transfers it once. Both cases retain independent
source and destination observations and their own stored counter assertions.
`config-attrs` uses a separate clone for entity configuration. These suites share
clone identity tracking, transfer observation and guarded cleanup; failures in any
case or in cleanup fail the suite. Fault and recovery suites remain separate.

## Discover before running

```powershell
node tools/tests/run-integration-tests.mjs --list
node tools/tests/run-integration-tests.mjs --only 'transfer-cleanup'
```

The second command uses the configured cluster; it does **not** create a disposable
one. Read the selected suite's setup and cleanup before running it. Gallery suites
consume baked fixtures and reload their paired saves. Do not rearrange a user's
world just to satisfy a readiness check.

The manual [transfer reliability lab](../../tests/manual/transfer-reliability/README.md)
has explicit preview, run and cleanup modes. It creates labelled isolated resources
and retains the original failure separately from a passing recovery observation.
The [Docker acceptance fixture](../../tests/manual/production-profile/README.md) adds a
complete deployment checkpoint/restore and another transfer. Follow each runner's
current arguments and prerequisites; they do not all share one CLI.

## Example: investigate cargo loss

1. Preserve the original operation ID, diagnostic report, source/destination state
   and exact deployed versions. Do not erase the failed record.
2. Build a minimal fixture that reaches the reported boundary. Include a successful
   control so a broken harness is distinguishable from the reported defect.
3. Read physical source cargo, including relevant qualities and belt sides. Capture
   fixture entity state separately from the plugin's serialization output.
4. Run the real transfer and inspect its validation, cleanup and recovery results.
5. Read destination cargo independently and compare the same scope. Also check for
   an extra usable source and for retained locks/holds.
6. Apply the fix and rerun the same assertion. A deliberately removed protective
   branch should fail its regression without mutating the live mounted runtime.
7. Remove only owned fixtures and verify both world and persistent test-state cleanup.

An API error, missing fixture, missed fault injection or failed cleanup is a harness
failure, not evidence of a product defect or a pass. Do not weaken an expected
quantity to match the observed result. Equal overall counts alone do not prove
per-quality, per-side or entity-state preservation.

## Tick waits and timing

`Step-Tick` in the PowerShell helper sends `/step-tick`; it does not sleep for a
precise number of ticks. The current command unpauses simulation and does not
implement its supplied tick count. For a bounded wait, observe advancing ticks or
the specific job/phase predicate and use a deadline that reports unavailable work
honestly. Do not treat command delivery as completion.

Performance experiments must record local measured milliseconds independently of
tick counts. Distinguish maximum callback cost from end-to-end latency and client
rendering. See [timing](../technical/timing.md),
[callback profiling](../../tests/instruments/callback-profile/README.md) and
[client/server cadence](../../tests/instruments/tick-watch/README.md).

## Browser and diagnostic checks

Check which web bundle the controller serves before attributing a stale screen to
source code. Browser regressions inspect actual navigation, permissions and error
states. Motion/log previews are synthetic rendering tests. They do not certify a
real transfer, physical cargo or performance.

Use `node tools/surface-export/canvas-shot.mjs --help` for the existing canvas
capture tool. See [diagnostics](diagnostics.md) for logs and offline report analysis.
Keep detailed experiment results beside their harness; do not add tests that parse
documentation or interpret prose as a correctness certificate.
