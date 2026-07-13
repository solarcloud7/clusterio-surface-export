# State Dimensions Live Validation Notebook

## 2026-07-12 - Closer run

Prediction: every authored state dimension survives the shipped transfer path without item or fluid loss. MC1 predicts zero embodied-item drift.

### MC1

- Result: `RESUME-CLEAN`.
- Source frozen: `crafting_progress=0.8666666666666677`, `input_plates=2`, `output_gears=0`.
- Destination frozen: `crafting_progress=0.8833333333333344`, `input_plates=2`, `output_gears=0`.
- Destination settled: `input_plates=0`, `output_gears=2`.
- Embodied item value: `4 -> 4`, delta `0`; exactly one in-flight gear completed.
- Instrument repairs banked before rerun: 220 ms advanced 117 ticks and skipped the craft; 30 ms captured the window. A one-record Nauvis schedule was required by the real transfer import path.

### Deactivated-write preflight

All readings were same-command/same-tick on a paused platform.

| Dimension | Reading | Verdict |
|---|---|---|
| Accumulator energy | inactive; `0 -> 123456` | accepted exactly |
| Machine energy | inactive; buffer `1377.7777777777778`; in-range target `688.8888888888889` read back exactly | accepted exactly; earlier out-of-range write clamped and was discarded as non-evidence |
| Reactor temperature | inactive; `15 -> 500` | accepted exactly |
| Burner current item | inactive; write `solid-fuel/normal`; robust prototype decoding read it back | accepted exactly |
| Burner inventory ordering | coal fuel inventory `10 -> clear 0 -> refill 10`; `currently_burning=solid-fuel` and `remaining_burning_fuel=200000` unchanged throughout | inventory clear/refill does not perturb restored burn state |

The first burner read incorrectly treated userdata-backed `name` and `quality` fields as JSON values. On 2.0.77, resolve non-string values through `.name`; the corrected meter showed the write had succeeded.

### Focused integration results before hard stop

| Test | Result |
|---|---|
| `bonus-progress-roundtrip` | PASS 3/3 |
| `midcraft-roundtrip` | PASS 5/5 |
| `circuit-latch-state` | PASS 10/10; held signal survived |
| `energy-roundtrip` | PASS 10/10 |
| `heat-roundtrip` | PASS 7/7 |
| `circuit-config-roundtrip` | OPEN instrument/fixture failure before transfer; source graph did not retain its constant slot/wires |
| `entity-burner-roundtrip` | **HARD STOP**: physical coal `10 -> 0` while gate passed |
| remaining authored tests | not run after hard stop |

### Hard-stop evidence: burner fuel omitted end to end

Transfer fixture: `burnerrt-163355`.

- Physical source: burner-inserter fuel inventory contained `coal=10`; `currently_burning=solid-fuel/normal`; `remaining_burning_fuel=2000000`.
- Physical destination: burner-inserter fuel inventory contained `coal=0`; current item and remaining energy survived.
- Debug result: `debug_import_result_burnerrt-163355_196255.json`.
- Gate verdict: `validation_success=true`, `failedStage=null`.
- Gate expected map: `{"space-platform-foundation":10}`.
- Gate actual map: `{"space-platform-foundation":10}`.
- Static localization: `EntityHandlers["inserter"]` returns inserter-specific state without calling `InventoryScanner.extract_all_inventories(entity)`. The default handler therefore never captures `defines.inventory.fuel` for burner inserters, despite the common burner-state comment claiming fuel inventories ride normal inventory export.
- Classification: item loss on a shipped path with a signature other than the known belt anomaly. The exact gate cannot detect an item omitted from its own exported expectation. Source deletion therefore made the loss permanent.
- Action: hard stop per `2026-07-11-state-dimensions-closer-brief.md`. No gate, validator, or production fix attempted in this run.

### Cleanup

Every focused runner reported zero fixture surfaces and leaked locks on both hosts. The cluster was stopped after banking this notebook.
## 2026-07-13 - Closer re-run (correct bind-mount) — equipment-grid crash

Cluster context: the running containers were bind-mounted to a STALE codex worktree, not this checkout;
`docker compose up -d --force-recreate` from the primary checkout rebound them, then patch-and-reset
re-patched the correct Lua. Re-ran the nine tests against the correct build.

New empirical API fact [empirical, 2.0.77]: `LuaEquipment.shield` (and `.energy`) READ returns `0` on
equipment that has no such buffer (does not throw), but the WRITE `equipment.shield = v` THROWS
`"Equipment is not shields"` on non-shield equipment. Evidence: equipment-burner-roundtrip transferred a
grid+battery fixture; the import crashed on_tick at tick 138282 in `deserializer.lua restore_equipment_grid`
and took host-2 to Failed/Closed. The pre-existing guard `equipment.shield ~= nil` is a FALSE guard (the
read never yields nil), and export captured a truthy `shield=0`, so the guard passed and the write crashed.
This is a PRE-EXISTING latent crash (init-commit code), exposed for the first time by this branch's new
equipment-grid transfer fixture — NOT a branch regression. Fix (additive-safe, no gate impact):
`safe_call` both equipment energy/shield writes on import; on export capture energy/shield only when > 0.
Two-phase commit preserved both sources (import crash => no source delete). spoilage-roundtrip stalling
immediately after was pure collateral (host-2 was down); its source rolled back cleanly.

### spoilage-roundtrip — two bugs (one pre-existing restore gap, one test locator)

1. PRE-EXISTING restore gap [empirical, 2.0.77, spoilage-roundtrip]: `Deserializer.restore_inventories`
   has two insert paths — `set_stack` (used when the serialized item carries a `slot`, i.e. essentially
   all modern exports) and a no-slot `insert` fallback. Only the fallback called `restore_item_properties`;
   the `set_stack` path never did, so spoil_percent / health / durability / ammo / label were silently
   dropped for every slotted item. Ground truth: source bioflux spoil_percent=0.5003 -> dest=0 (debug dumps).
   The `restore_item_properties` spoil guard is NOT at fault — a fresh inserted bioflux stack reads
   spoil_percent=0 (a number, truthy) and accepts a write (live probe on host-1). Fix: split out
   `restore_item_scalar_properties` (count-neutral scalars only) and call it on the set_stack success path.
   Grid/nested restoration deliberately NOT added to the set_stack path (they ADD items -> could shift the
   gate census; the bare bioflux fixture needs neither). Latent grid/nested-on-slotted-items gap noted as
   out-of-scope for the PR.
2. Test locator bug: `Read-SpoilState` searched `{name='steel-chest', position={ox,oy}, radius=0.6}` but a
   1x1 chest snaps to tile-center (ox+0.5, oy+0.5) = 0.707 from {ox,oy} > 0.6, so it found the chest on
   NEITHER side (src=0/dst=-1 sentinels). Fixed by locating the single chest by name (no assertion weakened).

### circuit-config-roundtrip — source-fixture read + power-settle (NOT a transfer bug)

The prior agent's "OPEN source-fixture failure" root-caused via live focused probes (never full-suite):
1. The combinator+wire chain WORKS — signal-A=5 reaches the decider input (read via the decider input
   circuit network); the earlier isolated `get_signal` self-read of 0 was misleading.
2. Combinators are POWER-gated: a freshly created platform is `no_power` (status 54) for ~3-5s until the
   solar panel charges; the decider only computes signal-B once powered (status 1). The fixture's fixed
   `Start-Sleep 3` was a race — power often not up yet.
3. THE bug [empirical, 2.0.77]: a lamp genuinely disabled by its circuit condition reports
   `status == defines.entity_status.disabled_by_control_behavior` (55), but the boolean property
   `LuaEntity.disabled_by_control_behavior` reads FALSE for the same lamp (verified live: lamp2 status=55,
   property=false; lamp1 status=1/working). The test read the unreliable boolean, so both lamps looked
   "enabled" and the source precondition failed before any transfer.
Fix (test-only, no assertion weakened): read circuit-disabled from `status == 55`, and replace the fixed
source-settle sleep with a deadline POLL until lamp1 enabled + lamp2 disabled. The serializer functionality
(circuit params + red/green wire restore) is unchanged and also exercised by platform-roundtrip.

### circuit-config-roundtrip — third fixture bug: adjacent-lamp lookup ambiguity

After the status-read fix, the source precondition STILL failed. Root cause: the two lamps were 1 tile
apart (lamp1 ox+3, lamp2 ox+4) with tile-centers 503.5 and 504.5. The position lookup
`at('small-lamp', ox+4, oy, radius=0.8)` catches BOTH lamps — lamp1's center is 0.707 from lamp2's search
point (< 0.8) — and `find_entities_filtered[1]` returned lamp1 (created first), so `lamp2_disabled`
actually read lamp1's (enabled) status. Both lamps therefore read "enabled". Fix: space the lamps 2 tiles
apart (lamp2 -> ox+5) so each search resolves unambiguously; the built position, read position, and the
line-88 rationale comment updated together. (The prior line-88 comment's "1.58 tiles" only held for the
lamp1 search, not lamp2.) Combined with the status-read fix + settle-poll, the fixture now evaluates.

### circuit-config-roundtrip — fourth root cause: control-behavior nil on unwired entity (PRE-EXISTING restore gap)

With the source fixture fixed and the transfer running, 3 DEST failures shared ONE cause: the restored
lamp's circuit_condition (first_signal/comparator) and circuit_enable_disable were absent (dest dump: no
first_signal, comparator default '<', no circuit_enable_disable). Source serialized them correctly, no
error logged. Root cause [empirical, 2.0.77]: `Deserializer.restore_control_behavior` used
`entity.get_control_behavior()`, which returns nil for an UNWIRED lamp (a lamp has no control behavior until
wired; wires restore in a separate phase) -> early return -> all CB settings skipped. Verified live: unwired
lamp `get_control_behavior()`=nil; but `get_or_create_control_behavior()` + a FLAT circuit_condition write
reads back signal-B. Fix: `get_or_create_control_behavior()` (order-independent; the
`entity_data.control_behavior` guard means a CB is only created on an entity that had one at export).
PRE-EXISTING latent restore gap (branch didn't touch CB restore) exposed by the new circuit test. Additive
(control config, not gate-counted).
