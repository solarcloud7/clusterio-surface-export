# Transfer platforms

Surface Export moves Space Age platforms between Factorio instances managed by
Clusterio. Your administrator supplies the servers, compatible mod packs and access
permissions. Start with a disposable platform before transferring a valuable one.

## Use the web map

1. Open **Surface Export → Gateways** in the Clusterio web interface.
2. Select a platform on its source instance and choose **Transfer**.
3. Choose the destination instance and, if needed, its arrival location. Confirm once.
4. Follow the platform on the route. A queued platform waits near the source;
   movement and status labels show the operation's progress.
5. Open **Transaction Logs** and select the operation to inspect its result.

The dialog closes after submission. Errors appear as notifications; the map and
history provide ongoing progress. Animation illustrates state, not measured travel
distance or a promise about completion time. Do not submit another import simply
because a reply is delayed.

**Completed** means the controller received successful destination validation,
confirmed its temporary protection, and received source-deletion and
destination-release acknowledgements. **Cleanup needs attention** means an
ownership question remains unresolved. Ask an administrator to inspect it before
manually unlocking or deleting anything.

## Travel through an in-game gateway

The default layout has one Transfer Gateway per instance, connected to Nauvis,
Vulcanus, Gleba, Fulgora and Aquilo. It is a space location, not another planet.
Your administrator configures which other instances it connects to.

Send a platform to the gateway and wait until it is parked. Choose the destination
in the arrival dialog. An administrator can also open the chooser with
`/gateway-gui <platform_index>` or transfer directly with
`/transfer-platform <platform_index> <destination_instance_id>`.
Use `/list-platforms` for current indexes. An instance ID is not a host number;
platform names are labels, and indexes are local locators, not persistent identity.

Players aboard travel with the platform. When Transfer is pressed, your character
is held and you watch the platform from the map. The transfer window offers
**Abort**, which keeps you on this instance's default planet. On success you get the
connect prompt for the destination. Join it to board the platform there with your
carried gear. Armor is carried by default. If you stay, you land on the default
planet, and your carried gear waits for you on the destination. If the transfer
fails, you are put back aboard. See [passenger transfer](../admins/passenger-transfer.md)
for every outcome and the gear settings.

Abandoned character bodies left aboard are evacuated to the instance's configured
default planet (Nauvis by default) before the source is deleted. Failed evacuation
prevents deletion and requires recovery. Switching servers alone, without a
platform, uses the teleport button.

## Board another platform on this server

In Remote View, while you are physically aboard a platform, a **Boarding** panel
appears beneath the platform sidebar listing the other platforms stopped at the
same space location. Press **Board** on a row. Both platforms must be enabled,
at the same space location, and free of transfer or recovery protections. Loading,
unloading and waiting states do not otherwise prevent boarding. Paused thrust counts
as disabled. With no eligible platform the panel shows `None`.

The destination is checked again when you press Board. Boarding uses Factorio's
player movement operation; it does not export or reconstruct your inventory. This
control requires the companion mod's **Allow platform boarding** map setting.

A second panel beneath the Surfaces sidebar shows this instance's default planet
and the planets unavailable on it. Unavailable planets are hidden from the surface
list and locked against new journeys. Players reaching an unavailable planet are
returned to the configured default planet.

## Export or import a copy

**Export JSON** in an instance's platform list downloads a snapshot and retains
the source platform. **Import** uploads a supported snapshot to a destination and
creates a new platform. These are copying operations, unlike a transfer.

**Restore from snapshot** in transaction details creates a separate recovery
import when a usable stored payload remains. Another copy may already exist;
confirm the destination with your administrator. A diagnostic report alone is
not necessarily an importable snapshot.

## Map controls and warnings

Host, instance and platform selectors help locate platforms. Reset reframes the
map and clears saved positions. Positions and line style are local to your browser.
Editing connections requires transfer permission; changes take effect when saved.
A failure while saving several connections can leave only some changes applied.

Save-recovery warnings explain whether an older source was accepted as a new copy
or kept protected. Offline or uncertain identity is **unverified**, not proof that
the platform is missing. Acknowledging an accepted-copy warning only hides that
notice in your browser; it does not change transfer history or ownership.

Continue with [reading transaction logs](transaction-logs.md). Administrators can
use [configuration](../admins/configuration.md) and [recovery](../admins/recovery.md).
