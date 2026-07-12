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


## 2026-07-12T18:47:56.271Z - PR-0C hidden-semantics setup (run-pr0c.mjs)

```json
{
  "script": "tests/hidden-semantics-lab/run-pr0c.mjs",
  "instance": "clusterio-host-1-instance-1",
  "controller": "surface-export-controller",
  "started": "2026-07-12T18:47:52.424Z",
  "manual": true,
  "rungs": {
    "setup": {
      "success": true,
      "instance_note": "connect a human client to the target instance before recording observations",
      "tick": 465393,
      "game_paused": false,
      "transfer_id": "hidden-semantics-lab-transfer-465393",
      "visible": {
        "name": "hidden-semantics-lab-visible-control-465393",
        "index": 3,
        "surface_index": 7,
        "hidden": false,
        "paused": false
      },
      "held": {
        "name": "hidden-semantics-lab-held-destination-465393",
        "index": 4,
        "surface_index": 8,
        "hidden": true,
        "paused": true,
        "hold": {
          "transfer_id": "hidden-semantics-lab-transfer-465393",
          "force_name": "player",
          "platform_index": 4,
          "platform_name": "hidden-semantics-lab-held-destination-465393",
          "surface_index": 8,
          "original_hidden": false,
          "original_paused": false,
          "active_states": {
            "14296": false
          },
          "deactivated_count": 0,
          "pod_completion": {
            "descending": 0,
            "ascending": 0,
            "items_recovered": 0
          },
          "held_tick": 465393
        }
      }
    }
  },
  "errors": [],
  "manual_observation_checklist": [
    {
      "id": "space-platform-list",
      "prompt": "Open the in-game Space platforms list and search for both lab platform names.",
      "expected": "visible-control appears; held-destination is absent."
    },
    {
      "id": "remote-view-picker-map-search",
      "prompt": "Use remote view and map-style platform navigation/search for both lab platform names.",
      "expected": "visible-control can be selected normally; held-destination is absent or inert."
    },
    {
      "id": "direct-references",
      "prompt": "Watch alerts, dialogs, selectors, side panels, and player-facing platform references for the held platform name.",
      "expected": "held-destination does not appear in ordinary player-facing UI."
    },
    {
      "id": "attempted-interaction",
      "prompt": "If the held platform is exposed anywhere, try the least destructive interaction and record whether it opens, enters, or changes the platform.",
      "expected": "no interaction opens the held surface, moves a player, makes it live, or moves items/entities off-platform."
    },
    {
      "id": "control-sanity",
      "prompt": "Repeat the same path against the visible-control platform.",
      "expected": "visible-control remains discoverable, proving the UI path was exercised."
    },
    {
      "id": "cleanup-sanity",
      "prompt": "Run the reset command and confirm neither lab platform remains visible.",
      "expected": "zero lab platforms, zero lab holds, game unpaused."
    }
  ],
  "expected_safe_results": {
    "visible_control": "appears normally and proves the player-facing UI path was exercised",
    "held_destination": "hidden from ordinary player-facing platform lists, remote view pickers, map search, alerts, dialogs, and selectors",
    "exposed_text": "confusing but inert text is UX backlog if it cannot open, enter, observe, or mutate the held surface",
    "unsafe_blocker": "any path that lets a connected player view, enter, interact with, or observe live state on the held destination blocks Phase-2 wiring",
    "cleanup": "reset leaves zero lab destination holds, zero lab platforms, and game.tick_paused == false"
  },
  "initial_reset": {
    "success": true,
    "deleted": {},
    "zero_storage": true,
    "zero_surfaces": true,
    "leftovers": {},
    "hold_leftovers": {},
    "game_paused": false,
    "post_tick": {
      "success": true,
      "deleted": {},
      "zero_storage": true,
      "zero_surfaces": true,
      "leftovers": {},
      "hold_leftovers": {},
      "game_paused": false
    }
  },
  "finished": "2026-07-12T18:47:56.271Z"
}
```

Human observation notes:

- Observer: connected human client on host 1, Factorio 2.0.77.
- Ordinary player-facing Space platforms UI exposed both `hidden-semantics-lab-visible-control-465393` and `hidden-semantics-lab-held-destination-465393`.
- Both platform views exposed the hub inventory containing `10x space platform foundation`.
- The held destination exposed its live `paused=true` state; the visible control exposed `paused=false`.
- No mutation was attempted. Observing platform contents and pause state is sufficient to meet the lab's unsafe-blocker definition.
- Classification: **UNSAFE BLOCKER**. `SpacePlatform.hidden=true` did not hide the held platform from this connected-player UI path.
- Cleanup: runner reset succeeded; independent RCON check reported `lab_surfaces=0`, `destination_holds=0`, and `game_paused=false`.
