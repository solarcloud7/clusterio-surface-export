# Layer-2 client session — script of record

> **RUN 2026-08-06. Q1 and Q2 PASS — seat-on-join is a GO.** Results and their evidence tags live in
> [GATEWAY_TRANSFER_PRD.md → The client half](GATEWAY_TRANSFER_PRD.md#the-client-half-2026-08-06--seat-on-join-is-a-go),
> not here; this file stays the procedure. The **stall-race cell** of Q2 also PASSES: a prompt created
> in the same tick as a deliberate 7.43 s main-thread block reached the client, survived, and stayed
> actionable — and a stall that long does not disconnect a client at all (latency 3 → 254, connection
> held). Still open: **Q3 and Q4**, which were not run. One client disconnect during setup has no
> established cause, and the stall explanation is now the *least* likely one.
> Use [/client-logs](../.claude/skills/client-logs/SKILL.md) for the client half of any drop — it was
> written during this session precisely because the server-side logs cannot see a main-thread stall.

> The headless half of the Layer-2 re-scope ran 2026-08-03 (measurements in
> [GATEWAY_TRANSFER_PRD.md → Empirical foundations](GATEWAY_TRANSFER_PRD.md#empirical-foundations-2111)).
> This script is the client half: everything below needs a real game client and an owner at the
> keyboard. Target: 30–60 minutes, one sitting, every question answered with an observation.
> Design under test: **seat-on-join, one shot, native fallback** (owner ruling 2026-08-03).

## Already measured — do NOT re-derive at the client

| Fact | Status |
|---|---|
| `enter_space_platform` returns `false` for DISCONNECTED players (all variants) | measured headless — the reason seat-on-join exists |
| `game.delete_surface` relocates an offline characterless record to nauvis {0,0}; no crash | measured headless — source-side login is safe even without evacuation |
| Character bodies are destroyed with a deleted surface; evacuation is what saves gear | measured headless (upstream-documented half) |
| `connect_to_server` + client reachability on this LAN | proven by the shipped `/teleport` GUI on 2.1.11 |
| Export tick-stall heartbeat-DROPS a connected client | observed on a real transfer (the drop IS the disconnect Layer 2 must ride through) |

## Session prep (5 min)

1. Cluster up, both instances green: `./tools/clusterio/show-cluster-status.ps1`
2. Client connects to host-1 (the `factorio-client-2111` install).
3. A throwaway platform on host-1 with a hub and starter kit — make it in-game or:
   `./tools/clusterio/rcon.ps1 11 "/sc local p=game.forces.player.create_space_platform{name='l2-session', planet='nauvis', starter_pack='space-platform-starter-pack'}; p.apply_starter_pack(); p.paused=false"`
4. Keep a second terminal on `./tools/clusterio/check-cluster-logs.ps1 -Grep "transfer|evacuat"`.

## The questions (in run order)

### Q1 — online seating: does `enter_space_platform` work at all for a CONNECTED player? (5 min)

With the client connected and the player on Nauvis:

```
rc11 "/sc local pl=game.players['solarcloud7']; local plat; for _,q in pairs(game.forces.player.platforms) do if q.name=='l2-session' then plat=q end end; rcon.print(tostring(pl.enter_space_platform(plat)))"
```

- Record: return value; what the client SHOWS (remote view? hub lock? camera jump?); can the player
  leave again (`leave_space_platform` / respawn UI)?
- **Repeat once with the platform PAUSED** (`plat.paused=true` first) — the join-during-import edge.
  Headless only measured the disconnected refusal; the online+paused cell is the one empty box.

### Q2 — the prompt: when can `connect_to_server` reach a player who is about to be dropped? (10 min)

The export stall drops the client mid-transfer, so the prompt must land BEFORE the stall.

1. Player aboard `l2-session` (Q1 leaves them there).
2. Fire the prompt manually at "transfer start" time:
   `rc11 "/sc game.players['solarcloud7'].connect_to_server{address='<host-2 LAN address>:34200', name='clusterio-host-2-instance-1'}"`
3. Record: does the dialog appear instantly? Does it survive if the server stalls right after
   (start a real transfer of a LARGE platform to force a visible stall)? If the player clicks accept
   AFTER the drop began, what happens?
- **GO condition**: there is a moment in the real transfer flow (trigger time, pre-export) where the
  prompt reliably reaches the client. **NO-GO**: the stall races the prompt unreliably → Layer 2 needs
  a pre-transfer prompt step (ask first, then transfer), not a mid-transfer one.

### Q3 — the full dry run: ride a transfer (15 min)

1. Player aboard a platform on host-1; trigger a real transfer to host-2
   (`./tools/surface-export/transfer-platform.ps1` or the gateway command).
2. Observe and record, in order: the heartbeat drop (client side); where the player lands on
   RECONNECTING to host-1 (expected: Nauvis via evacuation — confirm body + equipped gear present);
   then connect the client to host-2 and simulate seat-on-join:
   `rc21 "/sc local pl=game.players['solarcloud7']; local plat=<arrived platform>; rcon.print(tostring(pl.enter_space_platform(plat)))"`
3. Record: does the seat land the player hub-locked in remote view on the arrived platform, matching
   the passenger state they had on the source?

### Q4 — native fallback confirmation (5 min)

With the destination platform deleted (transfer it away or sweep it), log the client into host-2:
record where the game puts the player (expected from the headless relocation measurement: Nauvis
spawn; this confirms the client-side moment of the measured record state — no crash, no space spawn).

## GO / NO-GO for building Layer 2

- **GO** = Q1 online seat works (return `true`, sane client state) AND Q2 has a reliable prompt moment
  AND Q3's manual seat reproduces the source passenger state. Build: pending-seat intent at import
  go-live + on-join hook + the prompt at the Q2-proven moment.
- **NO-GO on any** = Layer 1 (evacuate to Nauvis) stands as shipped; the `/teleport` GUI remains the
  manual cross-server path. No partial builds — the fallback is already the shipped behavior.

## Cleanup

`l2-session` and any arrived copies are throwaways:
`./tools/tests/cleanup-test-surfaces.ps1 -DryRun` then live, and confirm the player ends the session
where they want to be (their record was byte-exact-restored after the headless probes; leave it clean
here too).
