# Development cluster

The root Compose file mounts the plugin checkout and seeds the local test worlds.
Runtime worlds live in Docker volumes; the seed archives are not the running saves.
This is development infrastructure. Install the published plugin into a Clusterio
deployment managed through Clusterio or clusterio-docker.

- [First startup and Steam mod synchronization](../docs/developers/setup.md)
- [Build and update while preserving saves](../docs/developers/workflow.md)
- [Install the plugin into Clusterio](../docs/admins/deployment.md)
- [Backups and recovery](../docs/admins/recovery.md)

Resetting or removing volumes deletes world state. Use disposable fixtures for
destructive experiments; preserve the current development cluster.
