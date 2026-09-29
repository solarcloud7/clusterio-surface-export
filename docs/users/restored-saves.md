# When a server loads an older save

Surface Export moves space platforms between servers. Each server saves its own
world separately, so an administrator can restore one server to an earlier save
without touching the others. This page explains what that means for platforms
that travel, what Surface Export does about it, and what players and
administrators see. The administrator procedures are in
[backups and recovery](../admins/recovery.md).

## The problem

A platform that travels should exist in exactly one world at a time. A transfer
creates the platform on the destination server and then deletes it from the
source. Restoring one server to an earlier save rewinds only that server, so it
can bring back a platform that has already left.

For example, with two servers called Delta and Sigma:

| Time | Delta | Sigma |
|---|---|---|
| 10:00 | Autosave. The platform *Ark* is parked here. | |
| 10:30 | *Ark* leaves for Sigma and is deleted here. | *Ark* arrives. |
| 11:00 | Delta crashes and is restored to its 10:00 save. *Ark* is back. | *Ark* is still here. |

Now there are two copies of *Ark*, with two copies of its cargo. Players could fly
both, and the duplicated items would spread through the game. The opposite can
happen too: if Sigma is restored to a save from before *Ark* arrived, *Ark* is gone
from Sigma and was already deleted from Delta.

Names cannot settle this. Players can give different platforms the same name, and
can rename them.

## What Surface Export does

**Every platform has a travel history.** When a platform is first seen, it gets a
permanent ID, like a passport. The ID travels with the platform on every transfer,
and a trip counter goes up each time a transfer completes. The controller keeps a
record of which server holds each platform's latest trip.

**Every server checks its platforms when it starts.** It compares each platform's
ID and trip counter with the controller's record and, when needed, asks the other
servers whether they still have that platform.

- **Clear cases continue automatically.** A platform that matches the record, or a
  new platform the record has never seen, simply starts working.
- **Unclear cases are set aside, one platform at a time.** A platform that might be a
  duplicate, or whose current copy cannot be confirmed, is quarantined: it is hidden,
  paused and cannot be transferred. The rest of the server works normally.
- **Nothing is guessed.** If another server is offline or does not answer, the
  platform waits in quarantine rather than being accepted or deleted. An
  administrator decides once the answer is available.

In the example above, when Delta restarts, the controller's record says Sigma holds
*Ark*'s latest trip and Sigma confirms it still has *Ark*. Delta's copy is
quarantined as a duplicate, and an administrator chooses which copy to keep.

Before this protection existed, a server that loaded an older save could refuse
every transfer until someone repaired it by hand. Now only the uncertain platforms
wait.

## What players see

- **A quarantined platform** is hidden and inactive. Players aboard stay where they
  are until an administrator resolves it.
- **If an administrator deletes a copy**, players aboard it are moved to that
  server's home planet, as happens when a transfer deletes a source platform.
- **A transfer can be refused** with "resolve the quarantined copy first". This
  happens when the destination server still holds a quarantined copy of the same
  platform. The platform stays where it is and nothing is lost. Ask an
  administrator to resolve the quarantined copy, then transfer again.

## What administrators decide

The **Surface Export** entry in the sidebar shows a red count while anything waits
for a decision, on every page of the web interface, and so does the **Gateways** tab.
The **Quarantined Platforms** list has one row per waiting copy: the quarantined copy
on the left, the copy the records call current on the right. Each side shows the
platform name, its trip count, which server holds it and how long that server has
been online, so a server that was just restored from an old save stands out. The
side with more trips is green. The map highlights the same platforms in red.

Each side has a red **Delete** button that removes that side's copy. The centre
button keeps instead:

| Situation | Choices |
|---|---|
| Two servers hold a copy of the same platform | **Delete** the left copy, or **Delete** the right copy, or **Keep both**: the older copy becomes a separate platform, so everything aboard it then exists twice. |
| The left copy is the only one left, or its record is missing or out of date | **Delete** it, or **Keep** it (it becomes the current copy). |
| The platform is older than travel histories and may be a copy of one that left | **Delete** it, or **Keep** it as a new platform. When records show it already left, only **Delete** is offered. |

Safeguards apply to every choice:

- **A snapshot is saved before any copy is deleted.** It can be downloaded or
  restored later, but it is not kept forever: the normal export limit removes older
  snapshots in time.
- **Everything is checked again when the button is pressed.** If anything changed,
  or a server cannot be reached, the action is refused and nothing happens.
  Keeping the only copy left needs every other server to confirm it has no copy, so it is
  refused while any server is offline or has the plugin turned off.
- **A lost reply is safe to retry.** Retrying continues where the action stopped and
  never repeats a deletion.
- **A stuck action can be abandoned** before it deletes anything or changes the
  record. The platform then stays protected exactly as it was before.

## Choose how restored saves are treated

Administrators choose one setting for the whole cluster:

- **Plugin history** (default): the travel records win. Every uncertain platform
  waits for an administrator.
- **Save game**: a restored save is trusted when that is safe. If the server that
  holds a platform's latest trip confirms it no longer has it, the restored copy is
  adopted automatically. Duplicates are still quarantined.

## Limits

- Surface Export does not rebuild a platform that no save contains. To recover a
  lost platform, restore its snapshot from the stored exports.
- Snapshots taken before a deletion expire with other stored exports. Download
  anything you may need.
- Exports stored before travel histories existed cannot be transferred. Export the
  platform again to transfer it.
- Saves and the controller's record belong together. When backing up or restoring,
  keep the controller data with the saves; see
  [backups and recovery](../admins/recovery.md).
