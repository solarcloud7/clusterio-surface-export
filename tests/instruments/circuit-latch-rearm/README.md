# Latch restoration research — Factorio 2.1.17

## Baseline contract, 2026-09-07

Before trying a replacement, reproduce the unchanged deployed rearm method failing
to preserve a nonzero, stable self-feedback memory register. This is the documented
count-restoration limitation, not proof of every separate audit finding.

One disposable platform holds two source deciders and six empty destinations:
three boolean-latch controls and three independent multi-signal memory attempts.
Sources are armed by real constant-combinator inputs, which are destroyed before
capture. Source registers must remain identical in two later observations and
through the test. Memory contains positive, negative and quality-specific signals.
Destinations carry original parameters and self-feedback wires but begin empty.
Invoke the unchanged deployed `LatchRearm.schedule`, wait for its terminal result,
then independently read both combinator registers and physical wire signals.

PASS for the controls requires exact captured signals and original parameters.
Reproduction requires all three memory destinations to lose their captured values,
with source registers unchanged and original parameters restored. This produces a
STOP result: the baseline defect exists. Any other result stops investigation as
inconclusive/HARNESS_ERROR, without trying a candidate or weakening the oracle.
Ticks, entity IDs and source counts accumulated during initial arming are telemetry;
the invariant is the captured post-arming register, not a hard-coded arming duration.

No production edits, transfer, global pause, clone, signal injection after capture,
manual clear or fallback may make restoration pass. Engine simulation between
callbacks is explicitly required. API shape is checked against the saved official
2.1.17 schema. The runner hashes itself, the Lua fixture, API manifest and local
production rearm source. An injected constructor exception proves owned cleanup.

Budget: two platform creations (cleanup proof plus fixture), 45 completion polls,
under 16 KiB per RCON body, 128 KiB per reply, and under 120 seconds of normal runtime
(transport calls have their existing separate timeout). Refuse players, pauses,
jobs, locks, holds, tombstones, pending rearm work and fixture leftovers. Finally
delete only the owned platform/storage/result and independently check absence.

Run `node tests/instruments/circuit-latch-rearm/run-constant-seed.mjs`.
Analyze saved evidence without the cluster using `--analyze`.
Raw output: `ci-artifacts/latch-baseline-reproduction.json`.

## Baseline result

The unchanged 2.1.17 deployment lost memory in 3/3 independent destinations while
the boolean controls passed 3/3. Captured source: S=5969, Q=-889, iron-plate/rare=381.
All memory destinations ended empty and were reported `cleared`; source values and
original parameters remained unchanged. Both wire readback and combinator registers
agreed. Injected-failure cleanup and final independent cleanup passed. This confirms
the documented arbitrary-count limitation, not the other audit failure hypotheses.

## Candidate contract, before running

The official `DeciderCombinatorOutput.constant` field can emit an explicit int32
when `copy_count_from_input=false`. A candidate can temporarily emit each captured
signal with its exact value, then restore original parameters. This is not a direct
register setter. It must prove register continuity after restoration, isolation
from live consumers, scheduling, power loss, and changing counters before production
use. `signals_last_tick` remains read-only. No candidate run is authorized by a
baseline HARNESS_ERROR or inconclusive result.

Run with `--candidate` only after a retained baseline STOP. Use the same fixture,
three independent destinations and three boolean controls. Temporarily replace
destination conditions/outputs with an always-true condition and explicit captured
signal constants. Observe exact seeded outputs, restore original parameters, allow
normal engine ticks, and require exact full-register and wire-signal equality plus
original parameter equality. Source values must remain stable throughout. No clear,
heuristic classification, repeated retry, or compensating constant combinator is
allowed. Success only certifies these isolated memory cells, not a whole network,
consumer isolation, moving counters, power loss, failure handling or transfers.
Candidate output uses a separate `ci-artifacts/latch-constant-seed-result.json`.

## Candidate result

The isolated candidate passed 3/3 memory destinations and 3/3 boolean controls on
Factorio 2.1.17. Candidate source values were S=5781, Q=-861 and iron-plate/rare=369;
all destinations matched every signal after original-rule restoration, including
wire readback. Original parameters matched exactly. Sources held their captured
values throughout. No permanent helper entities, fallback clear or production edits.
Injected-failure cleanup and postflight passed on both runs.

Baseline fingerprint: 24edcb5612e17e40dbe5d235a993a2101809edf838feebe9de864574e00d462b.
Candidate fingerprint: f21eba926071b680dbe59e289aeddd18fdb192ce8a20baf60d75717bafd075e7.

The differing source values result from external arming duration, explicitly outside
the invariant. Both runs require preservation of the captured stable source register.
The arbitrary-count loss is reproduced; the audit hypotheses concerning write errors,
slow counters, extra signals and overlapping transfers are NOT reproduced by this fixture.
Next rungs must test coupled circuits and changing counters at tick boundaries,
output isolation, power interruption, failed restoration writes, and full transfer
admission/completion before integrating a replacement. No performance claim is made.

API source: https://lua-api.factorio.com/latest/concepts/DeciderCombinatorOutput.html
(`constant` is an explicit int32 output value when input copying is disabled).

## Installed-code acceptance, 2026-09-07

`run-constant-seed.mjs --installed` invokes the deployed production stage machine,
preserving the baseline and standalone candidate artifacts in their original files.
Its independent full-register/wire oracle is unchanged. It passed all three signed,
quality-specific memory cells and all three boolean controls. Output:
`ci-artifacts/latch-installed-result.json`; whole-command elapsed time: 15.48 seconds.

`run-transfer.mjs` adds a real host-1 to host-2 transfer and two downstream deciders
connected by green wires. It checks the captured stable source memory, both consumers,
the boolean latch, original rules, completed restoration result, and source deletion.
It does not assert uninterrupted consumer output during import, arbitrary coupled-network
state, or preservation of a running counter's exact phase. No clear or permanent helper
may satisfy its oracle. A constructor fault exercises cleanup of the entire owned fixture.
It creates two owned platforms sequentially (fault proof, then real fixture), uses at most
45 completion polls, and deletes only its own platform/storage/results on both hosts.
The normal budget is 120 seconds plus existing transport timeouts. No game-wide pause or
protected fixture mutation. Raw output is `ci-artifacts/latch-transfer-result.json`;
`--analyze` rechecks saved output without game access.

Harness errors are preserved separately: scalar JSON preflight, invalid wire construction,
and an observer that assumed unsnapped positions. All mutated fixtures were cleaned up.
The first admitted transfer attempt also caught a production integration regression:
the new surface-lock guard used a runtime `require`, which Factorio forbids. The module
import now occurs at load time, and the state-machine selftest calls the actual lock entry
point. The rejected command never exported the fixture; evidence is retained as
`ci-artifacts/latch-transfer-guard-regression.json`.

After the load-time import correction, the full transfer passed on Factorio 2.1.17:
all four observed registers and their original rules matched, the two memory sources
reported verified restoration, the source platform was deleted, and independent cleanup
passed on both hosts. Whole-command time was 27.78 seconds. The state-machine selftest
passed 26 checks, including failed-write retry, unexpected signals, legacy interrupted
jobs and the actual export lock entry point. The existing latch/counter transfer regression
also passed (29.43 seconds); the counter resumed advancing without a destructive clear.
This does not certify counter phase continuity or uninterrupted consumer output during import.

The powered/unpowered regression passed in 67.33 seconds: the powered latch completed,
the dark decider stayed pending until its bounded power deadline, then reported failure
with original rules intact. Both owned platforms were removed. These timings include test
setup and deliberate observation waits; they are not the restoration's processing time.

Final deployment preserved both saves and rechecked their surface/platform census and player
positions. After the final diagnostic-only adjustment, all 26 state-machine checks passed;
both instances had zero jobs, locks, holds, tombstones, pending restoration jobs or owned
fixture platforms, with ticks unpaused (`ci-artifacts/latch-final-acceptance.json`). The plugin
unit suite passed 643 tests with eight environment-dependent skips. Full lint remains blocked
by two existing unbound catches in `controller.ts` and `lib/entity-evidence.ts`; the changed
Lua syntax, invariants, error-reporting and allow-manifest guards pass. No new CI run or
publication is claimed by this local acceptance record.

## Power-wait removal acceptance, 2026-09-07

The full-transfer fixture now records the production scheduled, first-seed, per-entity seed
and completion ticks. On Factorio 2.1.17, both captured memory cells were `working` at the
first seed callback, two ticks after scheduling. Restoration finished at six ticks, preserving
all four observed registers and original rules. The same assertions passed after removing
the inherited 1800-tick power retry. Baseline and final raw artifacts are
`ci-artifacts/latch-readiness-baseline.json` and `ci-artifacts/latch-readiness-final.json`;
the final whole command took 25.70 seconds. This fixture does not establish readiness for
every possible power system or certify recovery when power returns later.

The replacement `tests/integration/latch-rearm-liveness/run-tests.mjs` uses two owned platforms
with one self-feedback decider each and no helper signal. Both start with empty registers;
the powered one must end at exactly S=7, the dark one must fail without a seed write, and
both must preserve original parameters. It checks measured completion at six ticks with
bounded polling instead of fixed observation windows. Construction-failure cleanup and final
cleanup passed. Whole-command duration was 9.80 seconds versus the earlier local 67.33 seconds;
this includes control calls, not just Lua work. An initial harness error tried to delete a
surface before the starter pack created one; cleanup now uses `LuaSpacePlatform.destroy(0)`
and verifies absence. The failed artifact is retained as `latch-readiness-harness-error.json`
under `ci-artifacts`; it is not restoration evidence.

All 30 installed state-machine checks passed, including mixed ready/unpowered items, ignoring
an old saved deadline, and rejecting stale matching signals after power loss. Both instances
finished with zero owned fixtures or pending restoration jobs and ticks unpaused. Deployment
preserved both saves, platform census and player positions. No full CI run is claimed here.
