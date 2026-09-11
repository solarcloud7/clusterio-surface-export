# Production profile acceptance

Contract fixed before running: use the actual resolved production Compose file and
baked images, create two fresh saves with the public CLI, verify disabled diagnostic
and experimental settings, real exported assets and authenticated browser views.
First transfer with the shipped startup and no fault hook. Stop the complete deployment,
archive and compare all twelve resolved volumes, then restore them into fresh owned volumes
and containers. Keep the original resources stopped until final cleanup. Require the same
authentication, cargo, history, hardening settings and authenticated assets, plus another transfer.
Temporarily disable instance auto-start to select the checkpoint explicitly on restoration,
then restore and read back its original setting. Then recreate the hosts
with the fault hook, withhold a successful source-deletion reply, kill/restart the controller container,
then require exact physical cargo, one import, held destination before acknowledgement,
completed recovery and retained history. Reuse the existing physical oracle unchanged.
After completion, recreate the controller from the same image and verify retained
history, physical cargo and exported assets through the authenticated browser.

Test-only changes: unique resource names/labels, random loopback ports, read-only fault
hook on hosts during the recovery arm and a private copy of the supplied licensed client volume. No seed worlds, product-source mounts,
receipt edits, timer changes or live-cluster operations. Diagnostic defaults stay off.
The shipped profile keeps auto-pause off so unattended destinations can process imports.

First run `--cleanup-proof`, deliberately failing after Compose startup. Require verified
zero owned resources before the full run. Ten-minute setup and twenty-minute restore limits,
bounded CLI commands, and cleanup in `finally` apply. Stop on invalid evidence or cargo
violation. Reports preserve image IDs, profile hashes, settings and physical observations.
Analyzer changes do not require another game run.

```
node tests/manual/production-profile/run.mjs --cleanup-proof <runtime.json> <existing-client-volume>
node tests/manual/production-profile/run.mjs --run <runtime.json> <existing-client-volume>
node tests/manual/production-profile/run.mjs --analyze <result.json>
```

This is fresh installation, same-image volume restoration and controller restart, not an upgrade, off-host
restore, mixed-generation reconciliation, public TLS endpoint or universal cargo proof.

## Historical acceptance: 2026-09-10

- [Intentional abort](evidence/cleanup-proof.json), `se-manual-mtvo2dl7-c940579e`:
  reached healthy startup with only Surface Export registered; injected abort and cleanup passed.
- [Full acceptance](evidence/accepted-0.10.281.json), `se-manual-mtvo3v75-5a55e9d8`:
  PASS in 182.416 seconds including setup and cleanup. This is one small-fixture run,
  not a transfer-time or recovery-time guarantee. Four physical samples preserved
  item/quality, belt-side, fluid and entity cargo. Exactly one import and a real source
  deletion retry were observed. Controller SIGKILL/restart completed recovery; subsequent
  same-image recreation retained the completed operation and six exported assets.
  Browser checks passed with two gateway nodes, the transfer log and no failed responses
  or page errors. Every owned container, volume and network was removed.

The report retains exact image IDs and package/gateway hashes. Diagnostic flags and
experimental codec were off, admission/shared Lua limits were one, and both instances
kept ticking without players. No per-test override of these profile settings was used.
The screenshots and bounded raw logs remain under the run's `ci-artifacts/` directory.

[Setup findings](evidence/setup-findings.json) retain the observed failures: local-only
host configuration refused through control, wrong CLI read verb, informational output
mixed into a read, automatic rediscovery of unwanted bundled plugins, and a build-check
log created with root ownership. The earlier successful cargo run still had bundled
plugin errors and is not the accepted profile. The final bounded logs contain none of
those unknown-context, unexpected-error or permission-denied messages.

The root test suite must run after the live lab releases `ci-artifacts/workflow.lock`:
its deploy-preflight tests also exercise that lock. A concurrent invocation tested lock
contention instead of its intended fixtures; no product change was needed for it.
