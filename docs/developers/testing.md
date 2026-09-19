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
item state on one clone, then transfers it once. All setup and source checks must
pass before transfer; a partially prepared fixture is cleaned up without being
transferred. After successful setup, both cases retain independent source and
destination observations and their own stored counter assertions.
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

### Factorio GUI captures

The testkit can launch the development environment's full Linux client in a
disposable container with a virtual display. It uses the client volume configured
in Compose and requires the version recorded in the plugin's API index. It does
not launch Steam, control the desktop mouse, or connect to the development worlds.

```powershell
node tools/tests/testkit/cli.mjs client doctor
node tools/tests/testkit/cli.mjs client run smoke
node tools/tests/testkit/cli.mjs client run remote-view-panels --resolution 1600x1000 --scale 1
node tools/tests/testkit/cli.mjs client run gui-anchors
node tools/tests/testkit/cli.mjs client inspect <run-id>
node tools/tests/testkit/cli.mjs client cleanup <run-id>
```

`doctor` checks Docker, the installed image and the actual client version. The
first capture run builds a cached graphics layer with Xvfb and Mesa; this needs
package repository access. Game containers run without network access, mount the
client read-only and create a fresh save. Each has a four-CPU limit and an 8 GiB
memory limit. Software rendering is useful for layout inspection, not client
performance measurements.

`smoke` captures a small test window in the game. `remote-view-panels` stages the
current Lua UI and companion mod, then captures a short platform list, a growing
list, a shrinking list, a long scrolling list and the Boarding menu. Each capture
writes `<name>-positions.json` with panel locations and tags; `location-events.jsonl`
records every engine location event and display resolution or scale event with the
values seen at that tick. The container's virtual display accepts pointer requests
(`pointer-request-<n>.txt`, executed with `xdotool` and logged to `pointer.log`);
no current capture issues one. It does not board a player or prove possessions
survive boarding. Use the separate boarding acceptance for that behavior.

`gui-anchors` probes the controller, additional entity information and platform
hub anchors in Remote View, then opens the hub window as a control. It retains
both screenshots and the accessible GUI roots in `gui-roots.json`. An accepted
anchor property alone does not prove that a panel is visible.

Runs retain reports, command evidence, logs, fresh saves and PNGs under
`ci-artifacts/client/<run-id>/`. A successful capture requires a matching engine
completion marker, viewport, UI scale and complete screenshot files, followed by
owned-container cleanup. Inspect the images before accepting the layout; the
report deliberately leaves visual review unapproved. A missing marker, timeout,
changed source or failed cleanup fails the run. `--timeout-seconds` accepts
30–600 seconds for the client run; graphics-image preparation has its own bound.
After interruption, `cleanup` removes only containers bearing that run's identity
and retains the evidence. It does not remove the shared client volume or graphics
image cache.

### Clusterio web interface

Check which web bundle the controller serves before attributing a stale screen to
source code. Browser regressions inspect actual navigation, permissions and error
states. Motion/log previews are synthetic rendering tests. They do not certify a
real transfer, physical cargo or performance.

Use `node tools/surface-export/canvas-shot.mjs --help` for the existing canvas
capture tool. See [diagnostics](diagnostics.md) for logs and offline report analysis.
Keep detailed experiment results beside their harness; do not add tests that parse
documentation or interpret prose as a correctness certificate.
