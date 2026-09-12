---
name: di-change
description: Verify FactorioSurfaceExport changes to cargo restoration, transfer ownership, identity, validation, recovery, source deletion, or state-mutating test hooks. Require independent evidence and an adversarial review before calling these changes ready to merge.
---

# Data integrity changes

Use this checklist when changing a path that can lose cargo, create an extra usable
platform, or release ownership prematurely. Ordinary UI, prose, and unrelated tooling
changes do not require the full runtime ladder.

## Establish the invariant

Before changing code, name the invariant and the exact failure being reproduced.
Inspect the emitter for the complete result/state family, including missing, late,
duplicate, rejected, and ambiguous responses. Use the actual pinned Clusterio types
and Factorio API shapes in fixtures; a convenient mock is not runtime evidence.

- Canonical `sourceInstanceId:sourceJobId` replays must not overwrite an active transfer
  or send another `ImportPlatformRequest`.
- Source deletion requires the matching destination validation and existing commit
  protections. Destination release requires the existing source-deletion acknowledgement.
- A lost reply or missing/pruned status is uncertain delivery, not permission to replay,
  unlock, delete, or create another platform.
- On definite failure, audit the existing rollback and destination-discard path. If
  delivery or destination cleanup remains uncertain, retain unresolved ownership.
- Preserve existing save-policy decisions, pending journals, platform identities, and
  protections during restart and reconciliation.
- Address platforms by per-force index and the applicable persistent identity or transfer
  ID. Display names are not ownership or deletion authority.

## Prove the change

1. Preserve a reproduction on the original code, then run the same assertion after the fix.
   For protective branches, remove each relevant guard independently and confirm its
   regression fails. Do not mutate live mounted code to run a mutation test.
2. Use independent physical observations for cargo and restored state. Count source and
   destination items, qualities, belt sides, and fluids; inspect fixture entity state.
   The validator's own totals are not an independent oracle. Before designing a change
   around an engine behavior, verify that assumption with the pinned API or a bounded
   runtime probe. An API shape alone cannot prove reconstruction behavior. Compare commensurate values;
   a redundant count with different semantics must not become a second validation gate.
3. Verify phase boundaries against what can still move or change between ticks. A partially
   restored world cannot certify final cargo. Inactive belts are not assumed frozen.
4. Trace first execution, repetition, late delivery, error/rejection, restart, and operator
   intervention. Reuse the existing authoritative path instead of copying its side effects
   into a new recovery path; compare all effects if two paths must remain.
5. State which checks are unit simulations and which ran on pinned Factorio. Use the
   established disposable Docker harness for runtime claims. Preserve the development
   cluster, existing saves, and original failure artifacts. A harness/API/cleanup failure
   is not proof of an engine or product defect. Record untested limits explicitly.

State-mutating fault hooks must either fail safely before ownership changes or disarm in
guaranteed cleanup. The local cluster may have debug mode enabled; leaked flags must not
silently damage the next transfer. Run the applicable executable lint guards and tests.

## Independent review

Review during authoring, before declaring these paths ready to merge. Prepare a bounded
packet containing base/head revisions, scoped diff, invariants, tests, and proof limits.

For a data-integrity change, use an independent reviewing agent when the current environment
provides one. Give it read-only ownership of the scoped review, the canonical checkout, and
the instruction not to revert others' work. Do not create a checkout, worktree, or clone.
Use the current capable model unless the user requests another model; this checklist does
not require Claude Code, Opus, or any particular provider.

An external reviewer is also valid when authorized. Skill invocation does not authorize
new source-code disclosure or publishing comments. If no independent reviewer can run,
retain a review packet and say the review is pending. A self-review or green CI does not
substitute for independent review. Verify each finding, fix confirmed defects, and rerun
affected checks. Keep uncertain findings and accepted limitations distinct from proven fixes.

## Delivery

Report the exact tested revision, reproduction and regression results, runtime evidence,
review disposition, and remaining limits. Use the existing isolated build/deployment tools;
do not build into the live plugin or restart development services merely to run checks.
Stay in the canonical checkout. Keep unrelated changes out of the commit. Do not merge,
deploy, or publish review comments without the user's applicable authorization. Omit
attribution and session links from commits and PR bodies.
When a merge is authorized, verify main's own post-merge checks before calling that
delivery complete; PR checks do not establish the merged revision's result.

The canonical checklist is `.agents/skills/di-change/SKILL.md`; the Claude entrypoint
links here so both tools use the same requirements.
