# Set up the development environment

Use the canonical checkout on a local branch. Do not create another checkout or
git worktree for this workflow: the development containers mount this directory.
Do not replace mounted directories with junctions or symlinks.

## Prerequisites

- Docker with Linux containers and Compose v2.
- PowerShell 7 for repository wrappers, and Node 24 with npm for tooling.
- A Factorio account entitled to Space Age for the full Linux client used to
  export locale/icons. Keep its credentials out of Git and diagnostic reports.
- Available development ports: controller 8080, game ranges 34100–34109 and
  34200–34209, unless deliberately changed in the Compose configuration.

The root Compose file is a development environment with writable plugin mounts
and seeded test worlds. Administrators instead [install the plugin into Clusterio](../admins/deployment.md).
Its published ports and seed visibility settings need deliberate network access
restrictions; a localhost URL alone does not make a service private.

## First startup

Run from the repository root. Copy `.env.example` only if `.env` does not already
exist, then set `INIT_CLUSTERIO_ADMIN` and the required Factorio credentials.
Keep the checked-in image pin unless testing a deliberate upgrade.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
docker volume create factorio-client-2117
./tools/clusterio/build-plugin.ps1 -Target all
./tools/surface-export/build-gateway-mod.ps1 -SkipClientSync
docker compose pull
docker compose up -d
node tools/clusterio/ci-await-seeding.mjs
node tools/tests/cluster-readiness.mjs --runtime
```

Running worlds and Clusterio state live in named volumes. The fixture saves in
the repository are inputs, not the current world.
If readiness fails, inspect its reason before resetting any data.

Open [the controller](http://localhost:8080). For local login,
`./tools/clusterio/get-admin-token.ps1` prints a credential for the configured admin;
keep it private. Container names are `surface-export-controller`,
`surface-export-host-1` and `surface-export-host-2`. Their `clusterio-*` hostnames
are different names used inside the network.

## Full Factorio client for icons

The development environment intentionally provisions the full Linux Factorio
client on **host 1** for Clusterio's `instance export-data` operation. It includes
the graphics needed to generate the web interface's icon spritesheets; the
headless package does not. This is separate from the Steam client you use to play.

The root Compose file sets `SKIP_CLIENT=false` on host 1 and mounts the external
`factorio-client-2117` volume at `/opt/factorio-client`. Host 2 sets
`SKIP_CLIENT=true`. Do not reuse or modify another cluster's client volume.

Having the full client installed does not make a server process render the GUI.
For UI screenshots, run the graphical client with a display and a disposable
save. Factorio's [`take_screenshot` API](https://lua-api.factorio.com/2.1.17/classes/LuaGameScript.html#take_screenshot)
does nothing when Factorio runs headless.

## Connect a Steam client

Use the server's exact Factorio version and matching mods. The offline seed-sync
tool copies repository seed archives; it does not resolve the live mod pack or
certify compatibility of unrelated client mods.

```powershell
./tools/clusterio/sync-client-mods.ps1 -DryRun
./tools/clusterio/sync-client-mods.ps1
```

If a newer installed version shadows a selected seed, inspect the dry run before
using `-PruneShadowing`. General sync preserves `mod-list.json` and client-only
mods. The gateway builder has a separate client-sync path for the version it
builds. Fully restart Factorio after changing mod archives, then join host 1 at
`localhost:34100` or host 2 at `localhost:34200`.

## Change and verify code

The [development workflow](workflow.md) separates isolated checks from deployment
to the running cluster. The [testing guide](testing.md) explains which commands
operate on existing worlds and which create disposable resources.

For under-the-hood work, start with [Clusterio integration](clusterio-integration.md).
Human guides do not require an agent skill or a personal shell profile.
