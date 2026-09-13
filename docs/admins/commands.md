# Operational commands and permissions

Use the web interface for ordinary transfers and recovery. Commands below are
useful when inspecting an instance or working without the browser. Run them only
against the intended cluster and identify the current platform before mutation.

## In-game commands

| Command | Purpose |
|---|---|
| `/list-platforms` | List current platforms and their local indexes. |
| `/list-surfaces` | List surfaces for inspection. |
| `/transfer-platform <platform_index> <destination_instance_id>` | Request a platform transfer. |
| `/gateway-gui <platform_index>` | Open the parked platform's gateway chooser. |
| `/gateway-transfer <platform_index> <destination_instance_id>` | Request gateway travel to another instance. |
| `/export-platform <platform_index>` | Queue a standalone export; the source remains. |
| `/export-platform-file <platform_index>` | Export through the file-output path. |
| `/transaction-dashboard [limit]` | Open the local in-game history view. |

Most mutation commands require an administrator; read-only commands have their
own registration rules. Development commands additionally check instance debug
mode. Command handlers, rather than an old copied command list, define exact
arguments and permissions:
[registered commands](../../docker/seed-data/external_plugins/surface_export/module/interfaces/commands/).

Locks disable selected entity types and restrict platform access. They do not
freeze all entities or stop belts. `/unlock-platform` is not a way to resolve an
unknown transfer: committed or transfer-owned state can refuse a generic unlock.
Use [recovery](recovery.md) to establish the correct ownership first.

## Clusterio control client

Install/register the plugin in the control client as well as controller and hosts.
Use your installation's authenticated `clusterioctl` configuration:

```text
clusterioctl surface-export --help
clusterioctl surface-export list
clusterioctl surface-export list-transfers
clusterioctl surface-export start-transfer <sourceInstanceId> <sourcePlatformIndex> <targetInstanceId> [forceName]
clusterioctl surface-export restore-snapshot <exportId> <targetInstanceId> <requestId> [platformName]
```

The plugin resolves live identity when starting a transfer; copying an index from
another instance or an old save is not sufficient. Stored export transfer and
snapshot restore are distinct operations. A previously used canonical export ID
cannot authorize another transfer after completion.

[Control commands](../../docker/seed-data/external_plugins/surface_export/control.ts)
define optional file, upload and output arguments. Read their `--help` before
using a file path; an in-game command cannot read arbitrary files on your computer.

## Web and API permissions

| Permission | Access |
|---|---|
| `surface_export.ui.view` | Plugin page and platform tree. |
| `surface_export.exports.list` | Stored export listing/retrieval. |
| `surface_export.exports.transfer` | Transfer and import actions, including snapshot recovery and gateway links. |
| `surface_export.logs.view` | Transaction summaries and details. |
| `core.controller.get_config` | Read controller settings. |
| `core.controller.update_config` | Change controller settings. |

Clusterio roles assign these permissions. A visible page does not imply permission
to submit a mutation. Local-only controller/host hardening fields are configured
by the deployment, not the plugin Settings form.

Definitions: [plugin registration](../../docker/seed-data/external_plugins/surface_export/index.ts)
and [request permissions](../../docker/seed-data/external_plugins/surface_export/messages.ts).
