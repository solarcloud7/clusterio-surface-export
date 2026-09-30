# History, recovery records and repair

Several records describe a transfer because they answer different questions.
A log is useful evidence, but it is not interchangeable with the record that
authorizes cleanup.

| Record | What it answers | Important limit |
|---|---|---|
| Transaction summary and detail | What was observed, measured and validated? | Detailed evidence can be pruned independently of summaries. |
| Stored export payload | What snapshot can be downloaded or explicitly imported? | Retention can remove the file; a diagnostic-only file is not an importable snapshot. |
| Controller request/recovery journals | Which handoff owns an operation, and what remains unresolved? | Missing or corrupt authority cannot be reconstructed from a similar name. |
| Instance source-retirement journal | Which source identity was committed for retirement? | It records intent before deletion, not proof that the deletion reply arrived. |
| Factorio save storage | Which jobs, identities, locks, holds and receipts existed at the checkpoint? | Loading an older save rolls these records back with the world. |

The source journal lives in the instance data directory as
`surface_export_source_retirements.json`. Its writes are synchronized with storage
on the Linux path. This does not make separate controller files and Factorio saves
one atomic backup. Back up the resolved deployment together, including the worlds,
controller data and instance journals.

## What recovery can conclude

The recovery worker retries the existing cleanup path for retained handoffs when
the participants are available. It does not automatically import another platform.
An acknowledged source deletion permits destination release; a lost reply requires
matching identity and receipt checks. Offline instances, missing receipts and
uncertain identity remain unresolved.

Unresolved intent can reserve both instances indefinitely. This can be operationally
inconvenient, but deleting the record to free the queue discards the information
needed to distinguish a missing reply from an unperformed action. An accepted late
verdict can settle the original operation without relabeling earlier failure evidence.

Startup reconciliation compares the source journal with the loaded world and
controller policy before releasing startup protections. An unavailable controller,
corrupt journal, identity conflict or oversized reconciliation roster can leave
platforms protected. Startup's roster limit is 500; it is a work bound, not a
measured millisecond deadline.

## Investigate and repair

Begin with the operation's diagnostic report and the logs from both instances.
Compare persistent identities and physical state, not just names or displayed
indexes. Establish whether the source survives, whether the destination is held,
and which acknowledgement is missing. Preserve the current worlds and journals
before changing anything.

Restore connectivity or a verified matching journal, then restart the affected
instance through the save-preserving procedure. If evidence cannot resolve the
handoff, operator investigation is required. Neither elapsed time nor absence from
an offline roster proves a platform can safely be deleted or released.

The [administrator recovery guide](../admins/recovery.md) covers policy choices,
snapshot imports and deployment backups. The [manual lab](../../tests/manual/transfer-reliability/README.md)
retains bounded recovery evidence. Journal loss, arbitrary mixed-generation
restoration and hardware failure are not universally solved by those results.
