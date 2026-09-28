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
| Plugin history (default) | Keeps a restored copy protected when history records it as transferred away, and quarantines any copy whose platform history another server holds. | Reload an older source save while retaining the platform that already arrived elsewhere. |
| Save game | Accepts a restored copy automatically only when the server recorded as holding the platform's current copy answers that it no longer has it. A copy that another server still holds, or that cannot be checked, is quarantined as in Plugin history. | Reload yesterday's save on both servers to recover a destroyed platform. |

Both modes retain active-transfer protections. Neither reconstructs a missing
platform automatically or rewrites a completed operation's history. Controller
unavailability, a lost reply or an unreadable journal or registry does not
authorize release. Switching modes does not undo an already accepted restoration.
If the registry file is missing while transfers or stored exports carry platform
histories, the controller treats it as unreadable: restore the file from a backup.

## Platform history and quarantine

Every platform carries a platform history (lineage) that moves with it on each
transfer, plus a generation that increases on each transfer. The controller file
`surface_export_lineage_registry.json` records which server holds each history's
current generation. At startup each server compares its platforms with that record.
A copy that cannot be proved current is quarantined: it stays hidden and inactive,
and players aboard stay where they are. The rest of the server starts normally.

| Reason | Meaning |
|---|---|
| `duplicate` | Another server holds the current copy of this platform. |
| `rollback_other` | The server recorded as holding the current copy answered that it no longer has it. |
| `unverified` | The server recorded as holding the current copy did not answer (offline, restarting or lost reply). |
| `in_transit` | A transfer or resolution of this platform is still unresolved. |
| `unresolved_handoff` | An unresolved transfer owns this source platform. |
| `stale_self` | This server later received a newer copy of this platform. |
| `ahead_of_registry` | This copy is newer than the controller's record. |
| `unregistered` | This copy has been transferred before, but the controller has no record of it. |
| `legacy_unclassified` | The platform predates platform history and matches a platform this server transferred away. |
| `duplicate_local` | Two platforms on this server carry the same platform history. |
| `no_identity` | The platform has no hub, so it has no stable identity. |
| `reconcile_error` | Startup could not verify the platform. |

A quarantine is not released by a restart, `/unlock-platform`, a lock timeout or
an export. An `in_transit` or `unresolved_handoff` quarantine is settled by its
own transfer: a rollback releases the copy and a completed transfer deletes it.
Other quarantines stay until an administrator resolves them.

## Resolve a quarantined copy

Gateways lists quarantined copies and restored copies that remain protected. Each
entry shows the stored reason and a live re-evaluation. Actions follow the live
result, so a copy quarantined while its holder was offline becomes decidable once
that server answers. **Check again** repeats the evaluation. Hints such as a matching
hub number or transfer history are labelled as hints; platform names are never used.
Resolving needs the `surface_export.recovery.resolve` permission.

| Live result | Actions |
|---|---|
| `duplicate` | **Keep this copy**: the other server's copy is saved as a snapshot and deleted, then this copy becomes current and is released. **Keep the other copy**: this copy is saved as a snapshot and deleted. |
| `rollback_other`, `unregistered`, `stale_self`, `ahead_of_registry` | **Adopt this copy**: the controller record moves to this copy and it is released. **Delete this copy**: snapshot, then delete. |
| `legacy_unclassified` | **Treat as a new platform**: the copy gets a new platform history and is released. **Delete this copy**. Only **Delete this copy** is offered when the copy is a retired transfer source or transfer history names it. |
| `duplicate_local` | **Delete this copy**. |
| `no_identity` | None while the platform has no hub. Once it has a hub, **Check again** lists the actions for its live result. |
| Startup could not verify it (`reconcile_error`) but the live result matches the record | **Release after inspection** or **Delete this copy**. |
| `unverified`, `in_transit`, `unresolved_handoff` | None. The entry states what must happen first. |

Every action re-checks the registry, the other server's answer and in-flight
transfers when it is submitted, and is refused if anything changed or is uncertain.
**Adopt this copy** is also refused unless every server that could hold a live copy
answers that it has none.
The confirmation shows how many players are aboard the copy that will be deleted.
They are moved to the default planet by the normal source-deletion path; the count
does not block the action.

Deletion first stores a snapshot of the copy with the other exports. **Snapshots are
not pinned**: the normal export limit can remove one later, like any stored export.
Download or restore it promptly if you may need it. A snapshot cannot be sent as a
transfer. If the snapshot fails, the copy returns to its previous protection. The
deletion itself uses the transfer source-deletion path, which records the source
retirement and a deletion receipt. A copy that was already retired by a transfer is
deleted under that transfer's retirement.

Each resolution has a request ID. Progress is saved in the registry file after each
confirmed step. If a reply is lost or a server is offline, submit the same request
ID again: the resolution continues from its last confirmed step and never starts a
second action. A different action needs a new request ID.

**Abandon** ends a resolution that has not yet deleted a copy or changed the
registry, for example a deletion that keeps being refused. The copy returns to its
previous protection, and the other copy of a **Keep this copy** resolution is
unlocked. A resolution that has already deleted a copy or changed the registry
cannot be abandoned; retry it with the same request ID to finish it.

A transfer to a server that already holds any copy of the platform, including a
quarantined one, is refused before it starts. Resolve that copy first.

For an authenticated Clusterio CLI installation:

```text
clusterioctl surface-export conflicts [instanceId]
clusterioctl surface-export resolve-platform <instanceId> <platformIndex> <platformUid> <action> <requestId>
clusterioctl surface-export abandon-resolution <requestId>
```

`conflicts` prints the entries as JSON, including the offered `actions`. `action` is
one of `keep_this`, `keep_other`, `adopt`, `stale_copy`, `new_platform` or `release`,
and must be offered for that copy.

A seed reset archives the instance's recovery journal but leaves the controller
registry, which other servers also use. Platforms in a freshly reset save start new
platform histories and start normally. Old registry entries for the replaced save
remain and are not used by that save's platforms.

Gateways also shows accepted and protected restored copies. An offline instance is
unverified, not empty. An accepted-copy warning can be acknowledged locally; this
does not remove historical records.

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
