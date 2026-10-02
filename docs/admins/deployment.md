# Install and update the Clusterio plugin

Surface Export installs into Clusterio as the npm package
[@solarcloud7/plugin-surface-export](https://www.npmjs.com/package/@solarcloud7/plugin-surface-export).
The separate [Surface Export Gateways mod](https://mods.factorio.com/mod/surfexp_gateways)
provides the Factorio prototypes and artwork. Administrators do not need to clone
this repository or run its development containers.

## Start with a working Clusterio installation

Follow [Clusterio's installation instructions](https://github.com/clusterio/clusterio#installation).
For a deployment managed by [clusterio-docker](https://github.com/solarcloud7/clusterio-docker),
use that project's container setup and plugin-installation process. Surface Export
does not supply a replacement controller, host, container distribution or network
topology. Hosting, authentication, TLS and process supervision remain responsibilities
of the Clusterio deployment.

## Release availability

Plugin `0.11.0-beta.6` is the current release under npm's `beta` tag. It requires
exactly Clusterio `2.0.0-alpha.27`, Factorio Space Age `2.1.20` and the
`surfexp_gateways` mod `0.7.9`. Every release is published by the
[release workflow](https://github.com/solarcloud7/clusterio-surface-export/actions/workflows/ci.yml)
from a `v*` tag after package acceptance and integration checks; the published
archive matches the tested archive byte for byte. What changed in each version is
in the plugin's [changelog](../../docker/seed-data/external_plugins/surface_export/CHANGELOG.md).

npm's `latest` tag still points to `0.9.82`. That version's Clusterio peer
requirement, `^2.0.0`, excludes the pinned prerelease `2.0.0-alpha.27`, and it does
not provide the newer upload, portal and save-recovery behavior. Select the beta
version explicitly. Do not bypass npm peer checks with `--force` or
`--legacy-peer-deps` to install the older release.

## Install the npm package

### Published version

Run these commands in the Clusterio installation directory:

```text
npm view @solarcloud7/plugin-surface-export dist-tags
npm view @solarcloud7/plugin-surface-export@0.11.0-beta.6 peerDependencies
npm install --save-exact @solarcloud7/plugin-surface-export@0.11.0-beta.6
```

### Accepted candidate archive

For an unpublished candidate, use the same archive that passed acceptance.
Obtain `package.tgz` and its accompanying `acceptance.json` from the maintainer's
accepted CI artifact. Require a successful run for that commit, including package
acceptance and the integration checks. Confirm the recorded package version and
compare the archive's SHA-256 with `package.sha256` in the report. Keep the archive
available for every participating installation; do not rebuild or repack it.

In the normal npm-based Clusterio installation directory, replace the path below
with the archive's absolute path:

```text
npm install --save-exact /absolute/path/to/package.tgz
```

This is the package-install route exercised by the
[acceptance fixture](../../tests/manual/package-install/README.md).

### Register the installed plugin

After either installation route, check Clusterio's plugin list:

```text
npx clusteriocontroller plugin list
```

If `surface_export` is absent from the plugin list, register it:

```text
npx clusteriocontroller plugin add @solarcloud7/plugin-surface-export
```

The shared-directory Clusterio setup uses the same plugin list for its controller,
host and control client. For separate installations, install the same package version
and register it in each controller, participating host and control-client directory.
Use `clusteriohost` or `clusterioctl` in place of `clusteriocontroller` where appropriate.
Preserve other installed plugins and existing configuration. This follows the
[pinned Clusterio plugin-install procedure](https://github.com/clusterio/clusterio/blob/v2.0.0-alpha.27/README.md#installing-plugins).

For Docker-managed installations, make the package change through the hosting
project's persistent installation/update mechanism; an edit in a disposable container
layer is not a durable installation.

## Enable the gateway mod and verify startup

Add the matching `surfexp_gateways` release (`0.7.9` for this plugin version) from
the Mod Portal to the instances' Clusterio mod pack. Use a licensed Factorio Space Age installation with its required
bundled mods enabled. Players need the matching mod pack when joining; the gateway
mod alone does not provide the server-side transfer implementation.

Restart the controller, affected hosts and instances through the deployment's normal
save-preserving procedure so the Node plugin and save-patched Lua are both loaded.
Use Clusterio's export-data process for the selected mod pack to generate locale and
icon assets. Confirm that the plugin loads, Surface Export opens in the controller
web interface, and each participating instance exposes its gateway.

Review [configuration](configuration.md) and [permissions](commands.md) before
enabling transfers. The checked-in default for `debug_mode` is `true`; set it to
`false` on operational instances unless diagnostics are needed, then restart those
instances. Normal transfer history and validation do not require debug mode.

## Update an existing installation

1. Check the target version's compatibility and release notes. Keep controller, host
   and control-client plugin versions aligned.
2. Finish transfers where possible. Preserve evidence for unresolved operations and
   take a coordinated [backup](recovery.md#back-up-a-deployment) before updating.
3. Install the chosen package version through the same Clusterio deployment mechanism
   used for the original installation. Update the mod pack when that release requires it.
4. Restart the affected processes and instances while retaining saves, configuration,
   history and recovery journals. Verify loaded versions and a supervised transfer.

Do not create fresh worlds, delete volumes or rerun a development seed/reset script
to update the plugin. Fresh-install acceptance does not establish compatibility with
every historical save or code rollback.

When upgrading Factorio, scenario migrations can replace Clusterio's patched scripts.
The first start may fail with `clusterio_private.update_instance` reporting that
`clusterio_private` is nil. Clusterio documents a second instance start as the remedy
in its [known issues](https://github.com/clusterio/clusterio#known-issues).
After confirming the instance stopped, retry the same save once. Other failures,
a repeated failure, or missing recovery state require investigation; do not delete
`script.dat` or reset the world. Verify the plugin loaded and recovery completed.
Rehearse the upgrade on a copy of your deployment and retain a coordinated
pre-upgrade backup.

The [consumer-install fixture](../../tests/manual/consumer-install/README.md) exercises
Clusterio's published installer and plugin registration with a candidate npm tarball.
Its recorded results identify exact tested versions. Docker-based backup and restart
fixtures are test infrastructure, not an alternative operator installation path.

## Apply a desired state with the reconcile tool

A cluster's mods, mod pack and controller, host and instance configuration can be
kept in one desired-state file and applied from a checkout of this repository. The
file for the public cluster is `tools/clusterio/desired/vm.json`. The tool needs
Docker with the development controller container (it uploads mod ZIPs from
`docker/seed-data/mods`) and, for a remote cluster, an entry in the ignored file
`tools/clusterio/remote-clusters.local.json` of the form
`{"vm": {"url": "https://controller.example/", "controlConfig": "C:/path/to/config-control.json"}}`.

```text
node tools/clusterio/reconcile.mjs plan  --cluster vm --desired tools/clusterio/desired/vm.json
node tools/clusterio/reconcile.mjs apply --cluster vm --desired tools/clusterio/desired/vm.json --yes [--restart]
```

`plan` prints the exact `clusterioctl` commands it would run and the items it
refuses. `apply --yes` runs them in order and stops at the first failure; after
they all succeed it plans again to confirm nothing still differs.
Exit code 0 means the configuration converged and nothing needs a restart; 4 means
it converged but a restart is pending for an instance whose configuration changed,
or an instance is not running after `--restart` (pass `--restart` or restart it
yourself; stopped instances are never started); 1 means
something is blocked or still differs. The tool never deletes mods, mod packs or
instances, never replaces a stored mod version and never creates instances or
hosts: see [production rollout](production-rollout.md) for creating servers.

## Roll back a deployment

There is no automatic rollback. Before updating, take a coordinated
[backup](recovery.md#back-up-a-deployment) and note the installed plugin version,
mod pack contents and the desired-state file revision. To roll back:

1. Stop the affected instances through the normal save-preserving procedure.
2. Reinstall the previous plugin version with the same `npm install --save-exact`
   route on the controller, hosts and control clients, and restart the controller
   and hosts.
3. Restore the previous mod pack (a desired-state file from the previous revision
   applied with the reconcile tool, or edit the pack by hand) and restart the
   instances on their existing saves.
4. Verify loaded versions in the web interface and run one supervised transfer.

Saves written by a newer plugin keep their travel histories and recovery journals;
an older plugin that predates those fields ignores them but does not remove them.
Never reset saves or volumes to roll back. Fresh-install acceptance does not
establish compatibility with every historical save or code rollback, so rehearse
the rollback on a copy first.

## Discord bridge

The Discord invite printed to joining players is the controller setting
`surface_export.discord_invite` (see [configuration](configuration.md)). Relaying
chat to Discord uses the separate `@hornwitser/discord_bridge` Clusterio plugin,
which is not part of this repository: install and register it on the controller
like any other plugin, set `discord_bridge.channel_id` (the desired-state file
carries it), and set the bot token with

```text
node tools/clusterio/set-discord-token.mjs --cluster vm
```

which reads `DISCORD_BOT_TOKEN` from the ignored repository `.env` and prints only
the token length. Creating the bot and inviting it to the server is done in Discord;
the tool does not check that Discord accepts the token.
