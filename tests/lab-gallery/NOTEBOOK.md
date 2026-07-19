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

## 2026-07-19 — Belt fixtures return as pads (manifest v3); golden re-baked, 2x verify green

The two belt fixtures were moved off their old homes (a dedicated `lab-belt-corner-v1` platform and two
nauvis 5x5 loops) onto stamped test-foundation pads on the omnibus grid at the two free slots — corner at
`(64,22)`, loop at `(92,22)` — filling the grid to 16/16. `manifest.json` advanced to schema
`surface-export-lab-gallery-v3`: every fixture now declares `padKind` (16 `pad` / 11 `platform`) and pads
carry their grid `origin`; `seed-prep.mjs` reads pad origins from the manifest (the hardcoded literals were
retired).

**Build recipe (physics is emergent — let the sim do it).** The build ops only PLACE belts; a JS-side feed
loop in `seed-prep.mjs` runs the running seed-prep server (sleeps between rounds) until the state settles —
the same pattern `build_census_fusion` uses, not a no-tick construction. The corner ports the
`belt-corner-recovery` recipe (6 turbo belts east into a north corner + a north dead-end; feed the entry
until the inside lane over-packs). The loop builds the 16-belt clockwise geometry from `fixture-layout.mjs`
and feeds toward 125 one-item stacks, then polls until the two-side split is stable across 3 reads.

**Key engine fact [empirical, 2.0.77, this bake]:** the omnibus platform is baked PAUSED, and a paused
platform HALTS belt travel — the first feed runs stalled at ~48 items with an empty corner (pausedBefore=true
in the build return). Belts must SIMULATE to compress at a corner / jam a loop, so the build ops clear
`platform.paused` (and `game.tick_paused`) for the feed and `set_omnibus_paused` restores the original pause
afterwards; jammed belts are stationary, so re-pausing freezes them exactly where they settled. (Belts also
reject `active=false` writes — Pitfall #16, atomic belt scan / BELT-R13 — so they are frozen by
`destructible=false` only.)

**Measured fingerprints (from the bake; never hand-authored):**
- `belt-corner-recovery` (corner pad): `beltCount 8, totalIron 65, cornerShape "left", cornerX 72.5,
  cornerY 28.5, insideItems 2, insideLength 0.4140625` (4 over-packed lanes). Matches the historic corner
  exactly except the pad coordinates; the whole-surface `entities` field was dropped (meaningless on the
  shared grid) and the meter is re-anchored + area-scoped.
- `belt-5x5-125-unstacked` (loop pad): `beltCount 16, itemName iron-plate, quantity 123, physicalStacks 123,
  maximumStack 1, lineQuantities [67, 56]`. **67/58 supersession (honest):** the historic split was 67/58 at
  125 total; the rebuilt loop jams stably at 123 total split 67/56 (the owner precedent is "state is the
  trigger, not history" — whatever the deterministic feed measures gets pinned). Stability was confirmed by
  identical `[67,56]` readings across both verify-save reloads.

**Retirements + census re-pin.** `retire_belt_platform` deletes `lab-belt-corner-v1` (`platform.destroy(0)` —
Pitfall #19, platform.destroy no-op with no arg); `clear_nauvis_belt_clutter` removed all 32 nauvis belts
(after the loop pad measured green in the same run). Source census re-pinned from measured bake output:
nauvis `32 -> 0` entities, omnibus `platform-11` `128 -> 158` (+24 belts, +6 status-runner trio entities),
the `platform-6` (`lab-belt-corner-v1`) row removed, total entities `1550 -> 1539`, generated chunks
`6468 -> 6312`. Destination census unchanged (index + nauvis, 0 entities / 479 chunks).

**Bake evidence.** seed-prep PASS from the committed golden source as seed; `build-save.mjs` PASS
(beltFixtureExact + corpusExact + census all green); `verify-save.mjs` PASS on BOTH committed zips **twice
consecutively**, with identical belt readings each pass. `node --test tests/lab-gallery` green (45). New
pinned artifacts: source `C5F50C82008C07581239CAEC9995EB5209BC52390AC2759D6A9B1D207B048767` (1539 entities /
6312 chunks over 16 surfaces), destination `76C1A1B26B4EB1D2B6C6C6EEED0498A8AC949450BE2CD859D89C31EFB49E1FA1`
(0 entities / 479 chunks). The belt loop stays corpus-EXCLUDED (its `lineQuantities` array is asserted by the
belt special path via `deepEqual`, not the scalar corpus gate whose `approx_equal` does reference-equality on
arrays); the corner folded into `measure_corpus` on the omnibus.

## 2026-07-19 — Live gallery completed in place; source-of-truth snapshot banked (supersedes the baked golden)

Owner directive: the LIVE `surface-export-lab-gallery` save (the owner was playing on it) becomes the canonical
source of truth. Completed in place via RCON only — the instance was never stopped/restarted, no save was
loaded, the owner was never teleported, and the omnibus platform was never deleted. Driver:
`tests/lab-gallery/complete-live-gallery.mjs` (ports the seed-prep-ops construction recipes to run directly
against the live gallery, following the rig-wave RCON-construction pattern; phases survey / build-beacon /
build-belts / latch-repair / verify / census / checkpoint, all idempotent).

**3 missing pads built live (measured fingerprints, never hand-authored):**
- `repin-beacon-speed` (36,22): stamped test-foundation cell + `build_repin_beacon`. Measured EXACT vs
  manifest — machineSpeed 0.75, beaconModulesEmpty true, beaconActive true, machineActive false,
  allIndestructible true.
- `belt-corner-recovery` (64,22): 6 turbo belts east into a north corner + dead-end, fed to two dry rounds
  (fed 65, 12 rounds). Measured EXACT — beltCount 8, totalIron 65, cornerShape "left", cornerX 72.5,
  cornerY 28.5, insideItems 2, insideLength 0.4140625; 4 over-packed lanes.
- `belt-5x5-125-unstacked` (92,22): 16-belt 5x5 clockwise loop, fed toward 125, jam-stable across 3 polls.
  CLASS satisfied (beltName turbo-transport-belt, beltCount 16, itemName iron-plate, **maximumStack 1** —
  every stack unstacked). **Honest quantity difference:** the deterministic live feed jammed at **quantity 122,
  physicalStacks 122, lineQuantities [67,55]** vs the golden [67,56]/123 — one item short on side two. NOT
  forced (the loop jammed there on its own; owner precedent "state is the trigger, not history"). The pilot is
  corpus-EXCLUDED and CLASS-gated, so this is a pinned observation, not a gate failure. Manifest pins were left
  UNTOUCHED (harness re-pointing is a separate phase).

**KEY ENGINE FACT re-confirmed [empirical, 2.0.77, this build]:** a paused platform halts belt travel; the
build ops clear `platform.paused` for the feed and restore the captured state afterward (here the live omnibus
was already unpaused, so it was restored unpaused). Only `platform.paused` was touched — the global
`game.tick_paused` was never set, so the owner's running session was undisturbed. Belts reject `active=false`
writes (BELT-R13), so the pads are frozen by `destructible=false` only.

**4 live defects repaired to fingerprint spec** (b/c/d executed by the coordinating session directly; (a) by
this driver):
- (a) `omnibus-decider-latch`: the self-feeding decider (IF signal-S>0 THEN signal-S=1, output_red self-wired
  to input_red — structure fully intact) had `active=false`, so it emitted nothing and the held signal had
  dropped to 0. Repair: seed signal-S=1 once via a temp constant-combinator red-wired to the input, let ticks
  settle (platform unpaused), remove the seed. **Engine fact [empirical, 2.0.77]:** a *deactivated* decider
  RETAINS its last-computed output register on the network — after the seed grabbed, `outSignalS` holds 1 with
  the decider `active=false` (recomputation stops but the held output persists). Final: signalS=1 stable,
  active=false, destructible=false, no stray seed left. This is the ideal state — frozen-convention-compliant
  AND latched.
- (b) inserter-held-capacity bulk-inserter → `destructible=false`; (c) no-tick-sync-frozen-pair machine +
  inserter → `destructible=false`; (d) `omnibus-ghosts-and-proxies` duplicate item-request-proxy at
  (44.5,14.5) destroyed, exactly 1 proxy remaining (target assembling-machine-2, speed-module plan).

**Verify (read-only, inline meters ported byte-faithfully from `fixture-meters.lua`; the module `require`
path and the single-shot IIFE injection both proved unavailable on the live save — require returns false, the
IIFE exceeds the Windows command-line length limit):** all 15 exact-fingerprint omnibus pads PASS — including
the repaired latch (signalS 1), inserter-held (forceBulkBonus 11, held 8 legendary railgun-ammo, destructible
false), no-tick pair (allIndestructible true), and ghosts-and-proxies (proxies 1). belt-corner PASS.
belt-5x5 CLASS-pass with the pinned [67,55] observation above.

**Census + zero-leftover proof:** 20 platforms (omnibus now 158 entities = the golden corpus target); the 5
`lab-rig-*` reconstructions + legacy `lab-belt-corner-v1` are prior-session live content, left untouched.
`storage.async_jobs` / `locked_platforms` / `destination_holds` all 0; no scratch surfaces (the temp latch seed
was destroyed, strayConstantsInPad 0); omnibus pause restored (unpaused, as captured); owner `solarcloud7`
still connected.

**Checkpoint banked:** `game.server_save('gallery-source-of-truth-2026-07-19')` →
`docker/seed-data/lab-saves/gallery-source-of-truth-2026-07-19.zip`, 1,310,765 bytes, SHA256
`BD2E6320B378C58ED362F9F005F9482CF0ED28B457DB11F055BEA2A613EA68F0`. **This snapshot supersedes the baked
golden (`lab-gallery-source-surface-export-2.0.77.zip`) as the canonical source of truth.** No `/test-run` was
run before the checkpoint (owner rule — /test-run mutates). Manifest pins are unchanged; re-pointing the
harness at this snapshot (and reconciling the belt-loop [67,55] observation) is a separate phase.
