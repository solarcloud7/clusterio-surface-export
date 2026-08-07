---
name: client-logs
description: Read the Factorio GAME CLIENT log on this Windows machine and correlate it against a server instance log — client disconnects, "server left", latency history, tick-behind measurement. Use whenever a player's client drops, freezes, or desyncs during a transfer, and whenever you are tempted to conclude "nothing happened" from a silent server log. Server-side instruments (RCON, the instance log) share the Factorio main thread and cannot measure a main-thread stall; this is the client half.
---

# client-logs — read the client's side, because the server cannot see its own stall

**The trap this skill exists to defeat:** RCON is served by the Factorio **main thread**, and the server log is written by the **main thread**. If the main thread blocks, an RCON probe blocks and the server log goes silent. So **a gap in the server log is not evidence that nothing happened — a gap is exactly what a stall looks like.** Server-side instruments cannot measure a main-thread stall by construction. The client log is the only in-reach instrument that does not share that thread. Anything better (external tick sampling, packet capture) is an out-of-process build that does not exist here.

Use `/cluster-logs` for the server side. Use this skill when the symptom is on the client: dropped connection, freeze, desync, "the game kicked me during a transfer".

All line formats below were read out of the real logs on this machine at the **2.1.11** pin (the client log records `Map version 2.1.11-1`).

## Do this first

```powershell
# 1. Locate both client logs (sizes + mtimes tell you which run you want):
Get-ChildItem "$env:APPDATA\Factorio\factorio-*.log" | Select-Object Name, Length, LastWriteTime

# 2. Every connection-state transition, both logs, volume-bounded:
Get-Content "$env:APPDATA\Factorio\factorio-current.log","$env:APPDATA\Factorio\factorio-previous.log" |
  Where-Object { $_ -notmatch 'BlueprintLibrary' } |
  Select-String 'changing state from|desync|timed out|Disconnect|dropped' |
  ForEach-Object { $_.Line.Trim() }
```

If a line reads `to(WaitingForUserToSaveOrQuitAfterServerLeft)`, note its `UpdateTick(N)` and go to **Tick correlation** below.

## Where the logs live

| Want | Path | Note |
|---|---|---|
| **Client log, current run** | convention `%APPDATA%\Factorio\factorio-current.log`; resolved on this machine to `C:\Users\Solar\AppData\Roaming\Factorio\factorio-current.log` | Written by the game client process, not by Clusterio. Nothing in `docker` sees it. In PowerShell use `$env:APPDATA` — a literal `%APPDATA%` does not expand. |
| **Client log, previous run** | `%APPDATA%\Factorio\factorio-previous.log` | **Rotated on every client launch.** A disconnect you are investigating is almost always in `-previous`, because you relaunched the client after it dropped. Read both. |
| **Server counterpart** | in-container `/clusterio/data/instances/<instance>/factorio-current.log` | See `/cluster-logs`. Reached with `docker exec surface-export-host-1 sh -c "…"`. |

Client log timestamps are **client-process uptime seconds**, not wall clock. See the clock warning under Tick correlation.

## The disconnect signature

Client side — the client decided the server went away:
```
1668.766 Info ClientMultiplayerManager.cpp:608: UpdateTick(32870952) changing state from(InGame) to(WaitingForUserToSaveOrQuitAfterServerLeft)
```
`WaitingForUserToSaveOrQuitAfterServerLeft` is the state to grep for. It is the client's *conclusion*, not a server report — it means the client stopped receiving what it needed and gave up.

Server counterpart, same event, in the instance log:
```
6183.321 Info ServerMultiplayerManager.cpp:977: updateTick(32870990) received stateChanged peerID(1) oldState(InGame) newState(WaitingForUserToSaveOrQuitAfterServerLeft)
```
```powershell
docker exec surface-export-host-1 sh -c "grep -a 'WaitingForUserToSaveOrQuitAfterServerLeft' /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log"
# Full peer state history (bounded):
docker exec surface-export-host-1 sh -c "grep -a 'ServerMultiplayerManager.cpp:977' /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log | tail -20"
```

Other client states are ordinary lifecycle, not faults: `Connecting → ConnectedWaitingForMap → ConnectedDownloadingMap → ConnectedLoadingMap → TryingToCatchUp → InGame`, and a deliberate quit shows `Reason: SwitchingServers` / `DisconnectScheduled`. `UpdateTick(18446744073709551615)` is the not-yet-in-game sentinel (unsigned −1), not a real tick.

**Desync:** `desync` is in the search pattern above, but no desync occurred in the session these notes were measured from, so no desync signature is documented here. If you hit one, read the line, do not assume it looks like the disconnect above.

## Latency history

```powershell
# NOTE: do NOT filter out 'Verbose' here — the latency lines ARE Verbose-tagged.
Select-String -Path "$env:APPDATA\Factorio\factorio-current.log" -Pattern 'Latency changed to' |
  ForEach-Object { $_.Line.Trim() }
```
```
1696.823 Verbose ClientSynchronizer.cpp:319: Latency changed to (3)
1702.240 Verbose ClientSynchronizer.cpp:319: Latency changed to (6)
```

**`Latency changed to (N)` is logged only on CHANGE.** This inference is load-bearing and easy to get backwards: **absence of lines means latency was STABLE, not unmeasured.** A stall that develops gradually should move latency first, and would leave a trail of these lines. An abrupt drop with *no* latency movement is a different shape — distinguish the two before reasoning about cause.

The initial value is logged separately at connect: `ClientSynchronizer.cpp:27: Initialized Synchronizer local peer(1) latency(32).`

## Tick correlation — the actual diagnostic

**Do not correlate on timestamps.** Client uptime and server uptime are unrelated clocks: the same state change above is `1668.766` in the client log and `6183.321` in the server log. **Ticks are the only shared axis.**

1. Take the client's `UpdateTick(N)` at the disconnect and the server's `updateTick(M)` at the same `stateChanged` event.
2. `(M − N) / 60` = seconds the client had fallen behind the server.
3. Compare against the server's own tick deficit over the window: ticks advanced ÷ wall-clock seconds vs the nominal 60 TPS.

```powershell
# Server TPS from consecutive tick-stamped lines. Narrow the grep to your window —
# over a long span this averages in every pause and understates the incident.
$rows = docker exec surface-export-host-1 sh -c "grep -a 'ServerMultiplayerManager.cpp:977' /clusterio/data/instances/clusterio-host-1-instance-1/factorio-current.log" |
  ForEach-Object { if ($_ -match '^\s*([\d.]+).*updateTick\((\d+)\)') { [pscustomobject]@{ Uptime=[double]$Matches[1]; Tick=[long]$Matches[2] } } }
$a = $rows[0]; $b = $rows[-1]
"{0:N1} TPS over {1:N2}s ({2} ticks advanced)" -f (($b.Tick-$a.Tick)/($b.Uptime-$a.Uptime)), ($b.Uptime-$a.Uptime), ($b.Tick-$a.Tick)
```

**Worked example, from the real incident:** client tick `32870952`, server tick `32870990` → delta **38 ticks ≈ 0.63 s** behind, latency **3**. Server measured **55.3 TPS over 10.19 s** → ~47 lost ticks ≈ **0.8 s of lost time** in that window.

**These three numbers were consistent with each other and still did not establish a cause.** They bound the size of the event (sub-second, not a multi-second freeze) and they rule out a client that was already drifting badly. They do not name a mechanism. Report the measurement; do not upgrade agreement into an explanation.

## Practical pitfalls

Every one of these was hit for real while reading these logs by hand.

- **One `Verbose` line is ~98 KB.** `Verbose BlueprintLibrary.cpp:56: Loaded external blueprint storage` (emitted at map load) measured **97,692 bytes on a single line**. Pull an unfiltered window that contains it and the output blows past tool limits. Overall the client log is ~12% Verbose *by line count* (49 of 390) but ~56% *by bytes* (297 KB of 526 KB).
- **Exclude `BlueprintLibrary`, NOT `Verbose`.** The obvious volume filter is wrong: the latency lines are Verbose-tagged, so `-notmatch 'Verbose'` silently deletes the very evidence the "absence means stable" inference depends on — and you then read your own filter as a finding. Filter on the fat emitter, or cap line length.
- **ripgrep (the Grep tool) has no look-around.** `(?!Verbose)` fails outright. Use a PowerShell `Where-Object { $_ -notmatch '…' }` pass. (`rg --pcre2` exists at the shell level, but the Grep tool exposes no such flag.)
- **The timestamp field index SHIFTS.** Client lines under 1000 s uptime are space-padded, so `($line -split '\s+')` yields `[0]=''`, `[1]='21.737'`; at or above 1000 s there is no padding and `[0]='1668.766'`. **No fixed index is correct.** Use `($line.Trim() -split '\s+')[0]`, or capture with `^\s*([\d.]+)`.
- **Window by timestamp-prefix regex, don't pull ranges.** `Where-Object { $_ -match '^\s*166[0-9]\.' }` gets you 1660–1669 s and nothing else. Truncate long lines when you do:
  ```powershell
  Get-Content "$env:APPDATA\Factorio\factorio-current.log" |
    Where-Object { $_ -match '^\s*166[0-9]\.' } |
    ForEach-Object { if ($_.Length -gt 300) { $_.Substring(0,300) + ' ...[truncated]' } else { $_.Trim() } }
  ```

## Reference

- `/cluster-logs` — the server-side half: plugin JSON logs, instance `factorio-current.log`, `check-cluster-logs.ps1`. Everything there shares the main thread; read this skill's opening warning before treating its silence as a negative result.
- A prior finding in project memory (*"connected-player transfer drops client"*) reports the same client-side symptom around a transfer, with the transfer itself lossless. That is a **prior claim, not measured by anything in this skill** — do not carry its mechanism into a fresh incident. Measure this one.
- `surface_export_export_stall_seconds` (controller `/metrics`) is the server-side histogram of that same export stall window.
