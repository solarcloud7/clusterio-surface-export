# Packaged deployment profile

This separate Compose file runs one controller and two hosts from locally built,
content-addressed images. It uses Clusterio Docker's existing entrypoints and public
Clusterio CLI. It does not mount this checkout, seed test saves, download dependencies
at startup, or modify the development cluster. No Docker base-image change is required.

Recorded acceptance used plugin 0.10.281, Clusterio 2.0.0-alpha.27, Factorio
Space Age 2.1.17 and gateway 0.6.5. That identifies a tested artifact, not the
currently published release or an acceptance of every later source revision.
Historical upgrades, mixed-generation recovery and operating limits require
separate verification.

## Build the accepted package into images

Use `package.tgz` and `acceptance.json` from the same passing release-acceptance
artifact. Supply the full commit that produced that artifact, not a later merge SHA.
The helper replays its acceptance oracle and verifies both npm integrity and SHA256.
It copies only build scripts and the two supplied archives into a new build context.

```powershell
node tools/release/build-runtime.mjs <artifact-directory> <accepted-commit> <accepted-version> <gateway.zip> <gateway-sha256> <new-output-directory>
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

The explicit values in [settings.json](../../docker/production/settings.json) disable debug snapshots, belt
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

## Updates and recovery

Build and accept the replacement package and image pair before scheduling an
update. Preserve the current resolved deployment and its persistent data. Use
the replacement image IDs/digests with that same deployment configuration;
provisioning is only for fresh instance names and is not an upgrade command.
Do not rerun it to repair a partially completed installation.

Back up the complete deployment and rehearse restoration into fresh resources.
Follow [backups and recovery](recovery.md) for save-policy choices, snapshot
restoration and unresolved handoffs. Do not delete volumes to update the plugin.
Fresh-install acceptance does not establish compatibility with historical saves,
journals or code rollback.

The [production-profile fixture](../../tests/manual/production-profile/README.md)
retains the exact image, checkpoint and physical-state observations for its
complete-volume restoration. A same-machine fixture does not establish an off-host
backup service, disaster recovery on different hardware or a capacity limit.

The [local development workflow](../developers/workflow.md) applies to the root
source-mounted cluster. Do not use its reset paths on this packaged deployment.
