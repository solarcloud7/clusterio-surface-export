# Transfer a platform

Use a running cluster prepared through [Docker setup](../docker/README.md). Begin with a disposable test platform; see the [production gates](../README.md#before-production) before moving valuable saves into service.

## Through the web UI

1. Open **Surface Export -> Gateways**.
2. Select the source platform and its destination, then confirm the transfer.
3. Follow its queued and active state on the map.
4. Open **Transaction Logs** and select the operation. Check its outcome, validation evidence, and cleanup or recovery result.

Completed means the controller received successful destination validation and source deletion acknowledgement. A validation failure follows recovery. **Cleanup failed** is unresolved; inspect the diagnostic report and both instances before retrying.

## In game

Use `/list-platforms` to find the source platform index. Find the destination's actual instance ID in Clusterio, then run:

```text
/transfer-platform <platform_index> <destination_instance_id>
```

An instance ID is not a host number. The [command reference](commands-reference.md) lists the remaining export/import and diagnostic commands.

## What to inspect

- **Items, entities, and fluids:** inspect the recorded destination attempt. Rollback success describes recovery; it does not turn a rejected destination audit into a pass.
- **Timing:** measured milliseconds belong to their local Clusterio or Lua clock. Tick counts describe scheduling. A phase that uses zero elapsed ticks can still perform expensive work.
- **Source and destination:** successful transfer removes the source; standalone export/import creates a copy and has a different lifecycle.

No fixed transfer time or UPS impact is promised. The [batching reference](async-processing.md) records current measurements and remaining synchronous work. The [durability reference](TRANSFER_2PC.md) distinguishes the shipped behavior from the pending crash-safe commit protocol.
