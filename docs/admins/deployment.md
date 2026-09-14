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

The registry check on **2026-09-14 UTC** found only plugin versions `0.9.77` and
`0.9.82`, with `latest` pointing to `0.9.82`. Its Clusterio peer requirement,
`^2.0.0`, excludes the pinned prerelease `2.0.0-alpha.27`. There is currently no
compatible published plugin for this stack. These guides describe the newer
implementation; `0.9.82` does not provide its upload and save-recovery behavior.

The candidate `0.11.0-beta.1` requires exactly Clusterio `2.0.0-alpha.27` and is
not yet published. Until a compatible release is available, use an accepted
candidate archive as below. Do not bypass npm peer checks with `--force` or
`--legacy-peer-deps` to install the older release.

## Install the npm package

### Accepted candidate archive

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
[acceptance fixture](../../tests/manual/package-install/README.md). If no compatible
accepted archive is available, wait for one or for the published beta.

### Published version

Once a compatible release has been published, check the registry and replace
`VERSION` with its exact version. Run these commands in the Clusterio installation
directory:

```text
npm view @solarcloud7/plugin-surface-export dist-tags
npm view @solarcloud7/plugin-surface-export@VERSION peerDependencies
npm install --save-exact @solarcloud7/plugin-surface-export@VERSION
```

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

Add a compatible `surfexp_gateways` release from the Mod Portal to the instances'
Clusterio mod pack. Use a licensed Factorio Space Age installation with its required
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

The [consumer-install fixture](../../tests/manual/consumer-install/README.md) exercises
Clusterio's published installer and plugin registration with a candidate npm tarball.
Its recorded results identify exact tested versions. Docker-based backup and restart
fixtures are test infrastructure, not an alternative operator installation path.
