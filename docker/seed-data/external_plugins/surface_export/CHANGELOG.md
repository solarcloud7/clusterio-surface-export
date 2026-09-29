# Changelog

Versions follow the npm package. Each entry lists what an administrator or player
sees; internal refactors are omitted. Pull request numbers refer to
[clusterio-surface-export](https://github.com/solarcloud7/clusterio-surface-export).

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
- Server destinations orbit closer to the Gateway on straight routes. (#369)

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
