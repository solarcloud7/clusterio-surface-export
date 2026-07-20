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

## 2026-07-19 — belt-combined-omnibus: first owner-hand-built fixture claims open-slot (8,36); STEADY-STATE class established

The owner hand-built a combined belt lab on open slot (8,36) — 35 turbo belts (sideloads), 3
splitters, 3 underground pairs, 2 filtered output loaders (iron-plate / copper-plate) draining into
infinity chests pinned at 100 — and challenged the freeze-at-saturation convention. Measurement
sided with the owner: the live circuit held exactly 578 items at tick 21308633 AND at tick 21308972
(339 ticks later, fully active). A saturated closed belt circuit is a STEADY-STATE system — count
constant by physics, no freeze required. The freeze convention is scoped to CONSUMING fixtures
(crafters/burners); the fixture taxonomy is now frozen / steady-state / live-drift.

Claimed as manifest fixture `belt-combined-omnibus` (padKind pad, origin (8,36), fingerprint from
live measurement: 35/3/6/2/2 + steadyItems 578 + loader/chest filters). owningRunner: WAIVED —
hand-built per the construct-once doctrine; the state is the artifact.

**FIRST CATCH at claim time**: the serializer has NO `loader` handler (loader filters not carried —
the splitter-filter types gate excludes loaders) and NO `infinity-container` handler (infinity
filters not carried). A transfer would deliver hollow configs. Fix queued as a /di-change with this
pad as its kill-measurement. Grid state: 16 fixture pads + 11 open slots (12 stamped 2026-07-19,
one claimed same day).

## 2026-07-19 — Prune/combine session (owner-adjudicated, live)

Owner ruling on coverage, each verified by measurement before acting:
- `lab-rig-filtered-splitter-v1` RETIRED (platform deleted): its invariant (splitter filter +
  output priority) is physically present on `belt-combined-omnibus` — measured filter=copper-plate,
  outPrio=left at (19,39.5), plus two priority-splitters the rig lacked. Covered.
- `belt-corner-recovery` KEPT: over-packed corner state is physically impossible on a
  normally-saturated circuit — it is the historic loss-class trigger; not covered.
- `belt-5x5-125-unstacked` KEPT: the closed conservative loop is the honest loss meter —
  `belt-combined-omnibus` is infinity-fed and SELF-HEALS after a lossy paste (loaders refill),
  so it can mask loss the pure loop keeps visible. Different instruments, both stay.

Also pruned: `test-status.mjs` (superseded by [TESTRUN-JSON]); 11 stale saves from the gallery
saves dir (candidates v3-v9, grid-wip, two old checkpoints, the pre-rework golden-source copy);
`belt-corner-recovery.layoutBlueprint` (was the RETIRED platform's blueprint — stale display-only
data). Deferred INTO the harness rework (dies with the rewrite; don't fix the dying): golden-batch
b8/rider section trim, `buildBeltPilot` vestige.

## 2026-07-19 — Owner rebuttal MEASURED AND VINDICATED: corners over-pack under normal flow; belt-corner-recovery retired

Owner challenged "physics won't produce the over-pack on a saturated circuit" — measurement sided
with the owner: `belt-combined-omnibus`'s 14 corner belts carry **19 over-packed inside lanes**
(n*0.24 > line_length) under normal saturated flow, ~5x the dedicated fixture's 4. Corner geometry
compresses inside lanes during flow; the earlier "physically impossible" claim reasoned about
straight lanes and was WRONG.

Owner also removed the pad's infinity chests (ruling: self-healing masks loss — a lossy paste
would be refilled by the loaders before measurement). Post-removal: **conservative closed circuit,
380 items stationary** (two reads, ~1200 ticks apart), maxStack=1 everywhere, 18 over-packed lanes
retained (one relaxed as flow settled — over-pack pinned as PRESENCE, not exact count).

`belt-corner-recovery` RETIRED as covered (manifest entry removed, pad cleared back to
open-slot-64-22). `belt-combined-omnibus` re-pinned rev2 from measurement.

## 2026-07-19 — Belt family consolidated to ONE fixture (owner-ruled): four retirements

Owner rulings executed, each after coverage measurement:
- `belt-5x5-125-unstacked` RETIRED (manifest + pad cleared, slot 92,22 reopened): both distinctive
  properties (conservative loop, maxStack=1) are measured properties of `belt-combined-omnibus` rev2.
- `lab-belt-corner-v1` platform DELETED (9 entities): over-pack class doubly superseded.
- `lab-rig-belt-loss-replay-v1` (platform-17, 552 entities) DELETED: the class artifact remains
  `tests/integration/belt-loss-replay/fixture.json` — the baked platform copy brought no value.
- `lab-rig-probe-strip-v1` (platform-20, 7 entities) DELETED: 6 empty dead-end belts, trivially
  reconstructible, no distinctive state.
- nauvis cleared: 48 clutter belts (three stray loops incl. the old canonical 5x5 home) destroyed.

The belt family is now ONE hand-built fixture (`belt-combined-omnibus`) + one replay monster
(`lab-rig-dup233855-v1`) + the banked JSON payloads. Grid: 14 fixture pads + 13 open slots.

## 2026-07-19 — lab-rig-green-omnibus-v1 retired (owner-ruled); the migration-first lesson closes

Owner retired the last redundant belt rig: its three element classes (saturated sideloads,
unfiltered splitter, underground pair) are all present on `belt-combined-omnibus`. Checkpoint
gallery-source-of-truth-2026-07-19g. The belt family ends the night as: ONE hand-built pad +
the DUP-233855 replay monster + the banked JSON payloads.

Lesson, owner's words: this is why we did NOT repair every test that migrated — three of five
reconstructed rigs were purged within hours of arriving, retired by seconds-long coverage
measurements. Effort spent perfecting a fixture before the map adjudicates it is effort cremated.
Get the state on the map; let coverage measurements decide what lives.

## 2026-07-19 — census-fusion platform retired (owner); adversarial chest becomes the item-coverage vault

`lab-census-fusion-v1` deleted (owner ruling; manifest entry removed, fixtures 26→25). Successor:
the owner's hand-built fusion fluid loop at pad (36,36), to be claimed as the fusion fixture with
the shared-accessor fix. The adversarial-inventory steel-chest (12.5,-16.5) is now the ITEM
VAULT: blueprint(label+layout), blueprint-book(nested print), filtered decon planner,
partial-durability repair pack, partial magazine, spoilage x10 — item-data classes never before
in a fixture; mid-spoil items spawn on demand only. Checkpoint 19i.

## 2026-07-19 — Platform purge (owner-ruled): consumables x3 + dup monster deleted

Owner: "purge every platform we don't need." Deleted: lab-consumable-1/2/3 (batch supplies, not
tests — their world is the golden-save batch lifecycle) and lab-rig-dup233855-v1 (class artifact
= the banked replay JSON in tests/belt-lab/evidence/, replayable on demand — the owner's
belt-loss-replay precedent). Manifest 25→22. KEPT with live jobs: omnibus (THE save), workhorse
(sole 1359-entity scale coverage), energy (electric isolation requires own platform), reachability
(surface-conditions fixture), hold pairs x6 (platform-level hold machinery, card-3 evidence).
Live map now 10 platforms. Checkpoint 19j.

## 2026-07-19 — Second hand-built claim (mining-drill-acid-feed) + three more owner retirements

Owner built an acid-fed uranium miner on slot (64,22) — big drill + sulfuric tank + 4 real uranium
resource patches + ground ore. Claimed as `mining-drill-acid-feed` (frozen-class; fingerprint from
live measurement: tankAcid 13050, drillAcid 104, resources 4/30398, ground 1). FIRST CATCH at
claim: resource-type entities ride NO serializer handler (entity.amount not carried) — third open
handler gap (with loader + infinity-container). Superseded and deleted: `lab-specialized-fluid-r1`
(owner: "platform-15 gets its own tile").

Also retired (owner rulings): `lab-hold-pod-live/held-v1` (pod-hold contract folds into the
destination-hold integration suite — "we already know this works") and `lab-energy-v1` ("covered
on the other server"). Manifest 22→20. Live map: 6 platforms (omnibus, workhorse, 4 hold
spoil/damage platforms). Checkpoints 19k, 19l.

## 2026-07-19 — Standing lab suite removed (owner ruling): calculated re-certification at version-update

Owner: engine re-certification runs as a CALCULATED CAMPAIGN when preparing a version update, not
as a standing suite. All 13 tests/*-lab directories removed (archive: git tag
labs-archive-2026-07-19; the DUP-233855 replay payload relocated to
tests/integration/belt-loss-replay/ for Phase 5B). labs-certified.json stays as the 2.0.77
certificate + campaign procedure; the version-certification guard still goes RED on a pin bump.
manifest.labs is now the fixture-referenced category catalog (11). Bake-verify special paths
existence-guarded pending harness-rework retirement. Unit suites 45/45 green.
