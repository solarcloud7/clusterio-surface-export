---
name: canvas-debug
description: Drive, photograph and verify the Surface Export gateway canvas (the React Flow Gateways tab) — mock instances, scenarios, transfer-phase ships, geometry overlay, and replaying real transfers from the transaction log. Use whenever changing or debugging anything under web/gateway/, and BEFORE trusting any hand-rolled DOM probe against the canvas: measuring this page by dispatching events is how five separate false findings were produced in one session, three of which looked like real bugs.
---

# canvas-debug — the canvas lies to you unless you measure it correctly

**The trap this skill exists to defeat:** the gateway canvas is **geometry**. React Flow decides what
can be dragged, where an edge attaches, and what `fitView` frames from **measured DOM boxes** — not
from the React tree. So the page can be fully rendered, every prop correct, every rule right, and the
behaviour still absent. Worse: the usual ways of probing it *return confident wrong answers* rather
than failing. Five of the six traps below each produced a finding that had to be retracted.

The rule that survives all of them: **every probe needs a control arm.** A measurement without one
cannot tell "the feature is broken" from "my probe cannot test this feature".

## Use the tools, not hand-rolled probes

Two exist. Neither needs the Browser pane.

```bash
# Photograph the canvas in any state. Live cluster by default.
node tools/surface-export/canvas-shot.mjs --scenario hub --geometry --out /tmp/canvas.png
node tools/surface-export/canvas-shot.mjs --replay 3            # the 3 most recent REAL transfers
node tools/surface-export/canvas-shot.mjs --list-transfers      # what is replayable, no shot needed

# The one browser regression. Cluster must be up.
node tools/tests/run-integration-tests.mjs --only canvas-drag
```

In a browser console (or via `page.evaluate`), the canvas exposes itself:

```js
surfaceExportCanvas.help()      // the full API — do NOT restate it here, it will drift
```

`help()` is the API reference and lives with the code. This file is only the things `help()` cannot
tell you.

## The six traps, each measured

| # | Trap | Why it fools you |
|---|---|---|
| 1 | **A non-compositing Browser pane** | React Flow measures handle geometry from the live DOM. A pane that has stopped compositing returns **zero edges, an identity viewport, and no error** — the exact symptom set of a real regression. This produced a "BLOCKING MERGE" report that had to be retracted. |
| 2 | **Synthetic `pointerdown`** | React Flow starts drags on `mousedown` (d3-drag). A dispatched `pointerdown` starts nothing, from *any* handle — so it manufactures a perfect-looking reproduction of a bug that is not there. |
| 3 | **Hand-fired `mouseenter`** | React derives enter/leave from delegated `mouseover`/`mouseout`. A dispatched `mouseenter` never reaches the handler, so hover-dependent behaviour reads as broken. |
| 4 | **Dispatching on the wrapper** | Events bubble **up**. Firing on `.react-flow__node-instance` never reaches a handler on the inner `.surface-export-instance-node`. Fire on the element a real click lands on. |
| 5 | **Sampling inside a re-armed timer** | The platform list re-arms its auto-hide on any press. Sampling 3.6s after a gesture that re-armed at 3.0s reads as "still open" — it passed against a deliberately broken build. |
| 6 | **Retry loops that outlive the bug** | The platform tree re-pushes ~1/s and **each push re-measures every node** — which is exactly what a missing `updateNodeInternals` would have done. A 20-second retry loop therefore made a canvas test pass against a known-broken build. **The test was waiting for the defect to heal.** |

Trap 6 is the important one and it generalises: on this page, *time passing repairs measurement
bugs*. Any wait longer than a second or two can turn a real failure green. Settle **before** you act,
then act **once**.

## Verifying a canvas change

1. **Deploy** — `./tools/clusterio/deploy.ps1 -Scope artifacts -Target web -RestartController`.
   The controller caches each plugin's manifest at startup, so a web change needs the restart.
2. **Photograph it** rather than describing it. `canvas-shot.mjs` with `--geometry` draws the
   measured node box, the portal's connect zone and the edge anchor — the three invisible things
   that have each hidden a bug.
3. **If you wrote or changed a test, mutation-kill it.** Break the thing it guards, confirm it goes
   RED, restore, confirm GREEN. Commit the real change *first* so the implementation cannot be lost
   during the check. A test rewritten for robustness has silently lost its teeth here before.

## Facts that are not obvious from the code

- **The node's measured box is deliberately just the 150px circle.** The caption and the platform
  list are absolutely positioned *outside* it, because `nodeCircle` puts the node's centre at
  `position + measured.height / 2` — grow the box and every edge detaches from the portal. This is
  why the list needs `useUpdateNodeInternals` (its handles arrive after measurement) and why
  `fitView` needs explicit padding (it cannot see the overhang).
- **The canvas does not re-frame when a scenario loads.** An in-app re-fit was tried and removed: it
  translates the viewport but keeps zoom at 1, because the new nodes are not measured yet (measured:
  `scale(1)` on load vs `scale(0.543)` from the fit control two seconds later). Press Reset or the
  fit control; `canvas-shot.mjs` does it for you.
- **Mock platform rows are inert.** Export and Transfer go straight to the controller with whatever
  instance id the row holds, and a mock id is negative — so a scenario cannot be used to test the
  transfer path. `canvas-drag` runs against real instances for exactly this reason.
- **Nothing the debug API creates can reach the controller.** Mock ids are negative, mock↔real links
  are refused, and the save re-checks the payload. It only changes what one browser draws.

## Reference

- `web/gateway/debug-api.ts` — the console API and why it exists
- `web/gateway/debug-mode.ts` — mock/scenario/replay model and the safety invariants
- `tests/integration/canvas-drag/run-tests.mjs` — the one browser regression, and its own trap notes
- `/cluster-logs` — for anything that turns out to be server-side rather than canvas-side
