---
name: tests
description: Run, add, promote, or debug tests in this repo — the canonical workflows for the pad gallery, the integration suite, testkit, and the teeth discipline. Load before touching anything under tests/ or authoring a fixture.
---

# tests — the one place the test workflows live

Everything here is the CURRENT contract (2026-07-26, post meter-unification). The taxonomy and
measurement model live in [docs/testing.md](../../../docs/testing.md); this skill is the hands-on-keys
subset. One-truth ruling applies throughout: values live in `tests/lab-gallery/manifest.json` ONLY.

## Run things

```bash
# The whole integration suite (cluster must be UP). THE runner — also the single CI step:
node tools/run-integration-tests.mjs                 # --only '<regex>' / --skip / --list

# Root unit tests (manifest validation, testkit, fixture-meters) — no cluster:
npm test                                             # glob tests/**/*.test.mjs, auto-wires new files

# Plugin unit tests (messages round-trip, orchestrator, locks) — run in the stripped host container:
docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npm test'

# In-game gallery runner (all pads on the live save; needs the roster pushed first):
node tests/lab-gallery/push-roster.mjs --instance clusterio-host-1-instance-1
./tools/rcon.ps1 11 "/test-run"                      # or "/test-run <name-filter>"

# Static cross-reference integrity (no cluster) / + live anchor resolution:
node tools/testkit/cli.mjs check [--live]
```

After editing Lua (`module/`): `./tools/patch-and-reset.ps1` (save-patched — a plain restart reuses the
old Lua), then RE-PUSH the roster (the baked one is stale after a reset).

## Add or promote a fixture assertion (1 file)

A property the engine exposes = a `manifest.json` edit alone. Measure first, then declare:

```bash
node tools/testkit/cli.mjs probe lab-omnibus-state-v1 'heat-pipe@43,-13:temperature'   # 1. measure
# 2. add to the fixture's lifecycle.verify:
#    { "check":"physical_read", "locator":{"anchor":"heat-pipe"}, "read":"property",
#      "path":"temperature", "op":"eq", "expected":500 }
#    op "approx" ONLY for the crafting/bonus progress doubles; anchor = an entry in THIS fixture's anchors.
# 3. push roster + /test-run (above). 4. TEETH: sabotage expected by one unit -> must go RED -> restore.
```

Promote a pad to a real cross-instance transfer: set `lifecycle.act` to `"transfer"` and
`owningRunner` to `tests/integration/pad-transfer-suite/run-tests.mjs`. Reads with no `end` field run on
the transfer destination AND on both local pad halves — one verify list, every runner.

Reads available: `property` (dotted path, indexing only), `item_count`, `held`, `fluid`, `spoil_percent`,
`crafting_progress`, `entity_present`, `surface_entity_count`, `infinity_pipe_filter`. Method-shaped
state (recipes, module inventories, circuit sections) needs a bespoke meter — ask before adding one.

## Debug a failure

- `/cluster-logs` skill finds what actually happened (plugin errors live in FILES, not docker logs).
- `/repro-transfer` reproduces a transfer end-to-end locally — default over reading CI logs.
- Payload questions: `node tools/testkit/cli.mjs inspect <platform> --field 'name@x,y:dotted.path'` —
  exit 1 = absent (cannot survive), exit 2 = wrong path (it prints the real one). Present ≠ survives.
- Leftover scratch platforms after a crashed run: `./tools/cleanup-test-surfaces.ps1` (protected
  fixtures are never deleted).

## Standing rules (owner rulings — do not relearn these by incident)

- **Belts/pipes: any failure gets DISCUSSED, not fixed.** `belt-combined-omnibus` is excluded from
  PASTE only (real Phase-5B corner hazard, 372→368); its real TRANSFER runs green.
- **Teeth or it didn't happen** (di-change): a new check ships with its sabotage run (RED observed, then
  restored). Corrupt the exact field the check reads.
- **No new agreement-checks**: a check that two things agree = one fact in two places — delete the copy.
  Trust boundaries (hook allowlist, version-certification) and product contracts (exact gate, 2PC) are
  the named exceptions.
- **Zero leftovers**: suites restore the live golden pair and leave no `se-lifecycle-scratch-*`
  platforms, no locks, game unpaused. Scope every container predicate to `surface-export-*` — the
  atlas cluster shares this machine.
