# Consumer installation acceptance

This manually triggered lab exercises Clusterio's published installer, then its public
plugin registration, mod upload, mod-pack, save creation and export-data commands.
It does not use the Docker image's seeding or plugin-install entrypoint. The pinned
host image supplies Node and OS libraries; all Clusterio packages used by the test
must resolve inside the initially empty `/consumer/node_modules` installation.

## Contract and boundaries

- Pin installer/core `2.0.0-alpha.27`, Factorio client `2.1.17`, gateway mod `0.6.5`.
- Supply a packaged plugin tarball and gateway ZIP. Never fill runtime gaps from checkout source.
- Run the upstream installer as a non-root user. Verify npm-name registration; alpha.27's CLI
  auto-discovers an installed plugin when no plugin list exists. Add it only if absent.
- Create both saves through the public CLI, without development seed saves.
- Require real locale/prototype/icon exports and an authenticated browser loading the plugin.
- Require one visible gateway and connections to the five basic planets on each instance.
- Reuse the independent physical cargo and lost-source-reply recovery fixture. Kill the controller
  child with SIGKILL; the installer's generated `run-controller.sh` restarts it in the same PID
  namespace. Verify a different controller PID and a real recovery retry. Neither the
  product's validator nor UI success messages alone establish cargo conservation.
- Copy the explicitly named, existing client volume through a read-only mount into an owned
  test volume. Never mount the original volume writable or use the live cluster's data/tokens.
- Every container/network/volume has a unique manual-run label. Cleanup verifies labels and
  names and independently checks for zero remaining owned resources, including on failure.
- The controller exposes only a random loopback port for the browser test. Generated lab
  credentials stay out of reports. No image, package, client or credentials are published.

First run `--cleanup-proof`, which deliberately fails immediately after installation. Proceed
only if that exact installer/setup tuple reports successful cleanup. Then run one full fixture.
Use ten-minute setup and runtime budgets, four-minute installer subprocess limits, bounded
RCON reads and the existing physical fixture. Stop on the first invalid observation or failure;
missing measurements are not passes. A full run also requires cleanup before PASS.

```powershell
./tools/surface-export/build-gateway-mod.ps1 -SkipClientSync
node tests/manual/consumer-install/run.mjs --cleanup-proof --package <candidate.tgz> --gateway-zip docker/seed-data/mods/surfexp_gateways_0.6.5.zip --client-volume factorio-client-2117
node tests/manual/consumer-install/run.mjs --run --package <candidate.tgz> --gateway-zip docker/seed-data/mods/surfexp_gateways_0.6.5.zip --client-volume factorio-client-2117
```

The client volume argument is machine-specific. A missing source volume is refused, never
created. The harness uses a licensed client already installed by the operator; it does not
download one or require their factorio.com credentials. Failed-run resource cleanup is also
available through the existing transfer runner's `--cleanup <run-id>` command.

Upstream installation instructions: https://github.com/clusterio/clusterio#installation.
This is a candidate fresh-install test, not historical upgrade or registry-publication proof.

## Setup findings

- A fresh Space Age mod pack for client 2.1.17 must enable the bundled `recycler:2.1.17` alongside
  base, quality, elevated-rails, and space-age. The engine rejected fresh-save creation without it:
  `Missing required dependency recycler >= 2.1.0`. The client metadata confirms this dependency.
- A raw container restart with the controller as PID 1 failed in alpha.27: its PID-only config lock
  contains `1`, and the next container process is also PID 1. This lab now exercises the installer's
  process supervisor, which gives the restarted child a different PID. It never deletes that lock.
  A successful process-restart case does **not** prove raw container-restart support.
- Long CLI operations retain verbose output on failure. Error-level logging alone omitted the
  Factorio mod-loading error; it only reported exit status 1.
- The shared Docker log collector now retains stderr on successful `docker logs` calls too.
  Previously, fatal controller startup messages were absent from saved logs even though they
  appeared during interactive inspection. The retained lock-error excerpt identifies that source.

`--analyze <result.json>` reruns the acceptance oracle without Docker. A failed command or missing
evidence reports HARNESS_ERROR; observed cargo/recovery violations report STOP. Only the full
contract plus verified resource cleanup can report PASS. No transfer timer or acceptance gate
is relaxed for this test.

## Verified 2026-09-10

[Accepted package 0.10.281](evidence/accepted-0.10.281.json) completed in about 131 seconds,
including installation and cleanup. This is one observed run duration, not a performance target.
Package SHA-256: `5420aad93cc1bac39353b1efe0c420c3e1628a38fc42151fada54dd5bb3430db`.

The run used the upstream initializer twice (standalone, then control), exact alpha.27 core
packages, new `consumer.zip` saves on both hosts, and the committed gateway ZIP. Six real exported
assets returned HTTP 200, including 7,585 locale entries and the icon sheet. Runtime probes on
both instances verified one visible gateway with all five planet connections; the authenticated
browser showed both instances and the retained transfer. The controller restarted from PID 7 to
PID 746 after SIGKILL. Independent physical observations matched the literal item/quality,
belt-side, fluid and entity contract, with one import request and a real cleanup retry.

The [intentional abort](evidence/cleanup-proof.json) and [setup failures](evidence/setup-failures.json)
also verified removal of all owned Docker resources. Local screenshots and full logs remain in
the corresponding `ci-artifacts/<run>/` directories. The JSON evidence contains no client files
or credentials. Offline tests deliberately remove observations, change cargo, duplicate import
calls, and remove recovery retries to verify that those reports cannot pass.

This covers Linux installation using the pinned host image's OS libraries. It does not prove
a clean Windows installation, historical save upgrades, raw PID-1 container restarts, every
platform layout, native game-client rendering, or npm registry publication.
