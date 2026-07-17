# Lab Gallery Notebook

## GALLERY-R1 [empirical, 2.0.77] — Paired golden saves and first migrated lab

Prediction: the PR #111 gallery seed can be reduced to a paired source/destination lifecycle while preserving its
125-stack belt pilot and baking the specialized-fluid reachability control into the same source game file.

Observed on Factorio 2.0.77 with the manifest's exact mod set:

- The original seed contained 2,832 entities across 4,568 generated chunks.
- The source golden save contains 34 entities across 248 chunks: the compact index, 32 belts on two Nauvis
  chunks, and a two-entity platform containing the hub and one electric mining drill.
- The destination golden save contains zero entities across 92 chunks and no space platform.
- Independent reload metering observed 125 physical one-item iron-plate stacks split 67/58, plus platform
  `pressure=0`, `gravity=0`, `mining_target=nil`, live fluidbox count zero, and rejected fluidbox read/write.
- An injected post-load runner failure exited nonzero, removed its prefix-owned runtime, and the immediately
  following clean reload reproduced the full reachability classification with no contract failures.
- No managed transfer instance was mutated. The verified source copy was loaded only into the dedicated
  `surface-export-lab-gallery` instance; the prior gallery save remains available for rollback.

Artifacts and exact censuses are pinned in `manifest.json`. The build and reload instruments are not behavioral
oracles; acceptance comes from the independent physical reload meter and the specialized lab's evidence validator.

## 2026-07-17 - Corpus re-baked through the repaired pipeline; verify gate green on committed artifacts

The PR #113 review found the committed paired saves failed their own `verify-save.mjs` gate: the lab-safe
surface-settings enforcement was authored after the saves were baked and its write path had never executed.
Executing it surfaced two engine facts at 2.0.77, both now fixed and pinned in code:

1. `game.delete_surface` only SCHEDULES deletion, so re-baking from a previous gallery save collided with
   `create_surface` on the canonical index name in the same execution. Fix: rename-then-delete
   (`replace_index_surface`). Re-bakes from the corpus's own output are now repeatable.
2. `LuaSurface.has_global_electric_network` is READ-ONLY (official 2.0.77 runtime-api.json, write=false);
   the real write path is `LuaSurface.create_global_electric_network()`. The attribute is its read-back.

Two measurement-integrity rules were also enforced: `inspect()` now reads surface settings without writing
them (the old inspect wrote the values it then reported, so the builder gate could never fail), and platform
surfaces are RECORDED but never mutated — `ignore_surface_conditions` on the reachability platform would
change `can_place_entity` semantics for exactly the surface-condition entities the lab classifies. Measured:
the platform reports `has_global_electric_network=true` naturally (engine-managed).

Re-bake PASS from the prior committed source as seed. New pinned artifacts (also in `manifest.json`):
source `DFE388875B9CD9AAAB3A9DF74D5132121919915DBE432D1ED40225CF9BC7D027`, destination
`D83697A32991154135EDC26708A4799F9339E71E67D0550BA4A4B1082A5C1F25`. Census totals unchanged (source 34
entities / 248 chunks, destination 0 / 92); the platform surface is now `platform-1` (destroy/recreate index
ordering) — a lookup label, updated in the pins. `verify-save.mjs` passes BOTH roles against the committed
zips, and the baked reachability recertification passes end-to-end with measured placement values and a
fingerprint match against manifest fixture `specialized-fluid-reachability` rev 1 (see the
specialized-inventory-lab notebook for the runner-emitted evidence).
