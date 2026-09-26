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
under `docker/seed-data/mods/`. Packing is byte-reproducible: unchanged source
gives an identical ZIP. The builder refuses to replace an existing ZIP of the same
version with different bytes, because hosts and clients cache mods by version.
Any change to the mod needs a new version. Without `-SkipClientSync` it also attempts local
client synchronization. `-Upload` changes the configured mod pack and restarts
hosts; schedule this as a deployment, not a compile-only check. Inspect its
`-ModPack` argument if the installation does not use the development pack.

The default layout is one gateway connected to the five basic planets. Legacy
numbered locations remain defined for save compatibility. The alternative layout
is retained in code but hidden from the plugin Settings form. Changing layout
removes inactive connections, so return platforms to planets before switching.
Instance configuration and the mod pack's startup setting must agree.

## Publish to the Mod Portal

Create the initial `surfexp_gateways` listing at the [Mod Portal](https://mods.factorio.com/mods/new).
The release helper uses Factorio's [upload API](https://wiki.factorio.com/Mod_upload_API)
to publish updates to that existing listing.

Create an API key in your [Factorio profile](https://factorio.com/profile) with only
**ModPortal: Upload Mods**, and store it as the repository's GitHub Actions secret
`FACTORIO_MOD_PORTAL_API_KEY`. Keep the key out of source files, shell arguments and chat.

After reviewing and committing the ZIP, open **Actions → Gateway mod release → Run workflow**.
Choose the reviewed branch or tag and enter the mod version and ZIP's SHA256. Leave
**Publish** off for validation; enable it to upload the same bytes. The workflow becomes
available after its definition reaches the default branch. The mod version is independent
of the Clusterio plugin's beta version.

You can validate locally without a key:

```powershell
$zip = 'docker/seed-data/mods/surfexp_gateways_0.6.7.zip'
$sha256 = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
python tools/release/publish-gateway-mod.py $zip --version 0.6.7 --sha256 $sha256
```

The helper checks the archive's metadata, required Space Age dependency and hash. It
does not rebuild the ZIP. Repeating a publication is a no-op only when that version's
published hash matches; different bytes require a new version. After an uncertain upload
response, inspect the release page before retrying. Publishing does not change a server's
mod pack or restart servers or clients.

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
