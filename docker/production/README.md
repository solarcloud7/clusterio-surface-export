# Packaged deployment profile

`compose.yml`, `settings.json` and `provision.mjs` define the packaged controller
and two-host deployment. The profile uses built images rather than source mounts
and creates fresh worlds through Clusterio's CLI.

Follow [installation and updates](../../docs/admins/deployment.md),
[configuration](../../docs/admins/configuration.md) and
[backup/recovery](../../docs/admins/recovery.md).
The [acceptance fixture](../../tests/manual/production-profile/README.md) retains
versioned results and the exact tested resource/restore scope.
