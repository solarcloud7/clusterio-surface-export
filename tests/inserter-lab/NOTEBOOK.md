# Inserter-lab NOTEBOOK — the BUSY/CI non-belt loss (held items / inventories)

Durable record for the busy-platform ~115-item loss that is NOT belt (belt comp=4 vs gate ~115). Parallel to
`tests/belt-lab/NOTEBOOK.md` (belt subsystem, DONE). See plan `we-have-a-few-bright-dawn.md`.

## The problem
Cross-instance transfer of "test" (same seed, same code) loses ~115 items on CI (copper-plate, iron-plate,
railgun-ammo — railgun-ammo EXACTLY 47 every run) but 0 locally. Belt is ruled out (comp=4). Two opposed
hypotheses: H-REAL (held-item restore fails on dest) vs H-PHANTOM (export over-counts `expected` on a moving
platform — held items/inventories scanned non-atomically, unlike belts' Pitfall #16 atomic scan).

## D3 (2026-06-27) — set_stack TRUNCATES + the bool LIES (confirmed); capacity-mismatch RULED OUT
`tests/inserter-lab/probe_setstack.lua` on 2.0.76:
- railgun-ammo stack_size=**10**, iron-plate stack_size=100, bulk_inserter_capacity_bonus=**11** (hand cap ~12).
- `held_stack.set_stack({name, count=47})` (with the inserter briefly active, mimicking restore_held_items_only):
    bulk + railgun-ammo  -> held=**10** (truncated to stack_size 10), ok=**true**
    bulk + iron-plate    -> held=**12** (truncated to hand capacity 12), ok=true
    fast + railgun-ammo  -> held=4,  ok=true
    bulk + railgun BLOCKED drop-target (full chest) -> held=10 (target irrelevant; set_stack is synchronous)
  => `set_stack` silently TRUNCATES to min(item stack_size, hand capacity) and ALWAYS returns ok=true (the bool
     lies — restore_inserter_held trusting it reports held.count "restored" when fewer landed).
- **Capacity mismatch RULED OUT:** host-1 and host-2 BOTH have bulk_cap=11, inserter_stack=3. So set_stack of a
  source-captured count (<= source hand cap == dest hand cap) FITS on the dest — no truncation-from-mismatch.
- **Therefore** the truncation bug only loses items if the EXPORT recorded a count LARGER than a hand can
  physically hold (a hand can't hold 47 railgun-ammo at cap ~10/12). That points at H-PHANTOM (export
  over-count) OR a multi-inserter sum — must ground with D1.

## Source categorization (host-1 'test', live)
railgun-ammo: **held=81** (across multiple bulk inserters, each <=10), inventories(turrets)=338, ground=0.
So inserters DO hold railgun-ammo. The 47 loss is a subset — D1 decides real (dest short) vs phantom (expected
inflated).

## NEXT: D1+D2 — ground clone_physical vs expected vs dest_physical (decisive). Then Fix A or B.

## ROOT CAUSE (2026-06-27) — held items UNDER-restored; held loss == gate loss EXACTLY
D1+D2 on CI: [CI-DIAG-EXPORT-SUMMARY] total_abs_diff=0 (export EXACT, H-PHANTOM refuted) and [CI-DIAG]
held_failed=0 (no tracked bucket). But [CI-DIAG-SRC-HELD] vs [CI-DIAG-DEST-HELD] nailed it:
    railgun-ammo: src-held 80 -> dest-held 33 = lost 47  == gate loss 47
    copper-plate: src-held 68 -> dest-held 24 = lost 44  == gate loss 44
    iron-plate:   src-held 52 -> dest-held 20 = lost 32  == gate loss 32
The gate loss EXACTLY equals the held-item shortfall for every item => the busy loss IS inserter held items
being UNDER-restored, silently (held_failed=0).

MECHANISM: deserializer (`deserializer.lua:617-628`) set_stacks the held item on a freshly-created DEACTIVATED
inserter. On a deactivated inserter the bulk-inserter capacity isn't active, so set_stack seats only ~base hand
amount (D3: a non-bulk/deactivated hand takes ~4; a briefly-ACTIVE bulk inserter takes the full stack 10). The
hand is left PARTIALLY filled (valid_for_read=TRUE). Then `restore_held_items_only` (the pre-gate recovery)
SKIPS it because its guard is `not entity.held_stack.valid_for_read` (EMPTY hands only) -> partial hands never
topped up -> dest short -> gate fails, no bucket.

LOCAL vs CI EXPLAINED: locally the deserializer set_stack leaves the hand EMPTY (set_stack "silently fails on a
SETTLED-deactivated inserter") -> recovery pass fires (empty) -> full restore -> 0 loss. On CI (fresher state)
it leaves the hand PARTIAL -> recovery skips -> loss. Same code, state-dependent.

FIX A (Phase E): make held-item restore top up ANY hand whose count < captured (empty OR partial), via a
brief active toggle + set_stack the FULL captured count (verify by physical read-back, the bool lies). Likely
in `restore_held_items_only` (change the guard from "empty" to "count < captured"; clear + set_stack full).
Lab-test the top-up on a partially-filled bulk inserter first.
