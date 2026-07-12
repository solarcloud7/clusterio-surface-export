# Specialized Handler Inventory Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Follow the canonical [agent execution discipline](../../AGENT_EXECUTION_DISCIPLINE.md). This is a data-integrity change on the source-delete path; `/di-change` and an external audit are mandatory.

**Goal:** Ensure every ordinary entity inventory represented on the source is serialized, restored, and included symmetrically in the exact transfer gate before source deletion can occur.

**Architecture:** Keep specialized handlers responsible for category-specific state, but make ordinary inventory capture a shared dispatcher invariant. The shared dispatcher adds `InventoryScanner.extract_all_inventories(entity)` only when a specialized handler did not already supply `data.inventories`, avoiding duplicate extraction while closing omissions such as burner-inserter fuel. The existing exact gate remains unchanged: once the payload contains the inventory, export verification and the destination physical census become commensurate automatically.

**Tech Stack:** Factorio 2.0.77 Lua runtime, save-patched module, PowerShell integration probes, Node test/lint harness, two-host Clusterio dev cluster.

## Global Constraints

- Implement this as a separate prerequisite PR; do not hide it inside the unfinished `feat/state-dimensions` closer.
- Do not alter exact-gate tolerances, expected-count subtraction, source-delete semantics, or item-quality key formatting.
- `currently_burning` is engine state, not an inventory slot; do not count it as an item or duplicate it into `data.inventories`.
- Reuse `InventoryScanner.extract_all_inventories(entity)`; do not introduce a second inventory scanner.
- The successful fixture uses non-normal quality and more fuel than any other item name so the existing one-shot loss hook deterministically targets fuel.
- Preserve `package-lock.json` byte-for-byte.
- No new lint allow annotation without prior orchestrator approval and a manifest entry.
- Stop for audit before merge, then watch main's post-merge run before resuming state-dimensions.

---

## Problem Statement

### Observed failure

The live `entity-burner-roundtrip` fixture placed ten coal in a burner-inserter's fuel inventory and set a distinct current fuel state:

```text
source physical:      coal=10, currently_burning=solid-fuel/normal
source gate expected: {"space-platform-foundation":10}
destination physical: coal=0, currently_burning=solid-fuel/normal
destination gate actual: {"space-platform-foundation":10}
validation_success:   true
source outcome:       deleted
```

The exact gate did not malfunction relative to its inputs. Its expected set was incomplete because the serialized entity omitted the burner-inserter fuel inventory. Expected and actual therefore agreed on the wrong universe, and source deletion made the omitted coal loss permanent.

Evidence is banked in [the state-dimensions notebook](../../../tests/state-dimensions-lab/NOTEBOOK.md) under `burnerrt-163355`, with debug result `debug_import_result_burnerrt-163355_196255.json`.

### Static cause

`EntityHandlers.handle_entity(entity, category)` has two mutually exclusive paths:

```lua
if handler then
  data = handler(entity)
else
  data = {}
  local inventories = InventoryScanner.extract_all_inventories(entity)
  if #inventories > 0 then data.inventories = inventories end
end
```

`EntityHandlers["inserter"]` is specialized, so it never executes the default inventory path. It serializes held-stack and inserter settings but not `defines.inventory.fuel`. `extract_common_state()` captures `currently_burning` and remaining fuel energy, but deliberately omits fuel inventory items under the false assumption that normal inventory export already captured them.

This is broader than one prototype. There are 28 specialized categories in `entity-handlers.lua`; only 14 visibly call `extract_all_inventories`. Some omitted categories may genuinely have no inventories in vanilla, but modded prototypes can add inventory-bearing energy sources or storage. The fix must establish the shared invariant without double-counting categories that already capture inventories.

## What We Tried and Learned

1. **MC1 mid-craft lab:** after fixing two fixture defects, measured `RESUME-CLEAN`; embodied item value stayed `4 -> 4`. No refund mechanism is needed.
2. **Deactivated writes:** accumulator energy, in-range machine energy, and reactor temperature all wrote and read back exactly while inactive.
3. **Burner state probe:** `currently_burning` and `remaining_burning_fuel` restore while inactive; clearing and refilling the fuel inventory does not mutate them.
4. **Meter correction:** `currently_burning.name` and `.quality` read as userdata-backed prototypes on 2.0.77. Resolving non-string values through `.name` proved the setter worked.
5. **Focused roundtrip:** current fuel state survived, but the ordinary coal fuel inventory vanished `10 -> 0` while validation passed.
6. **Static trace:** the inserter specialized handler bypasses ordinary inventory extraction. The debug expected map independently proves coal never entered the serialized verification universe.
7. **Scope stop:** no production, gate, or validator change was attempted after the hard stop.

## What We Are Trying to Achieve

The invariant is:

> For every source entity, every ordinary inventory returned by `get_max_inventory_index()` and accepted by `InventoryScanner.extract_all_inventories()` must appear exactly once in serialized entity data, feed export verification exactly once, restore exactly once, and be counted physically by the destination gate before source deletion.

Success requires both directions of proof:

- **Happy path:** a non-normal-quality burner fuel stack survives physically and appears in payload expected counts and destination actual counts.
- **Adversarial path:** removing that fuel before the gate produces an item mismatch, discards the destination, and preserves the source.

## Decisions Requested at Audit

1. **Fix boundary:** Approve the shared-dispatcher invariant below rather than an inserter-only patch. Recommended: yes, because the defect class is “specialized handler bypasses default cross-cutting state.”
2. **Existing handler ownership:** Approve “keep an existing non-`nil` `data.inventories`; otherwise attach the shared scan.” Recommended: yes, to avoid rescanning or duplicating the 14 handlers that already own inventory ordering.
3. **Empty table semantics:** Treat `data.inventories = {}` as an explicit handler result and do not rescan, or rescan whenever `#data.inventories == 0`? Recommended: rescan only when the field is `nil`; audit must confirm no handler intentionally sets `{}` before later population.
4. **PR sequencing:** Approve a separate prerequisite PR merged before the state-dimensions branch resumes. Recommended: yes.
5. **Circuit-config test:** Keep its unresolved source-fixture failure out of this PR. Recommended: yes; it has no bearing on inventory accounting.

---

### Task 1: Inventory Ownership Matrix and Red Regression Teeth

**Files:**
- Create: `docker/seed-data/external_plugins/surface_export/test/specialized-inventory-accounting.test.cjs`
- Modify: `tests/integration/entity-burner-roundtrip/run-tests.ps1`
- Reference: `docker/seed-data/external_plugins/surface_export/module/export_scanners/entity-handlers.lua`

**Interfaces:**
- Consumes: `EntityHandlers.handle_entity(entity, category)` and existing `test_force_item_loss` one-shot hook.
- Produces: a red pre-fix integration fixture and a static ownership matrix that later tasks must satisfy.

- [ ] **Step 1: Enumerate specialized handlers and their current inventory ownership**

Create a table in the test containing every `EntityHandlers["category"]` definition and classify it as:

```js
{
  category: "inserter",
  handlerOwnsInventories: false,
  sharedDispatcherMustAttach: true,
}
```

The test must parse `entity-handlers.lua` and fail if a new specialized category is added without an explicit classification. This is a test inventory, not production metadata.

- [ ] **Step 2: Strengthen the live burner fixture before changing production**

Update the fixture to put 20 legendary coal in the burner-inserter fuel inventory while keeping current fuel distinct:

```lua
local fi = e.get_inventory(defines.inventory.fuel)
local inserted = fi.insert({ name = "coal", quality = "legendary", count = 20 })
if inserted ~= 20 then error("legendary coal fixture write rejected: " .. tostring(inserted)) end

e.burner.currently_burning = { name = "solid-fuel", quality = "normal" }
e.burner.remaining_burning_fuel = 2000000
```

Twenty fuel items exceed the starter pack's ten foundations, making fuel the deterministic target of the existing “remove most abundant item” loss hook.

- [ ] **Step 3: Add producer, transport, gate, and physical witnesses**

The test must assert all of these independently:

```text
source physical fuel inventory       coal:legendary = 20
serialized entity inventory payload  coal:legendary = 20
export verification expected map     coal:legendary = 20
destination frozen physical census   coal:legendary = 20
validation expectedItemCounts        coal:legendary = 20
validation actualItemCounts          coal:legendary = 20
destination live physical inventory  coal:legendary = 20
```

Use the canonical quality-key helper in Lua and derive counts from recorded results. Do not hardcode aggregate totals.

- [ ] **Step 4: Run the regression test on pre-fix code**

Run:

```powershell
node tools/run-integration-tests.mjs --only '^entity-burner-roundtrip$'
```

Expected pre-fix result: RED, with serialized expected coal absent and physical destination coal `0`. Bank the result in `tests/state-dimensions-lab/NOTEBOOK.md`.

- [ ] **Step 5: Commit tests before implementation**

```powershell
git add docker/seed-data/external_plugins/surface_export/test/specialized-inventory-accounting.test.cjs tests/integration/entity-burner-roundtrip/run-tests.ps1 tests/state-dimensions-lab/NOTEBOOK.md
git commit -m "test(inventory): expose specialized-handler omissions"
```

### Task 2: Shared Ordinary-Inventory Invariant

**Files:**
- Modify: `docker/seed-data/external_plugins/surface_export/module/export_scanners/entity-handlers.lua`
- Test: `docker/seed-data/external_plugins/surface_export/test/specialized-inventory-accounting.test.cjs`

**Interfaces:**
- Consumes: handler-specific `data` and `InventoryScanner.extract_all_inventories(entity)`.
- Produces: `EntityHandlers.attach_missing_inventories(entity, data)` returning the same data table with ordinary inventories attached at most once.

- [ ] **Step 1: Add the narrow shared helper**

Implement immediately above `handle_entity`:

```lua
function EntityHandlers.attach_missing_inventories(entity, data)
  data = data or {}
  if data.inventories == nil then
    local inventories = InventoryScanner.extract_all_inventories(entity)
    if #inventories > 0 then
      data.inventories = inventories
    end
  end
  return data
end
```

This helper does not count items, alter quality keys, inspect held stacks, or touch belt-line payloads.

- [ ] **Step 2: Route both dispatcher paths through the invariant**

Replace the default-only inventory block with one shared call after the category handler returns:

```lua
local data = handler and handler(entity) or {}
data = EntityHandlers.attach_missing_inventories(entity, data)
EntityHandlers.extract_common_state(entity, data)
```

Preserve all existing handler behavior and the existing `next(data)` return contract.

- [ ] **Step 3: Correct the false burner comment**

Document the actual invariant beside `extract_common_state()`:

```lua
-- Burning item and remaining energy are engine state. Ordinary fuel and burnt-result inventories
-- are attached once by attach_missing_inventories(), whether or not a category handler exists.
```

- [ ] **Step 4: Run focused host tests**

Run:

```powershell
docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npm test'
```

Expected: all host tests pass, including the ownership matrix.

- [ ] **Step 5: Commit the implementation**

```powershell
git add docker/seed-data/external_plugins/surface_export/module/export_scanners/entity-handlers.lua
git commit -m "fix(serializer): capture inventories for specialized handlers"
```

### Task 3: Successful Transfer and Exact-Gate Commensurability

**Files:**
- Modify: `tests/integration/entity-burner-roundtrip/run-tests.ps1`
- Append: `tests/state-dimensions-lab/NOTEBOOK.md`

**Interfaces:**
- Consumes: shared inventory invariant from Task 2.
- Produces: one complete happy-path proof from physical source through source deletion.

- [ ] **Step 1: Rebuild and reset save-patched Lua**

Run the normal save-patch workflow from the dedicated branch, then poll both instances for RCON readiness. Do not use fixed sleeps as readiness gates.

- [ ] **Step 2: Run the focused successful transfer**

```powershell
node tools/run-integration-tests.mjs --only '^entity-burner-roundtrip$'
```

Expected: every source/payload/expected/frozen/actual/live witness reports `coal:legendary=20`; `currently_burning=solid-fuel/normal` remains distinct; source deletion occurs only after the exact gate succeeds.

- [ ] **Step 3: Verify no double counting**

Assert the expected item count for legendary coal is exactly 20, not 40. Also assert normal coal remains absent so quality-key drift cannot hide duplication.

- [ ] **Step 4: Append the successful evidence**

Record the transfer ID, debug filename, per-layer coal values, source deletion result, and both-host zero-state block in the notebook.

- [ ] **Step 5: Commit the permanent integration tooth**

```powershell
git add tests/integration/entity-burner-roundtrip/run-tests.ps1 tests/state-dimensions-lab/NOTEBOOK.md
git commit -m "test(inventory): prove burner fuel conservation"
```

### Task 4: Forced Fuel Loss Must Preserve the Source

**Files:**
- Modify: `tests/integration/entity-burner-roundtrip/run-tests.ps1`
- Append: `tests/state-dimensions-lab/NOTEBOOK.md`

**Interfaces:**
- Consumes: existing debug-gated, one-shot `test_force_item_loss` hook.
- Produces: a destructive-path regression tooth proving omitted fuel can no longer pass the gate.

- [ ] **Step 1: Add a `loss` section to the runner**

Support section selection:

```powershell
param([ValidateSet('success','loss')] [string[]] $Sections = @('success','loss'))
```

The loss section creates the same 20-legendary-coal fixture and arms `test_force_item_loss=1` on the destination. Because coal count 20 exceeds foundation count 10, the existing hook must log that it removed legendary coal. Assert the hook log directly; never infer firing from a red verdict.

- [ ] **Step 2: Assert the failure contract**

Require:

```text
validation_success = false
itemCountMatch = false
failedStage = items
expected coal:legendary = 20
actual coal:legendary = 19
source platform still exists and is unlocked
held destination is discarded
```

A failure for any other item name or stage is not acceptable evidence.

- [ ] **Step 3: Assert cleanup and hook disarm in `finally`**

Prove on both hosts: zero fixture surfaces, zero locks, zero destination holds, zero async jobs, zero committed tombstones for the fixture, game unpaused, and `test_force_item_loss` absent or zero.

- [ ] **Step 4: Run focused sections**

```powershell
pwsh tests/integration/entity-burner-roundtrip/run-tests.ps1 -Sections success
pwsh tests/integration/entity-burner-roundtrip/run-tests.ps1 -Sections loss
```

Expected: both sections green for their respective contracts.

- [ ] **Step 5: Commit the destructive-path tooth**

```powershell
git add tests/integration/entity-burner-roundtrip/run-tests.ps1 tests/state-dimensions-lab/NOTEBOOK.md
git commit -m "test(inventory): fail closed on burner fuel loss"
```

### Task 5: DI Review, Full Regression, and Prerequisite PR

**Files:**
- Modify: PR body only; no new production scope.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: one audited prerequisite PR suitable to merge before state-dimensions resumes.

- [ ] **Step 1: Run the `/di-change` checklist**

The impact map must explicitly trace:

```text
physical source inventory
-> InventoryScanner.extract_all_inventories
-> entity specific_data.inventories
-> Verification.count_all_items
-> serialized payload
-> Deserializer.restore_inventories
-> SurfaceCounter.count_items
-> TransferValidation.validate
-> controller source-delete decision
```

Review all specialized categories for duplication and every return path from `handle_entity()`.

- [ ] **Step 2: Run focused static and host verification**

```powershell
node --test docker/seed-data/external_plugins/surface_export/test/specialized-inventory-accounting.test.cjs
npm run lint

docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && npm test'
```

Expected: all green; `package-lock.json` unchanged.

- [ ] **Step 3: Run two consecutive full integration suites**

```powershell
node tools/run-integration-tests.mjs
node tools/run-integration-tests.mjs
```

Expected: both full runs green with derived summaries and complete both-host zero-state evidence. A known belt-only anomaly follows its existing retry rule; any other item/fluid loss is a hard stop.

- [ ] **Step 4: Open one prerequisite PR and stop**

PR title:

```text
fix(serializer): preserve inventories on specialized entities
```

The PR body leads with the reproduced `coal 10 -> 0` fail-open, includes the handler matrix, successful 20-legendary-coal chain, forced `20 -> 19` failure contract, `/di-change` checklist, and full-suite evidence. No circuit-config or unrelated state-dimension fix may ride in this PR.

- [ ] **Step 5: Stop for adversarial audit**

The reviewer must attack:

- double counting in handlers that already supply `data.inventories`;
- modded specialized entities with inventories;
- held-stack versus fuel-inventory duplication;
- quality-key preservation;
- gate expected/actual commensurability;
- source preservation on forced loss.

### Task 6: Resume the State-Dimensions Closer After Merge

**Files:**
- Rebase and continue: `feat/state-dimensions`
- Reference: `docs/superpowers/plans/2026-07-11-state-dimensions-closer-brief.md`

**Interfaces:**
- Consumes: merged prerequisite PR and green main post-merge run.
- Produces: continuation of the previously interrupted nine-test sweep.

- [ ] **Step 1: Watch main's post-merge run**

Do not resume until main's own push run is green.

- [ ] **Step 2: Rebase the state-dimensions branch**

Preserve the banked MC1 and hard-stop evidence. Resolve the burner integration test in favor of the merged prerequisite version.

- [ ] **Step 3: Restart at the interrupted test boundary**

Re-run `entity-burner-roundtrip` first to prove the merged fix in the closer context. Then continue the remaining state-dimension sections. Keep the unresolved circuit-config fixture in its own focused debugging loop; do not weaken its dynamic-evaluation claim.

## Acceptance

- The pre-fix fixture is red for the exact omission observed in `burnerrt-163355`.
- Every specialized handler's inventory ownership is explicit and mechanically guarded.
- Ordinary inventories are serialized at most once for every handler path.
- Legendary burner fuel is `20` at physical source, payload, expected gate map, frozen destination, actual gate map, and live destination.
- A forced legendary-fuel loss produces `20 -> 19`, fails the item gate, discards destination, and preserves source.
- Exact-gate code and tolerances are unchanged.
- Two consecutive full integration suites pass with both-host zero-state evidence.
- The prerequisite PR receives adversarial `/di-change` review and merges before state-dimensions resumes.

## Explicit Non-Goals

- Fixing the circuit-config fixture.
- Changing passenger visibility or the Phase-2 visibility barrier.
- Changing burner simulation semantics.
- Counting `currently_burning` as an inventory item.
- Altering fluid accounting, belt recovery, gate tolerances, or controller 2PC wiring.
- Completing the remaining state-dimension tests in the prerequisite PR.