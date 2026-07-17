# Test Runner Inventory

This is the canonical SC-41 inventory of executable tests and guards. The taxonomy and lifecycle rules are in
[`docs/lab-tests.md`](../docs/lab-tests.md). The inventory is intentionally incomplete while SC-41 is in progress;
an absent runner has not yet been classified.

Each row owns exactly one current category and one final disposition. When one executable mixes unrelated
questions, the row classifies the executable as `obsolete/duplicate`; the section table records the replacement
boundary without pretending the existing file already satisfies that boundary.

Allowed categories are `unit/contract`, `integration regression`, `physical lab`, `longitudinal drift benchmark`,
and `obsolete/duplicate`. Allowed final dispositions are `retain`, `bake`, `simplify`, `promote`, `merge`, and
`retire`.

## Inventory

| Executable | Current category | Contract or invariant | Setup and production path | Production-analytics overlap | Independent oracle | Lifecycle flags | Final disposition |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [`tests/ops-lab/run-lab-tail.mjs`](ops-lab/run-lab-tail.mjs) | `obsolete/duplicate` | Mixed: T2 transfer-duration sampling, T3 RCON command-capacity discovery, and T4 export-readiness scaling. | T2 invokes `/transfer-platform`; T3 sends direct RCON `/sc`; T4 calls the production `export_platform` interface. T2/T4 construct fixtures at runtime. | Yes for T2/T4: custom wall clocks, entity totals, payload bytes, worst-case margins, and pseudo-percentiles overlap the production transfer record. T3 measures a separate infrastructure boundary. | No. T2/T4 read production state and verdicts; they do not independently audit the production analytics. | Runtime clone: yes. Runtime construction: yes. Between-run cleanup: yes. Artificial large fixture: yes. Direct storage clear: yes. Unconditional unpause: yes. | `retire` after the approved T2 and T3 replacements exist; T4 has no replacement by default. |
| [`tests/specialized-inventory-lab/run-reachability.mjs`](specialized-inventory-lab/run-reachability.mjs) | `physical lab` | At Factorio 2.0.77, classify platform-reachable specialized fluid state using prototype surface conditions and a baked mining-drill fluidbox control. | Loads the hash-pinned gallery source save in an isolated Factorio process and reads the existing fixture; it does not invoke transfer production code. | No. | Yes: direct prototype, surface-property, placement-capability, and live-fluidbox reads are the physical oracle. | Runtime clone: no. Runtime construction: no. Between-run cleanup: no; reset discards the loaded save. Artificial large fixture: no. Direct storage clear: no. Unconditional unpause: no. | `bake` completed: revision 1 is manifest-owned and consumes the paired source artifact. |
| [`tests/specialized-inventory-lab/run-reachability.test.mjs`](specialized-inventory-lab/run-reachability.test.mjs) | `unit/contract` | The evidence classifier, section parser, tick handling, Lua failure boundary, manifest fixture-fingerprint verification, and BLOCKED-vs-FAILED lease classification reject invalid or incomplete evidence. | Node process-local fixtures; no Factorio process or production operation. | No. | Not applicable; this test validates software contracts around already-banked evidence. | No live fixture lifecycle behavior. | `retain`. |

### `ops-lab` section disposition

| Section | Target category | Approved action | Preserve | Remove or replace |
| --- | --- | --- | --- | --- |
| T2 | `longitudinal drift benchmark` | `bake` + `simplify` | The real `/transfer-platform` path, terminal production transaction record, stable fixture identity/revision, and the existing unexplained failure evidence. | Replace five runtime clones with untouched baked fixtures. Remove the runner stopwatch, five-sample “p99”, 1.5x recommendation, artificial 700-item densification, entity recounts, and between-run cleanup. |
| T3 | `integration regression` | `retain` in a separate executable | A deterministic end-to-end assertion that the deployed RCON transport carries the production chunk size. | Split it from save and platform lifecycle code. Keep the fixed production threshold, not open-ended boundary discovery. It needs no baked fixture and must not inherit T2/T4 cleanup. |
| T4 | `obsolete/duplicate` | `retire` | Nothing by default. Reconsider only if scale or payload size becomes an explicitly justified experimental variable. | Remove the small/normal/large runtime construction and the duplicate latency recommendation. Use production export and payload analytics for routine drift. |

The current runner's mixed entry point is visible in its [`t2`, `t3`, and `t4` section list](ops-lab/run-lab-tail.mjs#L6).
T2 clones five platforms, deletes state between samples, creates an artificial large arm, and computes a
five-sample worst-case proxy rather than a percentile ([T2](ops-lab/run-lab-tail.mjs#L21)). T3 is a direct RCON
capacity search with no physical fixture ([T3](ops-lab/run-lab-tail.mjs#L23)). T4 constructs small, normal, and
large platforms at runtime and times export visibility ([T4](ops-lab/run-lab-tail.mjs#L24)). The shared cleanup
deletes matching surfaces and exports, clears `storage.ops_lab`, and unconditionally writes
`game.tick_paused=false` ([cleanup](ops-lab/run-lab-tail.mjs#L18)); no repository producer of `storage.ops_lab`
exists at this inventory revision.

The production transfer summary already records total duration, phase durations, export metrics, payload metrics,
import metrics, validation, and source verification
([transaction summary](../docker/seed-data/external_plugins/surface_export/lib/transaction-logger.ts#L107-L151)).
The export record includes request/lock time, controller-store wait, payload sizes, and exported entity/item totals
([metric contracts](../docker/seed-data/external_plugins/surface_export/shared/dto.ts#L125-L174)). Validation
includes expected/actual item totals and the failure-black-box reference
([validation contract](../docker/seed-data/external_plugins/surface_export/shared/dto.ts#L176-L223)). These are the
canonical operational meters; replacement drift runners add fixture/save provenance but do not copy or recompute
their measurements.

The T2 notebook's fifth transfer failed the exact item gate by four items. That result remains a **hard-stop,
unexplained conservation failure**, not timeout evidence, and the unexecuted scale arms remain unexecuted
([notebook](ops-lab/NOTEBOOK.md#L6-L33)). Preserve that notebook and its referenced production failure black box;
do not use the failed run as a performance baseline or promote a mechanism that it did not establish.

### Specialized reachability disposition

The baked meter's prototype rung records pressure/gravity controls, prototype fluidbox counts, surface conditions,
and placement capability ([prototype rung](specialized-inventory-lab/baked-reachability-meter.cjs#L16-L32)). Its placement
rung reads the single baked mining drill and proves that the live entity has no readable or writable fluidbox on the platform
([placement rung](specialized-inventory-lab/baked-reachability-meter.cjs#L33-L43)). Both rungs answer the same engine-
behavior question, so they remain one physical lab rather than being split by section.

The runner verifies the committed source hash, loads it in a prefix-owned disposable Factorio process, and discards
that loaded process for reset ([loaded-save boundary](specialized-inventory-lab/run-reachability.mjs#L55-L94)).
It performs no fixture construction, storage clearing, or game unpause. The baked replacement keeps the tick/version
stamp and direct physical readings while making the manifest fixture and paired-save reload the lifecycle boundary.
It still does not invoke transfer code: this is the retained engine-recertification rung, not an integration test.

The append-only notebook documents the controls-driven correction: prototype capability initially suggested an
omission, while the live entity proved `mining_target=nil` and `#entity.fluidbox=0`; the provisional shared-fluid
repair was retracted ([conclusion](specialized-inventory-lab/NOTEBOOK.md#L69-L94)). The separate Node test retains
the deterministic evidence and safety contracts, including tick zero and rejection of transfer or silent-unpause
logic ([contract tests](specialized-inventory-lab/run-reachability.test.mjs#L54-L165)).
