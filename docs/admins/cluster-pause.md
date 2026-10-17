# Cluster pause

The `cluster_pause` plugin in [plugins/cluster_pause](../../plugins/cluster_pause/) pauses every
server of a cluster together while nobody is playing on any of them, and resumes all of them when
a player joins any server. It sets `game.tick_paused` on each server. Factorio's own `auto_pause`
stays off: Surface Export refuses transfers to and from a server with `auto_pause` on.

## Settings

Controller settings, all off by default:

| Field | Default | Behavior |
|---|---|---|
| `cluster_pause.enabled` | `false` | Pause the cluster while nobody plays. Off keeps every server running and resumes a paused cluster. |
| `cluster_pause.countdown_ms` | `30000` | How long the whole cluster must stay empty before pausing begins. |
| `cluster_pause.hold_check_interval_ms` | `5000` | How often holds are re-read and unconfirmed resumes retried. |

Every instance loads the plugin unless its `cluster_pause.load_plugin` is `false`. An instance
that does not load it is never paused and is listed under `notLoaded` in `status`.

## Phases

| Phase | Entered when | Left when |
|---|---|---|
| `running` | Start, a join, `resume`, the feature turned off, or an instance whose state is unknown | Nobody is online on any server |
| `countdown` | Nobody is online | A join, or `countdown_ms` passes |
| `draining` | The countdown ends, or `pause` | A join, `resume`, the feature turned off, an instance whose state is unknown, or no participant holds the pause any more |
| `paused` | Every running instance that reported ready confirmed the pause | A join, `resume`, or the feature turned off |

While the cluster drains or is paused, Surface Export refuses new transfers, imports, exports and
platform resolutions with a message that names the pause. Transfers already admitted, their retries
and recovery are not refused for the cluster pause, and each holds the pause until it finishes.

## Commands

`clusterioctl cluster-pause status|pause|resume [--watch]`, or through
`node tools/clusterio/ctl.mjs [--cluster <name>] [--write] cluster-pause ...`:

- `status` shows the phase, online players per instance, holds, paused and confirmed instances,
  and instances that are unknown, not loaded or not ready. `--watch` prints each change.
- `pause` starts draining at once. It is refused while anyone is online or an instance's state
  is unknown.
- `resume` returns to `running` and unpauses every instance. The countdown starts again after
  the next join or leave.

## Install

The plugin lives outside `docker/seed-data/external_plugins`, because Clusterio loads every
plugin found in its `external_plugins` directory and the development cluster mounts that directory.

1. Build it: `./tools/clusterio/build-plugin.ps1 node -Plugin cluster_pause -OutputDirectory ci-artifacts/<dir>`.
2. Copy the build output as `dist/`, together with `plugins/cluster_pause/module/` and
   `plugins/cluster_pause/package.json`, into the cluster's `external_plugins/cluster_pause/`.
3. Restart the controller and the hosts.
4. Set `cluster_pause.enabled` to `true` on the controller.

## Paused saves

A save made while the game is paused keeps `game.tick_paused`. This includes Clusterio's save when
an instance stops. When such an instance starts with `cluster_pause` loaded, the plugin resumes it
once the instance reports ready, unless the cluster is paused, in which case it stays paused with
the rest. `cluster-pause resume` unpauses every instance that loads the plugin. Without
`cluster_pause`, the game stays paused:

- The instance logs a warning that names the command to resume it.
- `/sc game.tick_paused = false` on that server resumes it.

Separately from the cluster pause, Surface Export checks the game of the source and the destination
each time it admits a transfer, import or export, when a queued transfer starts, and again before a
transfer's import. It refuses when either game is paused or does not report whether it is, whatever
paused it. A transfer refused after its export fails and unlocks its unchanged source; if that unlock
fails, the source stays locked for [recovery](recovery.md).

To remove the plugin, resume first:

1. `cluster-pause resume`, then check with `status` that `paused` is empty.
2. Set `cluster_pause.enabled` to `false`.
3. Remove the plugin and restart the controller and the hosts.

## Passengers

A passenger stays connected to the source server while their platform transfers. They are offline
everywhere only while their client reconnects to the destination. If that takes longer than
`countdown_ms` and nobody else is online, the cluster can pause during it. Their join on the
destination then resumes every server. Passenger arrival deadlines are counted in game ticks, so
none of them runs out while the cluster is paused.
