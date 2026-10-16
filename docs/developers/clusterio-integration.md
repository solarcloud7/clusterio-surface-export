# Where Surface Export meets Clusterio

Surface Export is a Clusterio plugin with a save-patched Factorio module. The
separate `surfexp_gateways` data-stage mod defines the space locations, connections
and artwork. It contains no runtime transfer controller.

## Responsibilities and entry points

| Component | Responsibility | Entry point |
|---|---|---|
| Clusterio controller | Authentication, message routing, instance configuration and web hosting | Pinned Clusterio packages/image |
| Surface Export controller | Admission, stored payloads, transaction records, validation and recovery coordination | `controller.ts` |
| Clusterio host | Factorio lifecycle, save patching, connections and RCON | Pinned Clusterio host |
| Surface Export instance plugin | Translate requests/events, upload attempts, parse Lua telemetry, persist instance recovery authority | `instance.ts` |
| Save-patched Lua | Read/restore the world, schedule batches, validate and protect platforms | `module/` |
| Control client | Plugin CLI commands over Clusterio requests | `control.ts` |
| Web plugin | Gateways, logs and settings | `web/` |

Paths are relative to the [plugin root](../../docker/seed-data/external_plugins/surface_export/).
[index.ts](../../docker/seed-data/external_plugins/surface_export/index.ts)
registers the actual entry points, messages, permissions and configuration. There
is no separate Surface Export host-plugin entry point. Follow each pinned base
class's real lifecycle hooks; controller initialization is not an instance
`onStart` hook.

The Clusterio dependency pin is `devDependencies` and the supported range is
`peerDependencies` in the plugin's `package.json`. The
development image revision is separately configured in `.env.example`. Use the
[pinned plugin guide](https://github.com/clusterio/clusterio/blob/v2.0.2/docs/writing-plugins.md)
and the installed package source for upstream behavior.

The plugin package is an ES module (`"type": "module"`), so every relative import
in its TypeScript carries the `.js` extension and the declared entry points name
their compiled file. Each entry point exports a default async function that
Clusterio 2.0 calls once with a plugin context, following its
[2.0 plugin migration guide](https://github.com/clusterio/clusterio/blob/v2.0.2/docs/devs/plugin-migration-to-2.0.md).
The controller, instance and web entry points keep a class for their state:
`ControllerPlugin`, `InstancePlugin` and `WebPlugin` have a private constructor,
a static `fromContext` that creates the instance, runs its `init` and attaches
its `on*` methods to the matching hooks under the plugin name, and a static `get`
that looks the instance up by the controller, instance or control it belongs to.
The ctl entry point attaches `addCommands` to the ctl hooks. Hook handlers from
different plugins run concurrently and a handler that takes longer than 15 seconds
is logged, so hooks are attached only after `init` has finished.
RCON goes through `instance.sendRcon(command, expectEmpty, "surface_export")`,
wrapped once in `LuaInterface`. The web entry point listens to the control
connector for connection events rather than the `controllerConnectionEvent` hook,
which in Clusterio 2.0.1 receives the connector's emit arguments instead of the
event name; 2.0.2 fixes the hook, and the peer range still admits 2.0.1. The CommonJS files are `webpack.config.cjs` and the `test/*.cjs` unit
tests; the tests load the compiled ES modules through `require()` and inject
write failures through `lib/persist-queue` and delays through `lib/delay`.
The `@types/ws` development dependency exists because Clusterio's library resolves
its WebSocket typing to a source file that imports `ws`.

## Example: follow a web transfer

`StartPlatformTransferRequest` enters controller admission, then requests a source
export through the instance plugin. Lua announces completion through Clusterio's
`send_json` channel (`surface_export_complete`, metadata only). The instance reads
the payload over RCON (`get_export_json`) and forwards it for controller storage.
The destination receives `ImportPlatformRequest`; its instance plugin sends the
versioned [upload protocol](upload-protocol.md) over RCON and retains the accepted
job identity. Lua completion supplies validation, then the controller follows the
[ownership handoff](../technical/transfers.md).

The boundary has two forms of asynchronous work: Node awaits messages and I/O;
Lua saves job cursors and resumes on later ticks. Neither transport chunking nor
a JavaScript promise makes one native Lua decode interruptible.

Keep Clusterio's shared library a singleton in the installed process. Plugin
messages use the registered request/event schemas and destination permissions;
calling a detached Link method can lose its receiver. Use the installed lifecycle
and message types in tests rather than approximating their response/error shapes.

## Install through Clusterio

The [consumer installation fixture](../../tests/manual/consumer-install/README.md)
uses `npm init @clusterio` and the normal plugin install path with an accepted
tarball, gateway archive and licensed full client. It creates fresh worlds and
exports actual locale/icons. It is different from seeding this repository's
development cluster or proving an upgrade from an older installation.

For operator installation, use [the npm plugin procedure](../admins/deployment.md).
Upstream install instructions apply to their pinned version; this documentation
does not mirror a changing upstream setup wizard.

## Test a Clusterio core change

Use an existing canonical Clusterio source checkout and its own contribution
instructions to build and test core changes. To use a tested core change with this
plugin, include it in the Clusterio Docker images, then
update `CLUSTERIO_IMAGE_TAG` to the tested immutable revision. Keep the plugin's
Clusterio peer and development dependency pins aligned with that runtime.
Follow the [development deployment procedure](workflow.md) and verify the loaded
image revisions and plugin after restart.
