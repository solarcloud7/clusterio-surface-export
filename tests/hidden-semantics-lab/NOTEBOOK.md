# Hidden-Semantics Lab Notebook

## Purpose

This semi-manual lab covers PR-0C of the Phase-2 plan: measure what a connected player actually perceives when a destination platform is hidden and held. It is scheduled evidence, not a wiring blocker unless it finds unsafe exposure.

## Runner

Run from the repository root while the local cluster is up and a human can connect a Factorio client to the target instance:

```powershell
node tests/hidden-semantics-lab/run-pr0c.mjs
```

Reset-only cleanup:

```powershell
node tests/hidden-semantics-lab/run-pr0c.mjs --reset
```

Optional positional arguments:

```powershell
node tests/hidden-semantics-lab/run-pr0c.mjs <instance> <controller> <notebook>
```

Defaults:

- Instance: `clusterio-host-1-instance-1`
- Controller: `surface-export-controller`
- Notebook: `tests/hidden-semantics-lab/NOTEBOOK.md`

## Setup Produced By The Runner

The runner resets prior lab state, then creates two platforms on the `player` force:

- `hidden-semantics-lab-visible-control-*`: visible control platform, expected to appear normally.
- `hidden-semantics-lab-held-destination-*`: destination platform staged through the real `destination_hold_json` remote, expected to be hidden, paused, and non-live.

The runner prints and appends raw JSON containing platform names, indexes, surface indexes, transfer id, setup tick, and the observation checklist. Do not edit the generated JSON; add human notes below it.

## Manual Observation Checklist

Record every observation with player name, instance, approximate wall-clock time, and game tick from the runner output.

1. Space platform list: open the in-game Space platforms list and search for both lab platform names.
2. Remote view picker/map search: try to find or select both platforms from remote view and map-style platform navigation.
3. Direct references: watch alerts, dialogs, train/platform selectors, and any side panels for the held platform name.
4. Attempted interaction: if the held platform is visible anywhere, try the least destructive interaction available and record whether it opens the held surface, moves the player, or only shows inert text.
5. Control sanity: confirm the visible-control platform is discoverable through the same UI path used for the held platform search.
6. Cleanup sanity: run `node tests/hidden-semantics-lab/run-pr0c.mjs --reset`, then confirm neither lab platform remains visible.

## Expected Safe Results

- The visible-control platform appears normally and can be used as the positive UI control.
- The held-destination platform does not appear in ordinary player-facing platform lists, remote-view pickers, map search, alerts, dialogs, or selectors.
- If any held-destination text is exposed, it must not open the hidden surface, move a player, make the platform live, or leak items/entities out of the platform; classify confusing-but-inert exposure as UX backlog.
- Any path that lets a connected player view, enter, interact with, or otherwise observe live state on the held destination is unsafe exposure and blocks Phase-2 wiring until redesigned.
- Reset ends with zero lab destination holds, zero lab platforms, and `game.tick_paused == false`.

## Result Template

```markdown
## <ISO timestamp> - PR-0C hidden-semantics semi-manual run

Runner JSON: <paste or reference appended JSON block above>

Human context:
- Player:
- Instance:
- Client build:
- Game tick:
- Wall-clock time:

Observations:
- Space platform list:
- Remote view picker/map search:
- Direct references:
- Attempted interaction:
- Visible-control sanity:
- Cleanup sanity:

Verdict:
- Safe exposure / UX backlog / unsafe blocker:
- Follow-up issue(s):
```

*(append experiment entries below — script name, date, raw JSON, human observation notes, verdict)*
