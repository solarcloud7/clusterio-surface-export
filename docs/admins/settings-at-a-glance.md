# Settings at a glance

The settings a Surface Export cluster sets, with the values the public cluster uses.
Those values live in one desired-state file,
[`tools/clusterio/desired/vm.json`](../../tools/clusterio/desired/vm.json), which
`node tools/clusterio/reconcile.mjs plan|apply --cluster <name> --desired <file>`
applies. Every plugin field is described in [configuration](configuration.md).

## Every server

Factorio server settings, set in each instance's `factorio.settings`:

| Setting | Value | Why |
|---|---|---|
| `auto_pause` | `false` | Required. Surface Export refuses transfers to and from a server that pauses when nobody is on it. Servers therefore keep running while empty. |
| `allow_commands` | `admins-only` | Only admins can use console commands, including the plugin's admin commands. |
| `require_user_verification` | `true` | Players must sign in with a Factorio account. |
| `autosave_interval`, `autosave_slots` | `10`, `5` | Autosave every 10 minutes and keep 5 autosaves. |
| `non_blocking_saving` | `true` | Saves without stopping the game on Linux servers. |
| `name`, `description`, `tags`, `visibility` | per server | What the Factorio server browser shows. Public cluster names start with "Clusterio: PlatformExport". |

## Each server's planet

Each server plays on one planet. These are instance settings; restart the instance
after changing them ([planets on each instance](configuration.md#planets-on-each-instance)).

| Server | `surface_export.default_planet` | `surface_export.disabled_planets` |
|---|---|---|
| Delta | `nauvis` | `vulcanus,fulgora,gleba,aquilo` |
| Sigma | `vulcanus` | `nauvis,fulgora,gleba,aquilo,maraxsis` |
| Theta | `fulgora` | `nauvis,vulcanus,gleba,aquilo,maraxsis` |
| Omega | `gleba` | `nauvis,vulcanus,fulgora,maraxsis` |

Also on every server:

| Setting | Value | Why |
|---|---|---|
| `surface_export.debug_mode` | `false` | The default `true` adds diagnostic output and development tools that players should not see. |
| `research_sync.load_plugin` | `true` | Research is shared across the servers. |

## Controller

| Setting | Value | Why |
|---|---|---|
| `surface_export.platform_source_of_truth` | `plugin_history` | A restored platform copy whose travel history is uncertain waits for an administrator. See [recovery](recovery.md). |
| `surface_export.discord_invite` | invite link | Printed in chat to every player who joins. |

## Hosts

| Setting | Value | Why |
|---|---|---|
| `host.public_address` | the host's public DNS name | The address players use to reach that host's servers. |

## Mods

| Item | Value | Why |
|---|---|---|
| `surfexp_gateways` in the mod pack | the version in the [release's compatibility table](https://github.com/solarcloud7/clusterio-surface-export/releases) | The plugin and the gateway mod are released as a pair. |
| `surfexp-platform-boarding` | `true` | Players may board another platform at the same location. See [mod map setting](configuration.md#mod-map-setting). |
