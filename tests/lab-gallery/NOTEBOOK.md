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

## 2026-07-17 — Certified the sixteen-family corpus; bake pipeline turned verify-not-construct

The corpus grew from two fixtures to twenty machine-readable fixture entries across eight hand-built
platforms plus the nauvis belt pilot, banked as `lab-gallery-source-candidate-v9`
(sha256 `466ef553…7ce8030b7ce9b24`). Fingerprints below were measured live on
`surface-export-lab-gallery` on 2026-07-17 (read-only RCON) and matched exactly by the bake and reload gates.

Corpus (platform → families):

- `lab-omnibus-state-v1` (81 entities, 11 zones + platform schedule): adversarial nested inventory
  (power-armor-mk2 in a steel-chest: legendary battery-mk2 `energy=5000000`, uncommon shield `97/195`;
  a-m-2 recipe `iron-gear-wheel` at uncommon quality — the quality is the SECOND return of
  `LuaEntity.get_recipe()`, not a `LuaRecipe.quality` field) · heat-pipe `temperature=500` · self-fed
  decider latch reading `signal-S=1` on its `combinator_output_red` circuit network · mid-craft a-m-1
  `active=false crafting_progress≈0.7000000000000005 inputPlates=2` · burner-inserter `active=false coal=10
  currently_burning=solid-fuel remaining_burning_fuel=2000000` · spidertron grid battery `50000000/100000000`
  · constant-combinator section `signal-A=42` + color lamp · a-m-2 `active=false bonus_progress=0.5` + 2
  productivity-modules · storage-tank `20000 steam@500C` + chemical-plant `60 water/60 petroleum-gas` +
  foundry `250 molten-iron@1500C` · 1 entity-ghost (a-m-2) / 1 tile-ghost / 1 item-request-proxy · 50
  loose iron-plate item-entities · platform schedule 2 records + interrupt `lab-interrupt`.
- `lab-energy-v1` (2 entities): accumulator `energy=3000000`, the SOLE electric entity.
- `lab-belt-corner-v1` (9 entities): 8 turbo-belts, 65 iron-plate; corner at `(16.5,0.5)` `belt_shape=left`
  with 2 over-packed items on the `0.4140625`-long inside lane.
- `lab-transfer-fixture-v1` (1359 entities): the live drift workhorse — machines LIVE by design, so item
  counts drift (measured `1688→1680` over hours); ONLY entity count is fingerprinted, never item counts.
- `lab-consumable-1/2/3` (1 entity each): bare single-use hubs for the batch lifecycle.
- `lab-specialized-fluid-r1` (2 entities): reachability control advanced to revision 2 — the drill was
  recreated after an asteroid loss and all entities are now `destructible=false`.

**Two save-age stability laws (both engine facts, documented so the corpus survives on the always-up
cluster):**

1. **Electric drain.** `active=false` does NOT stop accumulator discharge; a deactivated ~5kW machine
   measurably bled a deactivated accumulator. The energy fixture is therefore kept generation-free with the
   accumulator as its only electric entity, and the drain fixture asserts `electricEntities=1`.
2. **Asteroid fire on paused platforms.** A paused platform still takes asteroid damage — an asteroid
   destroyed the original reachability drill. Every fixture entity across all eight platforms is now
   `destructible=false` (1403 of 1488 entities; the 85 destructible are the nauvis belt loop and hubs).
   Platform pause freezes travel/asteroids but NOT entity simulation, which is why the live workhorse drifts
   while the omnibus stays exact via per-entity `active=false`.

**Pipeline rewrite.** `gallery-runtime.lua` no longer constructs fixtures. `normalize_source` verifies the
hand-curated corpus (physically measuring every fingerprint against the manifest, fail-loud on any
mismatch), rebuilds only the index catalog, and applies lab-safe settings to non-platform surfaces only.
`inspect` stays read-only and reports the full corpus census; `prepare_destination` ticked-destroys ALL
platforms and clears the belt pilot. `reload-meter.cjs` independently measures the full corpus as the reload
oracle; `verify-save.mjs` asserts it against the manifest fingerprints (every field exact — integers,
temperatures, energies, fluid amounts, coordinates, strings, booleans — with a 1e-9 tolerance scoped to ONLY
the crafting-progress and module-bonus-progress doubles for a save/load ULP). Fingerprint values
are single-sourced from `manifest.json`; the runtime and reload meter hold only physical locators.

**Bake + verify.** Bake PASS from `candidate-v9` (corpus gate: 55 fields across 18 measured fixtures on 7
platforms exact — the eighth platform, `lab-specialized-fluid-r1`, is asserted separately by the reachability
block, not the corpus meter; destination settled to index + nauvis only). The source save carries 10 surfaces:
the 8 hand-built platforms plus nauvis and the index catalog. New pinned artifacts:
source `7AA51AD67460B6AAE557F8ABC12C8C9167BE185FD77F6CCDB2A17A7831F627A5` (1488 entities / 5355 chunks over
10 surfaces), destination `09B1FCCEAD5EF38395825775DA3942CDD9382F6D2B4FD217A2A701AF15293BE5` (0 entities /
479 chunks). `verify-save.mjs` PASS on BOTH committed zips; `node --test` green in `tests/lab-gallery` (39)
and `tests/specialized-inventory-lab` (10). Layout blueprints for the omnibus, energy, and belt-corner
platforms are captured in `manifest.json` (`layoutBlueprint`); a blueprint records layout only, never
crafting progress, fluid amounts, or burner fuel, so it is not a fingerprint substitute.
