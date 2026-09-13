# Read transaction logs

Open **Surface Export → Transaction Logs** to inspect transfers, exports and
imports. Search by platform, instance or operation ID, then select an operation
from the list. Filters apply to the loaded history; the count shows that scope.

## Outcome and recovery

The outcome describes the attempted operation. Recovery describes what happened
after a failure. **Failed; rollback succeeded** remains a failed transfer: recovery
does not turn the rejected destination into a successful one.

The overview separates entity, item and fluid evidence. Matching cargo totals do
not prove that every entity was placed or configured correctly. An entity or belt
restoration failure can reject a transfer while item and fluid audits pass.
Open the matching tab for the recorded rows and any structural evidence.
Older or incomplete records may have no detailed evidence; absence is not a pass.

**Queued**, **Waiting** and **No progress observed** are not terminal failures.
**Status unavailable** means the controller cannot confirm current work. It does
not establish that the work stopped or that resubmission is safe. Unresolved
cleanup may continue to reserve the participating instances.

## Timing

The Timing tab separates Clusterio orchestration, instance handling and Lua work.
Each waterfall uses measured milliseconds on its own local clock. Start, end and
elapsed interval belong to that clock; bars from different processes are not
aligned to a shared timeline.

- An inclusive handler interval can include waiting for another process.
- A Lua phase's elapsed interval can include waits between batches. Its accumulated
  execution time excludes those waits.
- Exact tick boundaries and batch counts describe scheduling. Zero elapsed ticks
  can still contain expensive work. Ticks are not milliseconds.
- Missing boundaries produce no duration bar. Overlapping parent and child spans
  must not be added as exclusive processing time.

The headline duration covers the controller's observed operation through its
terminal result, including required cleanup acknowledgements. A source-initiated
or stored-export transfer can begin observation after export work already occurred.
Restarted observations do not form one continuous measured clock. Historical
records may have only older timestamps; they cannot reconstruct precise Lua time.

See [how timing is measured](../technical/timing.md) for the measurement boundaries.

## Downloads and retention

**Download platform** retrieves an available stored payload. **Download diagnostic
report** includes retained audit, timing and recovery information for investigation.
Review reports before sharing: platform names, player information and game content
can be sensitive.

Payload downloads and detailed logs have separate retention settings. A summary
can remain after its payload or detailed rows are removed. An unavailable payload
disables snapshot restoration with an explanation. Restoring creates a new import
record; it does not overwrite the original failure or replay source deletion.

The debug **Preview logs** and map motion previews use synthetic examples. They
help inspect the interface, not prove a real transfer succeeded.
