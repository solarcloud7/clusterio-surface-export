# Production rollout: bring up the four servers

This page names or creates the public cluster's servers on an existing Clusterio
installation and brings them to the desired state. It assumes
[installation](deployment.md) is done on the controller and both hosts, that the
plugin version and the gateway mod version match, and that the desired-state file
`tools/clusterio/desired/vm.json` describes the cluster. The
[reconcile tool](deployment.md#apply-a-desired-state-with-the-reconcile-tool)
configures instances that exist; it does not create them, so steps 1–3 are manual.

## What the desired state already defines

| Server | Starts on | Planets allowed besides its own |
|---|---|---|
| Delta | Nauvis | Maraxsis |
| Sigma | Vulcanus | none |
| Theta | Fulgora | none |
| Omega | Gleba | Aquilo |

Hosts: `clusterio-host-1` and `clusterio-host-2`, two servers each. Every server
reaches every other server through the coloured portals; the controller assigns
the colours. The file also carries the mod pack (Space Age 2.1.20 with
`surfexp_gateways` 0.7.9 and the other mods), each server's public settings,
`debug_mode` off, and the controller's Discord invite and bridge channel.

Host assignment and game ports are not in the file. The public cluster already
runs two servers on each host and keeps them: ports 34100 and 34101 on
`clusterio-host-1`, 34200 and 34201 on `clusterio-host-2`. Two servers on one
host always need two different ports.

## 1. Plugins on the controller and hosts

The controller and both hosts need the same plugin list registered:
`@solarcloud7/plugin-surface-export` (this plugin), `@clusterio/plugin-research_sync`
(the desired state sets `research_sync.load_plugin` on every server) and
`@hornwitser/discord_bridge` if chat is relayed to Discord. Register each with
`clusteriocontroller plugin add` or `clusteriohost plugin add` as described in
[installation](deployment.md#register-the-installed-plugin), then restart the
controller and hosts and confirm both hosts show as connected:

```text
npx clusterioctl host list
```

## 2. Name the instances

The reconcile tool finds servers by name, so each server must carry the exact name
from the desired state before step 3. Run these from the controller's Clusterio
directory.

**Servers that already exist under another name** keep their id, host, port and
saves; only the name changes. Stop the server, rename it, and leave it stopped
until step 5:

```text
npx clusterioctl instance stop fact1
npx clusterioctl instance config set fact1 instance.name Delta
```

The rename was checked on a stopped, unassigned instance of the pinned Clusterio
version; renaming a running server was not tested. The server's directory on the
host keeps its old name, which is harmless.

**Servers that do not exist yet** are created, assigned and given a port:

```text
npx clusterioctl instance create Delta
npx clusterioctl instance assign Delta clusterio-host-1
npx clusterioctl instance config set Delta factorio.game_port 34100
```

`instance create` accepts `--id <number>` if you want fixed ids. Check the result
either way; all four names must appear, each with a host and a port:

```text
npx clusterioctl instance list
```

## 3. Apply the desired state

From a checkout of this repository, with the cluster named in
`tools/clusterio/remote-clusters.local.json`:

```text
node tools/clusterio/reconcile.mjs plan  --cluster vm --desired tools/clusterio/desired/vm.json
node tools/clusterio/reconcile.mjs apply --cluster vm --desired tools/clusterio/desired/vm.json --yes
```

This uploads the mod ZIPs, creates the mod pack, assigns it to every server and
sets the controller, host and instance configuration, including each server's
default planet, the planets it disables and its public server settings. Exit code
4 is expected here (the instances are not running yet). Then set the Discord bot
token as described under [Discord bridge](deployment.md#discord-bridge).

## 4. Create the worlds

A renamed server can keep its existing save; skip this step for it unless you want
a fresh map. A server needs a save before it can start. Create one per server; the
mod pack assigned in step 3 is used for map generation:

```text
npx clusterioctl instance save create Delta world.zip
```

A new save always starts on Nauvis. Delta is a normal Nauvis start. Sigma, Theta
and Omega start their players on Vulcanus, Fulgora and Gleba, so each of those
worlds must have that planet's surface generated with a safe arrival area near
0,0 before players join; the plugin does not generate it (see
[planets on each instance](configuration.md#planets-on-each-instance)). Prepare
the world with the game's own tools: start the server, use an administrator
account and the map editor or console to generate and clear the planet, then
save and stop. Note what you did so it can be repeated. A misspelt planet name
blocks startup recovery and shows in the web interface; an unprepared planet does
not, so check the arrival area yourself before opening the server. There is no
tool for this step yet.

## 5. Start and verify

```text
npx clusterioctl instance start Delta
```

Start the other three the same way. Then, per server:

- `npx clusterioctl instance list` shows `running` and Factorio `2.1.20`.
- The Surface Export page's Gateways tab shows all four servers with a portal
  colour each and no quarantined platforms.
- `npx clusterioctl instance export-data Delta` once, so the web interface has
  item icons and locale for the mod pack.
- Join each server from the Factorio server browser; the join message prints the
  Discord invite.
- Move one disposable platform from one server to another through a portal and
  back, and confirm it arrives with its cargo. Delete it afterwards.

Re-run `reconcile.mjs plan` at the end: it should report nothing to change.

## Later changes

Edit the desired-state file, re-run `plan`, then `apply --yes`; pass `--restart`
when the plan says a running server must restart to pick up a setting. Version
updates follow [update an existing installation](deployment.md#update-an-existing-installation).
