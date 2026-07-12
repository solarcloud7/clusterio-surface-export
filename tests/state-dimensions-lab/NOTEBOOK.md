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