# Changelog

Versions follow the npm package. Each entry lists what an administrator or player
sees; internal refactors are omitted. Pull request numbers refer to
[clusterio-surface-export](https://github.com/solarcloud7/clusterio-surface-export).

## 0.12.0-beta.5

Requires Clusterio `^2.0.0` (built and tested on `2.0.2`), Factorio Space Age `2.1.22`
and the `surfexp_gateways` mod `0.7.11`.

- The web map draws each server's planet icons from the mod pack that server runs.
  Before, every icon came from the controller's default mod pack, so a default pack
  without exported icons showed "?" on every planet. A missing icon's tooltip now names
  the pack. (#427)
- Built and tested on Factorio 2.1.22, with maraxsis 1.39.22, PlanetsLib 2.0.10,
  FluidMustFlow 1.5.1 and SpidertronPatrols 2.7.1 in the development pack. (#425)

## 0.12.0-beta.4

Requires Clusterio `^2.0.0` (built and tested on `2.0.2`), Factorio Space Age `2.1.20`
and the `surfexp_gateways` mod `0.7.11`.

- `surfexp_gateways` 0.7.11: every planet, modded planets included, has a route to the
  Gateway, so a platform on any server's planet can fly there. Planets sit on a ring
  around the Gateway; the startup setting `surfexp-ring-layout` turns that off. (#423)
- Surface Export takes part in the new `cluster_pause` plugin when it is loaded: it holds
  the pause while transfers, passengers, admissions or startup recovery are in flight,
  and refuses new transfers and imports while the cluster pauses. Without
  `cluster_pause`, nothing changes. (#422)

## 0.12.0-beta.3

Requires Clusterio `^2.0.0` (built and tested on `2.0.2`), Factorio Space Age `2.1.20`
and the `surfexp_gateways` mod `0.7.10`.

- A platform whose foundation reaches beyond the area the destination server had
  generated no longer arrives with missing foundation. The import generates every
  chunk the platform covers before it places tiles, a bounded number per tick. (#418, #419)
- Transfer validation counts foundation and other tiles per chunk. A transfer that
  loses tiles now fails validation at the `tiles` stage instead of reporting success.
  Extra tiles on the destination are reported but accepted. (#418)

## 0.12.0-beta.2

Requires Clusterio `^2.0.0` (built and tested on `2.0.2`), Factorio Space Age `2.1.20`
and the `surfexp_gateways` mod `0.7.10`.

- Each player sees the name of the server they are on as a small label at the top
  right, just left of the research and minimap column. (#410)
- With `surfexp_gateways` 0.7.10, the Gateway's name on the star map sits above the
  portal names instead of level with Purple and Blue. (#411)
- Built and tested on Clusterio 2.0.2. Installs on 2.0.1 remain supported. (#412)

## 0.12.0-beta.1

Requires Clusterio `2.0.1` (peer range `^2.0.0`), Factorio Space Age `2.1.20` and the
`surfexp_gateways` mod `0.7.9`. Earlier plugin versions do not load on Clusterio 2.0,
and this version is not supported on the 2.0.0 alphas.

### Clusterio 2.0

- The plugin runs on the stable Clusterio 2.0 release. Node.js 22 or newer is
  required. The package is an ES module and its controller, instance, ctl and web
  entry points are the functions Clusterio 2.0 calls with a plugin context, so
  Clusterio no longer logs a deprecation warning for each of them at startup. Nothing
  changes for administrators or players.
- The web interface keeps listening to its controller connection directly to
  resubscribe after a reconnect, because Clusterio 2.0.1's web connection hook does
  not pass the event name.
- The five `surface_export.*` permissions are declared on the plugin itself. Roles
  keep their grants.
- The Gateways and Transaction Logs pages resubscribe after the browser reconnects
  to the controller. Clusterio 2.0's web interface no longer tells a class-based
  plugin which connection event fired, so the plugin listens to the connection
  itself.
- Passengers carry no gear when a `player_sync` remote interface is present, the
  Clusterio 2.0 name of `inventory_sync`; the old name is still honoured.
- The repository tools read the clusterioctl token from either the Clusterio 2.0
  `ctl.controller_token` key or the alpha `control.controller_token` key, and the
  ctl wrapper keeps `config` (formerly `control-config`) local to the development
  cluster. The deployment wrapper compares the served web bundle by file name,
  because Clusterio 2.0 advertises it without the manifest's `static/` prefix.
  Seed instances and the production-profile lab refer to `player_sync`.

## 0.11.0-beta.6

Requires Clusterio `2.0.0-alpha.27`, Factorio Space Age `2.1.20` and the
`surfexp_gateways` mod `0.7.9`.

### Platforms that travel between servers

- Every platform carries a travel history (a travelling ID and a trip counter) that
  moves with it through transfers. (#383)
- When a server loads an older save, only the platforms whose history is uncertain
  are quarantined; the rest keep working. Startup recovery no longer refuses every
  export because of one restored platform. (#383)
- A **Quarantined Platforms** list on the Gateways page shows each quarantined copy
  beside the copy the records call current, with the server, trip count, how long
  that server has been online and the players aboard. Each side has **Delete**;
  the centre has **Keep both** (a duplicate gets a new platform history and
  identity) or **Keep**. Confirmations name the server and the platform only. (#385)
- A quarantine is announced once: a browser notification while the page is open,
  and one in-game chat line to the first administrator who joins. The Surface Export
  sidebar entry and the Gateways tab show a red count while anything waits. (#385)
- Quarantined platforms stay listed under their server on the map with a red
  highlight. Transfer history has a platform filter, most recently active first. (#385)
- `clusterioctl surface-export conflicts`, `resolve-platform` and
  `abandon-resolution` for command-line resolution; the
  `surface_export.recovery.resolve` permission gates resolutions. (#383)
- A transfer to a server that already holds any copy of the platform is refused
  before it starts. (#383)

### Portals and routing

- Four coloured portals (Blue, Green, Orange, Purple) orbit the Gateway. The
  controller assigns each server a colour; a platform scheduled to a portal
  transfers to that server automatically and continues its schedule there. Manual
  gateway links and the four-gateway layout mode are gone. (#372, #373, #375)
- Portal colours are kept while a server's plugin is off. (#382)
- Portals orbit close to the Gateway on straight routes. (#369, #375)

### Servers and players

- The in-game Discord button is gone; the invite is printed in the join message
  and configured by `surface_export.discord_invite`. (#370)
- Instance names are used consistently in the web interface and tools. (#371, #376)

### Operations

- Stored validation results are capped. (#382)
- Startup recovery that is blocked fails boot checks explicitly; seed resets archive
  recovery history instead of discarding it. (#377, #379)
- Scripted instance starts are bounded, a hung start is diagnosed and retried once. (#380)

## 0.11.0-beta.5

- Production desired state for the four-server cluster and the reconcile tool. (#367)
- Isolated Lua mutation checks; stale workflow locks are reclaimed. (#368)

Earlier versions have no changelog; see the git history.
