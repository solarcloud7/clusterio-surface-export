---
name: di-change
description: Gate a DATA-INTEGRITY change before merge — any edit to a transfer gate / validation / rollback / source-deletion / schedule-strip / test-hook path. Runs a checklist that codifies the discipline that has repeatedly caught silent data loss in this repo (the checks a human kept having to remember). Invoke before opening/merging a PR that touches those paths.
---

# di-change — data-integrity change gate

Use this the moment a change touches any of: the **transfer validation gate**, **rollback / source-delete**,
**two-phase-commit** flow, **schedule strip/filter**, **inventory/fluid/belt restoration**, or a **debug/test
hook that mutates game state**. These are the paths where a bug is *silent data loss*, not a crash — the
expensive class. This checklist is the discipline that caught the near-misses (see the linked memories); it
exists because knowing the principle wasn't enough — make it mechanical.

Work the checklist top to bottom. Each item is a gate: if you can't answer it cleanly, fix that before merge.

## 1. Is the check measured INDEPENDENTLY of the code under test?
A gate/fidelity assertion that reads the validator's own report (`totalItemLoss`, `expectedItemCounts`,
`actualItemCounts`) proves nothing — it passes even when the meter is broken. Ground it in an **independent
physical count** (`get_item_count(...)` over source AND dest). `npm run lint:test-grounding` enforces this for
`*fidelity*` tests and self-report reads. Rule of thumb: *if the thing under test could be wrong and the test
would still pass, it's grounded in the wrong place.* (memory: `data-integrity-test-grounding`.)

## 2. Did you ship the ADVERSARIAL fixture WITH the fix?
Not a happy-path test — one that FAILS on the pre-fix code. Inject the real defect (a shortfall, an inactive
inserter, a failed entity, a non-normal quality, a Session-Closed rejection) and assert the protective route
runs. Verify TEETH: confirm the test goes RED when the fix is reverted (or the guard's `FAIL_SAFE`/allow entry
is removed). A green safety test must prove the guard — not luck — prevented the bad outcome.

## 3. If the change adds a debug/test hook that MUTATES state — is it fail-safe on LEAK?
`debug_mode` defaults true on the always-up shared cluster, and flags persist in `storage`. A leaked flag fires
on the NEXT transfer. So the hook must be **pre-gate/self-protecting** (a leak makes the next transfer FAIL its
gate + PRESERVE its source) OR the arming test must disarm in a **guaranteed `finally`/`trap`** (never only the
success path). Prefer a **non-destructive** hook (inflate the *expected* value) over destroying real state.
`npm run lint:test-hooks` enforces the arm→guaranteed-disarm rule; a new pre-gate hook goes in its
`FAIL_SAFE_HOOKS` list (a reviewable act). (memory: `test-hook-mutating-must-be-fail-safe`; CLAUDE.md Pitfall #30.)

## 4. If the change adds a "catch"/validation next to an authoritative gate — is it COMMENSURATE and NON-REDUNDANT?
Two sides you compare must be commensurate (a source entity-total vs a dest entity-total is NOT — failed-to-
place / serialization-filtered / belt-surplus make them legitimately differ, so it false-REDs a lossless
transfer). And is it redundant — does the item/fluid gate already detect this loss? A false-alarming check
erodes trust in the real gate; downgrade it to a neutral INFORMATIONAL display instead of a verdict.
(memory: `check-commensurate-not-redundant`.)

## 5. Does the change preserve the two-phase-commit invariant?
Source is deleted **only after** the destination validates SUCCESS; on failure the source is unlocked and the
dest copy is discarded. Watch the timing traps: the gate must count a **COMPLETE** state (Pitfall #28 — held
items restore post-activation), never a mid-process snapshot; an ambiguous `SessionLost` on the import send is
**possibly-delivered** — do NOT unlock (that duplicates). When in doubt, a recoverable stuck-lock beats an
unrecoverable duplication. (memories: `validation-timing-trilemma`, `held-item-loss-is-dest-force-research`.)

## 6. Run `/code-review` before merging.
Non-negotiable for these paths. It has caught what manual review + the author missed (the `sendTo` unbound
method, `test_force_entity_loss`, the mislabeled tightening). Present the findings; fix or consciously
accept-and-document each. Use Opus for the adjudication tier — do not route merge-gating review to a smaller
model.

## 7. Owner hygiene
- Ship as a focused PR; **omit** the `Claude-Session:` trailer and the session URL (owner rule).
- Prefer `@clusterio/lib` (TS) / `require("modules/clusterio/api")` (Lua) over reinventing.
- Look up platforms/instances by unique per-force **index**, never collidable names.

## Fast verification (the mechanical guards this gate leans on)
```powershell
# all six guards (eslint needs devDeps → isolated container; pure-node guards run in the host container):
docker exec surface-export-host-1 sh -c 'cd /clusterio/external_plugins/surface_export && \
  npm run lint:lua && npm run lint:test-grounding && npm run lint:pcall-logging && npm run lint:test-hooks'
# adversarial + fidelity integration coverage (cluster up):
node tools/run-integration-tests.mjs --only 'gate-detects-loss|force-bonus-sync|transfer-fidelity|rollback'
```

## Reference
Related discipline memories (all in the project memory): `data-integrity-test-grounding`,
`test-hook-mutating-must-be-fail-safe`, `check-commensurate-not-redundant`, `validation-timing-trilemma`,
`held-items-non-conserved-test-the-total`. CLAUDE.md Pitfalls #15, #16, #28, #29, #30. The `/repro-transfer`
skill reproduces a transfer end-to-end locally to exercise a change.
