# Local client sync and restoration follow-ups

## Scope and decisions

The client sync tool prepares an engineer's local Factorio mods from this checkout's seed set.
It does not query the controller or certify a manually edited running mod pack. Keep that offline
contract and preserve unrelated client files.

Research on the pinned running controller found `/scripts/seed-mods.sh` passes Bash's filename-sorted
zip list to `mod-pack edit --add-mods`. Clusterio's `setModPackMods` sets a map entry for each argument:
the last version of each name wins. This is not numeric version ordering. The controller's POSIX
locale makes ordinal filename order the relevant comparison. The current seed set has one zip per
mod, matching the six non-builtin mods in the running `Space Age 2.0` pack.

Implemented duplicate-seed policy: accept coexistence when the last filename and numeric maximum select
the same version. Refuse divergent selections before copying or deleting, with a diagnostic naming
the conflicting seeds. Never call a seeded version a client shadow. This keeps the local tool safe
without changing the external base image's seeding behavior.

The chosen end state is highest numeric version selection in both client sync and cluster seeding.
That remains pending: update `clusterio-docker/scripts/seed-mods.sh`, publish and pin the resulting
image, then remove the divergence guard. This PR does not implement or claim that cross-repository
change. The gateway builder selects its exact source version because its upload pins that version;
other seed archives can remain in the checkout when switching branches.

Gateway configuration: preserve the missing-list fallback; an explicitly empty list means no active
gateways. Normal controller modes already send either the hub or the four numbered gateways.

Drill invariant: a drill captured inactive stays inactive after transfer, retains its captured mining
and bonus progress while dormant over ore, and restores those values after reactivation. Progress
after reactivation may advance with mining ticks. No manually injected destination queue or progress
writes may satisfy the transfer oracle.

## Implementation order

1. Add temporary-directory tests executing the actual PowerShell tools, demonstrate the seed/prune
   failures, then group seeds, preflight conflicts, and scope gateway synchronization/pruning.
2. Add a live gateway test covering missing, empty, hub, multi, and repeated reapply; restore all
   original configuration and each force's physical unlock state in `finally`. Fix the shared predicate.
3. Add a small transfer fixture with measured source progress and inactivity. Prove the current loss,
   move the production queue outside the activation branch, and rerun the same fixture.
4. Run the existing mining dormancy controls, lint, both unit suites, and affected integration suites.

## Live experiment bounds

Use the existing localhost 2.1.17 cluster only after both hosts report no players, pauses, jobs,
locks, holds, or tombstones. Use uniquely named disposable platforms, at most 120 seconds of transfer
polling and budget+60 ticks of dormancy, then five reactivation ticks. Refuse dirty preflight; never
clear another owner's pause. Scope cleanup to the fixture and independently check leftovers.
Record module/mod versions, fixture source hashes, source/payload/destination readings and cleanup
in ignored `ci-artifacts/` reports. Use the same observer before and after the production change.
Temporary runtime function replacement, when used to verify checkout Lua without resetting saves,
must preserve the original function references and restore them in `finally`.

## Completion evidence

The PowerShell fixtures reproduced four failures before the fix: duplicate seeds refused themselves,
shadow refusal copied files first, dry-run with authorized pruning threw, and gateway pruning deleted
an unrelated newer client mod. Eight tests now pass, including ambiguous filename/numeric ordering,
same-name hash repair, repeat runs, and preservation of prefix-sharing mod names.

The gateway test failed on an empty set before the predicate change and passed missing/empty/hub/multi
sets plus repeated reapply afterwards. Both its natural failure and an injected failure restored
the exact original configuration and physical locks on every force.

The transfer fixture measured source and payload values of mining=0.55, bonus=0.62, active=false.
Before the fix, the destination had zero values and no pending record. After the fix it retained one
record through 360 inactive ticks, then consumed it on reactivation: at +5 ticks the drill physically
read mining=0.5666666666666667 and bonus=0.6316666666666667. The source was deleted by the production
transfer path. Both hosts finished with zero jobs, locks, holds, tombstones, fixture surfaces and
pending mining records, and neither remained tick-paused. An injected post-construction failure also
cleaned up successfully. The test asserts the exact controller transfer reports `completed`.

The existing mining-progress-gate suite passed with the changed module, including active-over-bare
expiry and inactive-over-bare termination. The WE-SET artifact regenerated byte-identical.
The existing gateway-park-proxies suite also passed: a real gateway transfer preserved both proxy
shapes, reported validation success for its exact platform, and restored the configured locks.

Validation uses `tools/tests/with-checkout-lua.mjs` to install the checkout functions temporarily in
the already-loaded module tables, record their SHA-256, and restore original references in `finally`.
This tests the changed Lua without resetting the engineer's saves. It is not a permanent deployment;
the regular Lua deployment remains a separate operator action. Only the burner-mining-drill fixture
was measured; this does not claim coverage of every drill prototype.

Full lint passed. Repository unit tests: 416 passed. Isolated plugin tests: 607 passed, 11 skipped;
seven of those skipped checks subsequently passed on the Windows host (42 checks in their files).
The remaining four check-pr-scope tests create temporary Git repositories and were not run because
the owner's global instructions prohibit creating repositories. No worktrees or clones were created.

The real-client dry-run reported six unchanged seed zips and no copies or repairs.

## Local code review

Reviewed the final changes against `c2a4f81` (main after #291), covering file ownership, version
selection, empty gateway configuration, inactive restore behavior, and test cleanup. This was a
local review pass, not a separate reviewer or a GitHub approval.

Resolved findings:

- P2: Building an older gateway source with a newer seed present copied the newer archive to the
  client. A failing regression reproduced it. The builder now selects its exact built version;
  a newer client copy still requires explicit pruning, and the seed archive is preserved.
- P2: PowerShell's case-insensitive maps could prune a differently cased mod name. A failing
  preservation test reproduced it. Seed grouping and client ownership now use ordinal maps.
- Test reliability: destination platform creation precedes entity restoration, and controller
  completion can lag source deletion. Poll until the drill exists and the exact transfer completes.
  Cleanup releases owned pauses first and refuses surface deletion while either host has live jobs,
  locks, holds or tombstones. A pause-ordering failure in this cleanup guard was caught and corrected.

Remaining limits: the transfer fixture covers a burner drill on Factorio 2.1.17. An in-flight timeout
can leave its uniquely named platform for operator inspection; cleanup reports an error instead of
deleting a surface owned by an active transfer. Forced process termination can bypass `finally` in
these local test tools. The new live fixtures are operator-run and are not added to CI's suite list.

## Operator use

```powershell
# Inspect all repo-seeded client mods without changing files.
./tools/clusterio/sync-client-mods.ps1 -DryRun

# Sync missing/stale seed zips; refuse conflicting newer client copies before making changes.
./tools/clusterio/sync-client-mods.ps1

# Preview or perform removal of newer client copies for one exact mod.
./tools/clusterio/sync-client-mods.ps1 -ModName surfexp_gateways -PruneShadowing -DryRun
./tools/clusterio/sync-client-mods.ps1 -ModName surfexp_gateways -PruneShadowing

# Build and sync only the gateway mod, optionally deleting its other client versions.
./tools/surface-export/build-gateway-mod.ps1 -PruneOldClientVersions
```

The general sync preserves mod-list.json and does not enable/disable unrelated client mods. The
gateway builder retains its existing mod-list edit for the gateway entry alone. This is a seed-file
sync, not an assertion that a running mod pack has never been edited manually or that all enabled
client-only mods are compatible with joining it.
