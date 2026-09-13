# Develop the gateway mod

The [data-stage source](../../docker/seed-data/mods-src/surfexp_gateways/) defines
space locations and routes. Runtime discovery, schedules, transfer triggers and
evacuation belong to the save-patched plugin. A data-stage change requires the
instances and clients to reload the changed mod prototypes.

## Build and load

From the repository root:

```powershell
./tools/surface-export/build-gateway-mod.ps1 -SkipClientSync
```

The builder reads the version from `info.json` and writes the corresponding ZIP
under `docker/seed-data/mods/`. Without `-SkipClientSync` it also attempts local
client synchronization. `-Upload` changes the configured mod pack and restarts
hosts; schedule this as a deployment, not a compile-only check. Inspect its
`-ModPack` argument if the installation does not use the development pack.

The default layout is one gateway connected to the five basic planets. Legacy
numbered locations remain defined for save compatibility. The alternative layout
is retained in code but hidden from the plugin Settings form. Changing layout
removes inactive connections, so return platforms to planets before switching.
Instance configuration and the mod pack's startup setting must agree.

## Artwork and verification

The mod's `graphics/icons/` directory contains full starmap artwork and derived
small icons. The web gateway image is derived separately through the registered
downscaler; see [its asset README](../../docker/seed-data/external_plugins/surface_export/web/gateway/assets/README.md).
Retain the source art and regenerate derivatives when it changes.

`lua tests/mods/gateway-layout.lua` checks layouts and referenced artwork without
starting Factorio. It cannot prove native map rendering.

For a deployment comparison, capture stationary platforms before and after:

```text
node tools/surface-export/check-gateway-map.mjs --host 1 --output ci-artifacts/gateway-before.json
node tools/surface-export/check-gateway-map.mjs --host 1 --expect-version <built-version> --baseline ci-artifacts/gateway-before.json --output ci-artifacts/gateway-after.json
```

Use fresh output names and repeat for each host. Inspect the map in a restarted
client as well. The read-only tool checks prototype/routes and current platform
observations; movement during the comparison can legitimately change the result.
