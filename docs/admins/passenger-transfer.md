# Passenger transfer

> **Do not remove or change this behaviour without asking solarcloud7.**

Players aboard a platform that transfers through an in-game gateway travel with it.
Their characters are held on the source instance while the transfer runs. On success,
their carried gear goes to the destination instance with the platform. On any other
outcome they are put back aboard or on the default planet.

## Flow

1. **Transfer pressed.** The gateway dialog checks that the platform is parked and not
   already transferring. It then parks every player physically aboard, connected or not,
   before the transfer starts.
   - A connected passenger leaves the hub. Their character moves to the hidden surface
     `surfexp_passenger_hold`, and the player keeps a bodiless map view of the platform.
     The **Gateway transfer** window shows "Transferring to → *instance*" with an
     **Abort** button that uses the default planet's icon.
   - An offline passenger is moved to the hold surface together with their stored
     character.
   - A connected player aboard without a character (editor, god or spectator
     controller), or whose cursor item cannot be returned to their inventory, is not
     parked. Evacuation at source deletion handles them as it does
     for any other occupant.
2. **Transfer running.** The platform is locked and exported as usual. Parked
   characters are not on the platform, so they are not part of the exported cargo.
3. **Source deletion (success).** Before the source platform is evacuated and deleted,
   the carried gear is taken from each parked character (see [Gear](#gear)). The
   passenger manifest, a list of player names with their carried stacks, is stored in
   the source-deletion receipt. A retried deletion returns the same manifest and does
   not take gear again. After deletion:
   - Connected passengers get the server connect prompt for the destination. They also
     get an "Arrived at *instance*" window with **Join** and **Stay** buttons.
   - The controller stores the manifest on the transfer and sends it with the
     destination's go-live request, including retries.
4. **Destination go-live.** The destination records one arrival per passenger and
   transfer, and records it only once. Each arrival holds the passenger's gear and a
   boarding offer that lasts 10 minutes. Arrivals are served when the player joins,
   straight after go-live for players already connected, and once a second while any
   remain.

## Outcomes

| Outcome | Result |
|---|---|
| Success, prompt accepted | The player joins the destination. Their gear is inserted, and they board the platform if the offer has not expired. |
| Success, prompt declined or **Stay** | The player's own character is restored at the source's default-planet landing pad, without the carried gear. The gear waits on the destination. |
| Success, still on the source 10 minutes after the deletion is confirmed | Same as **Stay**. |
| **Abort** | Allowed while the passenger is in transit. The character is restored at the default planet's landing pad, and the player is left out of the manifest. |
| Transfer fails to start | Every parked passenger is put back aboard at once. A passenger still parked without a transfer job after 5 seconds is also put back aboard. |
| Transfer fails after starting | When the source's transfer lock is released (validation or import failure, census abort, refused start, startup recovery or queue failure), that transfer's passengers are put back aboard. |
| Passenger offline | Their outcome is stored and applied at their next join. See [Offline passengers](#offline-passengers). |

"Landing pad" means the first cargo landing pad of the player's force on the
default planet, or 0,0 when there is none, at the nearest free position.
"Put back aboard" means the player's own character is reattached and enters the
platform again. If the platform no longer exists or is locked again, the player
lands on the default planet instead.

## States

The source instance keeps one record per player in
`storage.surface_export_passengers`.

| State | Meaning | Applied at next join |
|---|---|---|
| `in_transit` | Parked; the transfer is running. | The player is parked again and sees the transit window. |
| `departed` | The carried gear was taken into the manifest. The arrival window, **Stay** and the 10-minute timer start only once the source deletion is confirmed; until then the passenger stays parked, and Abort is refused. | Restored at the landing pad once the deletion is confirmed; parked again before that. |
| `aborted` | Abort was pressed, and restoration is pending. | Restored at the landing pad. |
| `returned` | The transfer failed, and restoration is pending. | Put back aboard, or at the landing pad. |

A record is removed once the player controls their own character again. Connected
players with a pending `aborted` or `returned` record are retried once a second.

Destination arrivals are kept in `storage.surface_export_arrivals`, keyed by player
name and then by transfer.

## Offline passengers

The character of a disconnected player cannot be read, so an offline passenger's
gear is not carried. The passenger is moved to the hold surface with their character
and appears in the manifest with no items.

- If they join the source while the transfer is running, they are parked like a
  connected passenger. Their gear is then carried if the transfer succeeds.
- If they join after the transfer succeeds, they land at the source's landing pad
  with all their gear.
- If they join the destination within 10 minutes of go-live, they board the platform.

## Gear

Two controller settings choose what a passenger carries. The settings are sent to
instances with the gateway configuration and apply to the next transfer.

| Setting | Title | Default | Carries |
|---|---|---|---|
| `surface_export.passenger_carry_armor` | Armor carry over? | `true` | The worn armor, including its equipment grid. |
| `surface_export.passenger_carry_inventory` | Inventory carry over? | `false` | The main inventory, weapons, ammunition and logistic trash. |

Only those stacks are removed from the parked character; everything else stays on
it. Each stack is recorded with its quality, grid, spoilage and other item
properties. Armor is removed last. With inventory carry off, armor whose extra
inventory slots are in use stays on the character, because removing it would spill
those items. The player is told their armor stayed behind.

On the destination, gear is inserted without clearing anything the player already
has:
1. Armor goes in first, so its extra slots are available.
2. Each other stack goes to the inventory it came from, then the main inventory.
3. Stacks that do not fit go to the arrival platform's hub, unless that platform is
   locked or held by another transfer.
4. Anything left, including items this instance cannot hold, stays in the arrival
   record and is retried.

Gear never expires. Only the boarding offer expires after 10 minutes.

The destination never creates a second character. It reattaches an existing
character, and creates one only when the player has none at all. A created character
starts at the default planet's landing position. A player in the map editor whose
stashed controller could hold a character is served after leaving the editor.

Delivery progress is saved per stack. A stack whose equipment grid or other properties
cannot be fully restored on this instance is still counted as delivered, and the
problem is logged, so it is never inserted twice.

### inventory_sync

This plugin does not use inventory_sync. If an instance has an `inventory_sync`
remote interface, passengers carry no gear, so the two systems cannot both move
the same items.

## Top buttons

- **Gateway button** (gateway icon): shown to a player aboard a platform parked at a
  gateway with destinations, and to a player with a passenger record. It opens the
  gateway dialog, or the transit or arrival window for a passenger.
- **Teleport button** (orange gateway icon): shown to admins and to members of the
  `Teleport` permission group. It opens the teleport window, which connects the
  player alone to another instance. Manage group membership with `/permissions`.
  The group is created at server startup.
