---
name: repro-transfer
description: Reproduce a transfer with existing local or disposable fixtures and retain independent evidence.
---

# Reproduce a transfer

Establish the symptom, deployed version and required fixture first. Read
[test selection](../../../docs/developers/testing.md). Ordinary integration uses
the configured cluster, not a disposable one. Use the manual Docker lab for
destructive recovery cases and preserve the development cluster.

The local driver is `tools/surface-export/repro-transfer.ps1`. Inspect its
parameters and required source before running it; an old example naming a
`test` platform does not establish that it exists. The driver clones, transfers
and cleans its fixture. A clone made by the serializer is not its independent oracle.

1. Confirm loaded plugin/Lua versions and idle-world prerequisites.
2. Preserve the failure and independently read relevant physical state.
3. Run the bounded fixture and its control/fault cases.
4. Check validation, recovery, cleanup and physical source/destination observations.
5. Verify owned fixture and persistent-state cleanup without deleting protected
   platforms or resetting the world. Report leftovers explicitly.

Use [the deployment wrapper](../../../docs/developers/workflow.md) to load changes.
Do not compile or install dependencies in a live mount just to run checks. Do not
use direct `game.delete_surface` as generic recovery. `LuaSpacePlatform.destroy`
schedules deletion; it is not a universal silent no-op.

Read logs through `cluster-logs`. Queue waits and unavailable status are
nonterminal; there is no fixed 120-second validation-failure rule. Apply the
canonical data-integrity skill to fixes affecting cargo or ownership.
