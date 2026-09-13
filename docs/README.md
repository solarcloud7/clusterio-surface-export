# Documentation

Start with the guide for the task you are doing. These pages describe the checked-in
implementation; release and experiment records identify the exact artifacts tested.

| Reader | Start here | Continue with |
|---|---|---|
| Player or user | [Transfer platforms](users/transfers.md) | [Read transaction logs](users/transaction-logs.md) |
| Administrator | [Host a packaged deployment](admins/deployment.md) | [Configuration](admins/configuration.md), [commands and permissions](admins/commands.md), [backups and recovery](admins/recovery.md) |
| New developer | [Set up the environment](developers/setup.md) | [Build and deploy](developers/workflow.md), [testing](developers/testing.md), [fixtures and seeds](developers/fixtures.md) |
| Clusterio engineer | [Plugin integration boundaries](developers/clusterio-integration.md) | [Upload protocol](developers/upload-protocol.md), [timing instrumentation](developers/timing-instrumentation.md) |
| Product owner or technical reader | [Transfer lifecycle](technical/transfers.md) | [Batching and queues](technical/batching.md), [validation](technical/validation.md), [timing](technical/timing.md), [records and repair](technical/records.md) |

For maintenance, see [diagnostics](developers/diagnostics.md),
[lint checks](developers/lint.md), [gateway mod](developers/gateway-mod.md), [CI and releases](developers/ci.md) and
[contributing](developers/contributing.md). Security reports use the
[private reporting procedure](../SECURITY.md).

Detailed experiment results stay [beside the tests](../tests/README.md), including
original failures, versions, fixture sizes and limitations. Agent instructions
remain outside this directory and are not prerequisites for these guides.
