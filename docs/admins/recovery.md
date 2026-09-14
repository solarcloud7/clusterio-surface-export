# Backups and recovery

Save games contain the playable world. Controller and instance journals contain
transfer decisions that may be newer than a restored save. Recovering only one
of these can create a conflict; a matching platform name is not enough to resolve it.

## Choose how restored saves are treated

In **Surface Export → Settings → Transfer recovery**, set **Platform source of
truth**. The configured value is applied on each instance's next restart. The
page shows the applied value and any outstanding restart requirement.

| Mode | Effect | Example |
|---|---|---|
| Plugin history (default) | Keeps a restored source protected when history records it as transferred away. | Reload an older source save while retaining the platform that already arrived elsewhere. |
| Save game | Accepts a restored source with a fresh persistent identity once no active or unresolved handoff owns it. Another usable copy may exist. | Deliberately reload yesterday's save to recover a destroyed platform. |

Both modes retain active-transfer protections. Neither reconstructs a missing
platform automatically or rewrites a completed operation's history. Controller
unavailability or an unreadable journal does not authorize release. Switching modes
does not undo an already accepted restoration's new identity.

Gateways shows detected conflicts and distinguishes accepted, protected and
unverified states. An offline instance is unverified, not empty. An accepted-copy
warning can be acknowledged locally; this does not remove historical records.

## Restore an available snapshot

1. Preserve the failed operation and inspect the source and destination worlds.
2. Open its transaction details and choose **Restore from snapshot** if available.
3. Review the snapshot date, platform name, destination and warning about an
   existing copy. Confirm once.
4. Follow the new import operation and inspect its validation and recovery result.

An expired or missing payload disables the action with an explanation. Diagnostic
files without a supported replay payload cannot be imported. The controller reads
the stored snapshot and replaces old transfer-routing metadata. The new import
does not delete a source or change the original operation's outcome.

For an authenticated Clusterio CLI installation with the plugin registered:

```text
clusterioctl surface-export restore-snapshot <exportId> <targetInstanceId> <requestId> [platformName]
```

Choose a new request ID for a new recovery action. Retain it when checking an
uncertain submission; do not invent another ID merely because the reply was lost.
Restore requires transfer permission. The surrounding web history and snapshot
listing require their respective read permissions.

## Investigate unresolved cleanup

Preserve both worlds, the transaction diagnostic, controller data and the instance
source-retirement journals before changing anything. Check the operation ID,
persistent platform identities and actual state on both instances. Determine which
action was acknowledged and which remains uncertain.

Repair connectivity or restore a verified matching journal, then restart the
affected instance through the save-preserving procedure. Retained handoffs retry
through the normal cleanup path when participants are available. A missing reply
can mean an action already happened. Do not clear journals, remove holds, delete
surfaces or use a generic unlock to bypass that uncertainty.

Transfer-owned locks and destination holds have no ordinary age-based release.
Only eligible orphan standalone-export locks use the expiry scan. A delayed job
status check does not cancel Lua work. See [records and repair](../technical/records.md)
for the responsibilities of each store.

## Back up a deployment

Use the backup procedure for your Clusterio or clusterio-docker deployment. Retain
its configuration, installed package versions and lockfile, mod packs, gateway mod,
controller data, authentication material, instance saves and plugin recovery journals.
For Docker deployments, also retain the resolved mounts and image identities.
Stop the affected deployment before copying its persistent stores as one checkpoint.
Keep licensed client files and credentials private. Copy backups to independent
storage and check archive integrity.

Resolve the stores used by your actual installation; do not assume the directory
layout or volume count of a test fixture. `docker compose down -v` is not a backup
command: it deletes managed volumes.

Restore into fresh, separately named resources first. Keep the original resources
stopped until the restored worlds, journals, settings, authentication and assets
have been checked. Verify the saved generation, physical cargo and another transfer;
seeing an instance already running is not proof that it loaded the checkpoint.

The [Docker acceptance fixture](../../tests/manual/production-profile/README.md)
automates this sequence for its isolated test installation. Its
[backup/restore evidence](../../tests/manual/transfer-reliability/backup-restore.md)
states the tested boundaries. These are disposable test commands, not a generic
restore tool for an arbitrary production installation.

An earlier save of one destination after release, loss of journals, and arbitrary
mixed-generation backups require separate investigation. Passing a complete
checkpoint restore does not prove those scenarios safe.
