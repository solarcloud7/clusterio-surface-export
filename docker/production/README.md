# Packaged deployment profile

This separate Compose file runs one controller and two hosts from locally built,
content-addressed images. It uses Clusterio Docker's existing entrypoints and public
Clusterio CLI. It does not mount this checkout, seed test saves, download dependencies
at startup, or modify the development cluster. No Docker base-image change is required.

Supported candidate: plugin 0.10.281, Clusterio 2.0.0-alpha.27, Factorio Space Age
2.1.17 and gateway 0.6.5. This is a deployment contract for supervised use; historical
upgrades, mixed-generation recovery and operating limits remain separate gates.

## Build the accepted package into images

Use `package.tgz` and `acceptance.json` from the same passing release-acceptance
artifact. Supply the full commit that produced that artifact, not a later merge SHA.
The helper replays its acceptance oracle and verifies both npm integrity and SHA256.
It copies only build scripts and the two supplied archives into a new build context.

```powershell
node tools/release/build-runtime.mjs <artifact-directory> <accepted-commit> 0.10.281 <gateway.zip> <gateway-sha256> <new-output-directory>
```

The build uses normal `npm install` into the pinned Clusterio installation. It verifies
the four core versions and shared library identity, then registers only Surface Export.
Other plugins bundled in the base images are removed through npm during the build;
Clusterio otherwise rediscovers them from dependencies even with an explicit plugin list.
Their companion mods and
compatibility would need separate installation and acceptance.
This is the Docker deployment path; the separate consumer lab tests `npm init @clusterio`.
The gateway archive must be version 0.6.5. Keep `runtime.json`, the two image IDs, package
acceptance and gateway hash together. Dependency resolution happens at build time;
rebuilding can produce different image bytes. Deploy the recorded image IDs, or push
the built images and use their registry digests. Do not substitute mutable tags.

## First installation

Create a private environment file outside version control:

```dotenv
SE_PROJECT=surface-export-production
SE_CONTROLLER_IMAGE=sha256:<controller ID from runtime.json>
SE_HOST_IMAGE=sha256:<host ID from runtime.json>
SE_ADMIN=your-factorio-username
SE_CLIENT_VOLUME=your-dedicated-factorio-2117-client
SE_HTTP_PORT=8180
SE_HOST1_PORT=35100
SE_HOST2_PORT=35200
SE_GAME_BIND=127.0.0.1
```

The client volume must already contain a licensed Linux full Space Age 2.1.17 client
and belong to this deployment. Both hosts mount it read-only. This profile neither
downloads nor redistributes it. Do not point a production deployment at development
data volumes. The test harness copies the development client into a disposable volume.

```powershell
docker compose --env-file <production.env> -f docker/production/compose.yml up -d --wait
node docker/production/provision.mjs <production.env>
```

Provisioning creates `platforms-1` and `platforms-2` with fresh `world.zip` saves,
enables all required Space Age mods including Recycler, exports locale/icons, and
starts both instances. It refuses existing instance names; it is not an upgrade or
repair command. If provisioning stops midway, inspect the failed command and existing
state before continuing with Clusterio's CLI. It never deletes existing worlds to retry.

The explicit values in [settings.json](settings.json) disable debug snapshots, belt
tracing, per-batch profiling and the experimental codec. Transfer history, phase
timings and validation remain enabled. Admission and the shared Lua step limit are
both one. Instances auto-save every five minutes, keep ticking when empty, require
Factorio user verification and are not publicly listed. Unattended transfers require
advancing game ticks; auto-pause is an operator choice, not a transfer timeout fix.
Remote core/package updates are disabled on controller and hosts; runtime updates
replace built images. These fields are local-only in Clusterio. A checked build-time
hook adds local configuration after the pinned controller entrypoint's bootstrap and
before its server starts. Host fields are applied after host configuration bootstrap.
The hook refuses a changed startup marker instead of silently skipping configuration.

The web port binds to loopback only. Use an operator-managed HTTPS reverse proxy
before exposing the controller remotely; preserve WebSocket forwarding and Clusterio
token authentication. Game ports also default to loopback. Set `SE_GAME_BIND` to the
intended host interface and configure its firewall deliberately for remote players.
Public game listing remains disabled. All containers are within one trusted operator
boundary: the existing Docker boot guard gives hosts access to the shared admin-token
volume. This is not isolation from an untrusted host administrator.

Generate a login token privately with the existing Clusterio CLI:

```powershell
docker compose --env-file <production.env> -f docker/production/compose.yml exec --user clusterio controller npx --no-install clusteriocontroller --config /clusterio/data/config-controller.json bootstrap generate-user-token <admin-name>
```

Treat the output as a secret. Do not paste it into reports or commit the environment
file. Docker log rotation is bounded; Clusterio's persistent file logs need an operator
retention policy. The profile retains the controller's native static-cache behavior.

## Recovery and upgrades

The plugin Settings tab's **Transfer recovery → Platform source of truth** has two modes:

- **Plugin history** (default) protects restored source copies already recorded as transferred
  away. Use this when reloading an old instance save while keeping its arrived destination.
- **Save game** accepts identified restored copies after startup reconciliation establishes
  that no unresolved handoff owns them. Use this when deliberately reloading yesterday's save
  to recover a destroyed platform. Another copy can remain elsewhere; the Gateways warning
  identifies the restored source and its previous transfer for operator review.

The controller stores the configured mode. Instances apply it on their next restart; Settings
shows configured/applied modes and the restart requirement. An offline or unreconciled instance
is unverified. Both modes retain protections for active and unresolved transfers. An accepted
restoration receives a fresh saved identity and remains accepted after later policy changes.
Neither policy recreates missing platforms or changes the outcome of an old transfer.

Transaction details offer **Restore from snapshot** while an importable stored payload remains.
Completed snapshots use the existing **Stored Payload Downloads** retention count; later exports
can evict them. This is a bounded recovery cache, not a backup retention policy.
Review its date, name and destination before confirming; offline instances do not establish
that no other copy exists. Restoration creates a new import operation with normal validation,
without replaying source deletion. Expired downloads and diagnostic-only reports cannot be
restored. A black-box file is usable only when it contains an importable `replay_payload`.
The equivalent CLI takes a request UUID; reuse that UUID after an uncertain response:

```powershell
npx clusterioctl --config <control-config.json> surface-export restore-snapshot <stored-export-id> <destination-instance-id> <request-uuid>
```

Named volumes retain controller data, static assets, tokens, both hosts' data, the
controller mod store, host mod caches and logs. Never share a controller data volume between running controllers.
Back up the complete stopped deployment volume set, the external client separately,
the environment/configuration and recorded image/package/mod identities. Token and
backup material must remain private. The production acceptance runner archives all twelve
resolved volumes, including its private client copy, and restores them to fresh owned volumes.
It refuses an unknown volume set. This remains a local, same-image drill; off-host recovery
and mixed backup generations require separate acceptance.

Restarting the same images is distinct from upgrading code. Before an upgrade,
quiesce transfers, capture a coordinated backup and test the candidate against those
saves and journals in a disposable environment. Do not roll back worlds or journals
as a substitute for code rollback. No historical upgrade or downgrade is certified
by this profile. Do not use `down -v` for normal maintenance.

Run the [manual acceptance lab](../../tests/manual/production-profile/README.md)
before adopting a new built image pair. No registry publication or live deployment is
performed by the build or lab tools.

The [complete 0.10.281 restoration acceptance](../../tests/manual/production-profile/evidence/complete-restore-0.10.281.json.gz)
passed fresh saves, all twelve volume archives restored into new owned resources, selected
checkpoint markers, settings, authentication, physical cargo, retained history and another
transfer. Lost-reply recovery, controller recreation and six browser-loaded assets passed
afterward. The [earlier acceptance](../../tests/manual/production-profile/evidence/accepted-0.10.281.json)
remains separate and did not exercise this complete restore. The reports' image IDs
are local build identities, not published registry references. The acceptance covers
the recorded image pair and fixture; it does not certify a future rebuild or upgrade.
