# Lint guards — rationale and incident history

The eleven correctness guards are MECHANISM, not style:
each was built after a paid-for incident, and each holds an invariant that in-code prose used to
merely describe. When the code-comment purge landed (PR #190, 2026-08-09, owner policy: code
carries no prose), the guard scripts' rationale headers moved HERE — the scripts keep only their
enforcement logic, and this file keeps the WHY. The machine-read escape-hatch markers
(`*:allow`, `intentional probe`, `deliberately quiet`) are not prose — they are inputs the
guards enforce, enumerated in `scripts/lint-allow-manifest.json` with reason and approver, and an
allow is an ESCALATION, never self-approved.

Run everything: `npm run lint` (gated in CI's Fast checks). Guard self-tests live in
`test/lint-*.test.cjs` and mutation-pin the guards' teeth.

Each section below is the relocated header of the script it names, verbatim apart from comment
syntax. `fail-safe-hooks` and `prepare-build` are not lint guards but lost their headers to the
same purge; their rationale lives here under the same rule.

## lint-lua-invariants

- **Run:** `npm run lint:lua`
- **Escape hatch:** -- lint-lua:allow

lint-lua-invariants.mjs — static guard for the Lua module's documented-but-otherwise-unenforced
invariants. ESLint covers the TypeScript side (incl. the unbound Link-method guard);
the Lua module has no linter, so the footguns we have already been bitten by used to ship through
review with nothing to catch a regression. This script is that catch.

Each rule below maps to a CLAUDE.md Pitfall and was VERIFIED clean (or fixed clean) when added —
so the guard is green today and only goes red if someone reintroduces the anti-pattern.

`no-type-substring-dispatch` (Pitfall #32) bans string-searching an entity-type value — `type:find(…)`,
`entity.type:match(…)`, `string.find(entity_type, …)`. One entity type name contains another, so a
substring route swallows the longer name and strands its handler.

[empirical, 2.1.11, measured 2026-08-15 on the local cluster] `get_entity_category` routed
`artillery-turret` to the `turret` category because the type name contains `turret`, so
`EntityHandlers["artillery-turret"]` never ran and `artillery_auto_targeting` never entered the
payload. A transfer of a platform carrying an armed artillery turret (source `false`, prototype
default `true`) restored `true` at the destination, with the gate reporting SUCCESS and PropertyCensus
reporting `artillery_auto_targeting:not_in_payload=1`. Dispatch is now the explicit
`GameUtils.TYPE_TO_CATEGORY` table, derived by replaying the old chain over the 132 entity types the
engine reports at the pin.

Sweep at introduction: 42 `find`/`match` calls under `module/`. Type-valued receivers were the 15
chain branches plus one `entity.type:find("locomotive")`, which became `== "locomotive"` (only
`locomotive` contains `locomotive` at the pin). The rule does not cover name-valued searches
(`entity.name`, `prototype.name`), which remain in `connection-scanner.lua` and `entity-scanner.lua`.

Scope: every .lua file under the plugin's module/ subtree.
Run:   node scripts/lint-lua-invariants.mjs        (also: npm run lint:lua)
       (agent shell has no node on PATH — run inside a host container, see CLAUDE.md)
Escape hatch: append a `-- lint-lua:allow` comment on a line to suppress it (use sparingly,
              with a reason).

## lint-lua-syntax

- **Run:** `npm run lint:lua-syntax`
- **Escape hatch:** none — fix the name or extend the whitelist in the script (reviewed change)

lint-lua-syntax.mjs — Lua PARSE + UNDEFINED-GLOBAL guard for the save-patched module.

Incident (2026-07-28): a module file referenced the module-table name `FixtureMeters` where the
local was actually named `M`. Nothing between "edit" and "deploy" parses Lua, so the defect
shipped through a full patch-and-reset and KILLED THE INSTANCE AT SAVE-LOAD (error() during
save-patching = headless server death, exit 255 — see the error-in-event-context memory). The
only detection was the server dying. A parse + undefined-global pass catches that whole class
in under a second, before any deploy.

Two rules:
  R1 (parse):            every .lua file must parse as Lua 5.2 (Factorio's dialect).
  R2 (undefined-global): every global READ or WRITE must name a known engine/stdlib global.
                         Locals, upvalues, and require()d module tables never appear as globals,
                         so a misspelled local/module-table name (`FixtureMeters` vs `M`)
                         surfaces here as an undefined global.

Scope: every .lua under the plugin's module/ subtree (control stage), plus the gateway mod
sources under docker/seed-data/mods-src when running from a full checkout (data stage — its
whitelist additionally carries `data` and `mods`).

Escape hatch: NONE by design. A legitimate new engine global belongs in the whitelist below —
a central, reviewable diff — not in a scattered per-line annotation. If the whitelist is wrong,
fix the whitelist.

Run:   node scripts/lint-lua-syntax.mjs        (also: npm run lint:lua-syntax)

## lint-webpack-cache

- **Run:** `npm run lint:web-cache`
- **Escape hatch:** lint-webpack-cache:allow

lint-webpack-cache.mjs — static guard that the plugin's webpack output stays content-hashed.

The controller serves /static/* with `Cache-Control: immutable, max-age=1y`, which is ONLY safe
for content-hashed filenames (a content change must yield a new URL). @clusterio/web_ui's shared
webpack.common already hashes by default (static/[name].[contenthash].js); a local
`output.filename`/`chunkFilename` — or a ModuleFederation `filename` — override WITHOUT a hash
token silently defeats that and pins stale chunks on returning users for up to a year. That exact
regression shipped once (commit 94e1b8c, "major refactor, WIP") and wasn't caught until it hit
prod. This guard is the catch (see the "Web cache" guard entry in CLAUDE.md).

Rule: every `filename:`/`chunkFilename:` string literal in webpack.config.js must contain a
      content-hash token ([contenthash] / [chunkhash] / [hash]). Omitting the keys entirely (to
      inherit the hashed default) is fine — only an explicit non-hashed override trips it.

Scope: the plugin's webpack.config.js.
Run:   node scripts/lint-webpack-cache.mjs            (also: npm run lint:web-cache)
       node scripts/lint-webpack-cache.mjs <file>     (lint an alternate config — used to self-test)
Escape hatch: append a `lint-webpack-cache:allow` comment on a line to suppress it (with a reason).

## lint-test-grounding

- **Run:** `npm run lint:test-grounding`
- **Escape hatch:** lint-test-grounding:allow

lint-test-grounding.mjs - mechanical guard for integration-test grounding.

The recurring failure mode: a fidelity test that asserts on a value derived from the code under test
proves nothing. The original transfer-fidelity incident would have gone green on a broken loss meter;
independent physical counts and adversarial review caught it. Rule 3 closes the adjacent disposition
blind spot measured in W3: a success-path runner saw a failed verdict, Black-Box Discard removed the
destination, and the runner then misreported the missing destination as physical item loss.

Rules per tests/integration/<name>/run-tests.{ps1,mjs}, with comments stripped (dialect-aware —
`#` for PowerShell, `//` for JavaScript, so a commented-out marker never satisfies a rule):
  1. A fidelity test performs an independent physical item count.        [both dialects]
  2. Validator fidelity self-reports are cross-grounded physically.      [both dialects]
  3. A success-path destination census follows the verdict adjudication. [dialect-specific markers:
     ps1 Read-DebugFile -> Assert-TransferSucceeded; mjs validation_success before any board/census]

Rules 1 and 2 covered ps1 only until 2026-08-05, because this guard predated mjs runners. No mjs
runner violates them today, so their mjs coverage is preventative — which is exactly why each has a
self-test proving it FIRES on a synthetic violator (test/lint-test-grounding.test.cjs). A
preventative rule nobody has watched fire is indistinguishable from one that does not work.

Escape hatch: lint-test-grounding:allow with an owner-approved manifest entry. An allow is an escalation,
never a self-service response to a firing guard.

## lint-pcall-logging

- **Run:** `npm run lint:pcall-logging`
- **Escape hatch:** -- pcall:allow / -- intentional probe

lint-pcall-logging.mjs — every `pcall` in module/ must SURFACE its error (log it), never swallow it.

Why (see the never-swallow-pcall-errors memory + CLAUDE.md): a pcall around a belt insert swallowed the
error "items: table expected, got number" — the smoking gun for a 2.0.76 API signature mismatch — which
hid the bug across two failed fix attempts. A pcall that catches an error but never logs it turns a loud,
diagnosable failure into a silent, mysterious one. The rule: keep the plugin from crashing, but make every
failure visible.

A `pcall(` is OK if ANY of:
  - it is a `pcall_warn(...)` call (the canonical logging wrapper, utils/game-utils.lua), OR
  - it is CAPTURED (`= pcall(...)` / `return pcall(...)`) AND a log()/print()/pcall_warn appears within the
    next LOG_WINDOW lines (the failure path is surfaced), OR
  - it is annotated within +/-2 lines with `intentional probe` / `failure expected` / `pcall:allow`
    (an intentional control-flow existence/readability probe that is expected to fail per-entity).
Otherwise it is FLAGGED. A FIRE-AND-FORGET `pcall(function() ... end)` (result dropped) can never surface
its error, so it is always flagged unless annotated.

Run:   node scripts/lint-pcall-logging.mjs        (also: npm run lint:pcall-logging)

## lint-catch-swallow

- **Run:** `npm run lint:catch-swallow`
- **Escape hatch:** // catch:allow

lint-catch-swallow.mjs — caught errors must reach an observable sink.

A non-empty catch is not automatically safe: `catch { value = [] }` silently converts a read failure
into valid-looking empty state. Every catch must propagate, log, or show its error, or carry an
owner-approved `catch:allow <reason>` on the catch line or the line immediately above it.

Two surfaces, one rule:
  - plugin TS/TSX (root entrypoints + lib/ + web/) — the original surface;
  - repo-root .mjs under tools/ and tests/ — the sole integration runner, the testkit, and the
    gallery lifecycle engine all live there, OUTSIDE the plugin's eslint scope. This was the last
    ungated silent-failure dialect (recorded as a known gap in PR #147; closed by SC-70).
The repo-root surface is absent in the sanctioned plugin-only container mount — same positive-path
bypass as lint-ps-silent; ANY other missing scan dir fails (half-scan-printing-OK was a
review-caught defect class).

## lint-ps-silent

- **Run:** `npm run lint:ps-silent`
- **Escape hatch:** annotation IS the mechanism (deliberately quiet + real reason, reviewable)

lint-ps-silent.mjs — PowerShell silent-failure guard for the repo's tooling.

The pcall-logging guard covers Lua and the catch-swallow guard covers TypeScript; PowerShell was
the ungated dialect, and it is the one that has bitten hardest: patch-and-reset once ended every
clusterioctl call in `2>$null` with no exit check, so 11 broken calls produced zero output and a
false success (the --config= incident, see that script's header). A fail-loud campaign converted
the tree; this guard keeps it converted.

Rule: a PowerShell-stream suppression —
    `2>$null`, `-ErrorAction SilentlyContinue`, `-ErrorAction Ignore`, or an EMPTY `catch {}`
— is a violation unless it is one of the two lawful shapes already used across the tree:
  CHECKED   the exit code is consulted within the next 3 lines ($LASTEXITCODE or $?), so a
            failure changes behavior instead of vanishing (probe pattern). Not available to
            empty catch{} — an empty catch checks nothing by definition.
  ANNOTATED a comment containing "deliberately quiet" or "intentional probe" (any case) on the
            same line or within the 3 lines above, stating the REAL reason the void is safe
            (bounded poll, idempotent cleanup, existence probe...). The reason is the point:
            it forces the author to argue the case where the reviewer can see it.

NOT flagged: `2>/dev/null` inside sh -c '...' strings — that is container-side shell suppression
(benign glob-miss handling), a different stream on a different machine.

Scope: tools/ ** /*.ps1 and tests/ ** /*.{ps1,psm1} at the repo root (absent in the sanctioned
plugin-only container mount — same positive-path bypass as lint-test-grounding).

Run:   node scripts/lint-ps-silent.mjs        (also: npm run lint:ps-silent)

## lint-test-hooks

- **Run:** `npm run lint:test-hooks`
- **Escape hatch:** FAIL_SAFE_HOOKS entry (scripts/fail-safe-hooks.mjs)

lint-test-hooks.mjs — guard: a debug-gated test hook that MUTATES game state must be fail-safe on LEAK.

See the `test-hook-mutating-must-be-fail-safe` memory + CLAUDE.md. `/code-review` (not the author) caught
`test_force_entity_loss`: a POST-gate, destructive, persisted hook whose arming integration test disarmed
only on its success path (5 early `exit 1` paths skipped the cleanup). On a leaked flag (`debug_mode`
defaults true on the always-up shared cluster, debug_mode lives in the save and defaults true on a FRESH save) the NEXT unrelated transfer silently destroyed
dest entities AFTER its gate passed → still SUCCESS → source deleted = real, unattributed data loss, firing
only on the flaky/error path (hardest to notice).

Rule: an integration test that ARMS a `test_force_*` hook (assigns it a non-disarm value) must GUARANTEE
disarm on every exit path — i.e. the file must contain a `finally` or `trap` block, where the disarm goes
(PowerShell runs `finally` even on `exit`). EXEMPT: hooks VERIFIED pre-gate / self-protecting — a leak makes
the next transfer FAIL its gate and PRESERVE its source — listed in FAIL_SAFE_HOOKS below. Adding a hook
there is a deliberate, reviewable act (it MUST be pre-gate; run /code-review on test-hook changes). A
post-gate or destructive hook must NEVER be added to that list.

Run:   node scripts/lint-test-hooks.mjs        (also: npm run lint:test-hooks)
Escape hatch: a `lint-test-hooks:allow` comment (with a reason) anywhere in the test file skips it.

## lint-derived-art

- **Run:** `npm run lint:derived-art`
- **Escape hatch:** —

Every bundled image in web/assets must still match what its source art derives to.

WHY THIS EXISTS: `web/assets/gateway-hub-128.png` is a SECOND COPY of art whose source of truth is
the surfexp_gateways mod. The web bundle needs it because Factorio's spritesheet only carries a
32x32 atlas cell per space-location, which is a 4.7x upscale at node size — but a second copy that
nothing checks goes stale silently, and the failure mode is the canvas showing last month's art
with no error anywhere.

The README next to the asset said "re-run the command whenever the art changes", which is a
request to remember rather than a check. This is the check.

It re-derives from source IN MEMORY and demands byte equality, which is legitimate here precisely
because the committed file was produced by this same code path — unlike downscale-icon's
`--verify`, which compares against art made by an unknown external tool and therefore allows a
measured tolerance.

## lint-allow-manifest

- **Run:** `npm run lint:allow-manifest`
- **Escape hatch:** —

lint-allow-manifest.mjs — the allow-annotations ledger guard.

Every `*:allow` escape hatch on a data-integrity lint (lint-lua, pcall-logging, webpack-cache,
test-grounding) suppresses a rule that exists because of a real incident. An allow is
therefore an ESCALATION, not self-service (memory: lint-allows-are-escalations — an agent once
self-approved an allow on the source-delete spine and it survived to review by luck). This guard
makes every allow a REVIEWABLE ACT: the annotation must be enumerated in
scripts/lint-allow-manifest.json with a reason and an approver, and the manifest must match
reality EXACTLY — a new allow without a manifest entry fails; a stale entry whose annotation was
removed fails; a count drift fails. The manifest diff is what the reviewer sees.

Scope per marker mirrors the owning lint's own scan scope (code annotations only — prose in
.md files that merely MENTIONS a marker, e.g. CLAUDE.md documenting the escape hatch, is not an
annotation).

Run:   node scripts/lint-allow-manifest.mjs        (also: npm run lint:allow-manifest)
There is deliberately NO escape hatch on this guard.

## lint-commit-labels (RETIRED 2026-08-09)

Retired by owner ruling: it enforced that a `docs:`-labeled commit touches only doc paths — an
audit boundary that stopped earning its CI step once rationale moved out of code into
maintained .md files. The script and its PR-gated CI step are deleted; git history keeps both.

## fail-safe-hooks

- **Run:** `(data module consumed by lint:test-hooks)`

fail-safe-hooks.mjs — the ONE declaration of pre-gate / self-protecting test hooks.

Shared by scripts/lint-test-hooks.mjs (the arm→guaranteed-disarm guard) and
tests/lab-gallery/manifest.mjs (the lifecycle arm_hook allowlist). Each entry MUST be
pre-gate: on a leaked flag the next transfer FAILS its gate and PRESERVES its source. Adding
an entry is a reviewable act — a post-gate/destructive hook here defeats both consumers.

## prepare-build

- **Run:** `node scripts/prepare-build.mjs (runs as npm prepare + postbuild stamps)`

prepare-build.mjs — the `prepare` lifecycle, guarded so an npm install cannot silently REPLACE a
build you already tested.

THE MEASURED PROBLEM. `prepare` used to be a bare `npm run build`, and npm runs it on every
install. The container entrypoint installs the bind-mounted plugin at container CREATION, so the
sequence was:

  1. deploy-cluster.ps1 builds dist/ on the host, in an isolated node:24 container, from
     `npm ci` — i.e. the LOCKFILE's dependency tree.
  2. `docker compose up -d` creates the container; its entrypoint runs `npm install`, `prepare`
     fires, and dist/ is rebuilt over the tested artifact.
  3. The entrypoint then prunes devDeps, so webpack is gone and nothing rebuilds on later restarts.

Step 2 does NOT honour the lockfile. Measured 2026-08-01 from this cluster's own boot log: on
2026-07-26 the container built with `webpack 5.108.4 compiled successfully` while
package-lock.json at that commit (7121da8) pinned webpack 5.105.2. The `^5.98.0` range in
package.json was re-resolved to whatever was newest. So the bytes that RUN were produced by a
different toolchain than the bytes that were built and tested, with nothing reporting the
difference: module-version-stamp.test.cjs and the version-stamped boot check both cover the Lua
module only, and lint-webpack-cache.mjs inspects the webpack CONFIG, never its output.

THE GUARD. Build only when there is something to build:
  - an expected output is missing        -> build (the fresh-clone bootstrap: `docker compose up`
                                           on a clean checkout has no dist/ and must still work)
  - any source is NEWER than the outputs -> build (a stale dist/ is worse than a re-built one)
  - otherwise                            -> SKIP, and say so

Freshness is compared, not merely presence: a bare "skip if dist/ exists" would trade
"always fresh, possibly different bytes" for "exactly the tested bytes, possibly STALE", and
nothing in this repo detects a stale dist/. This keeps the tested artifact AND refuses to serve an
outdated one.

NOTE FOR build-plugin.ps1: it must run its build command EXPLICITLY. It used to rely on this
lifecycle firing during `npm ci`, which this guard can now legitimately skip.


## lint:api-names (`scripts/lint-api-names.mjs`)

Every Factorio API member name read, written, probed, or named as a string literal must exist at the
pin, checked against the vendored `scripts/factorio-api-index.json` (regenerated from Wube's
`runtime-api.json` by `scripts/extract-factorio-api-index.mjs` at repin time; the index flattens the
inheritance chain — the first draft dropped parents and false-flagged `get_inventory`, which is
`LuaControl`'s).

Two different runtime behaviors motivate the guard, measured together with a control on the live
cluster [empirical, 2.1.11, RCON probe on a `transport-belt` receiver, 2026-08-15]:

| shape | result |
|---|---|
| `entity.name` (real member) | `transport-belt` |
| `entity.auto_launch` (absent member) | RAISES `LuaEntity doesn't contain key auto_launch.` |
| `entity.planting_position` (absent member) | RAISES `LuaEntity doesn't contain key planting_position.` |
| `entity.driver_is_gunner` (real member, wrong subclass) | `nil`, no raise |

So a **bare** read of a misspelled member throws, and the throw is fatal wherever nothing catches it;
the **same name behind `safe_get` or a pcall probe** is swallowed and reads as nil forever. The guard
covers both halves. `LuaEntity`'s own subclass rule — row four — is *not* covered and cannot be:
a real member on the wrong subclass returns nil, so it is invisible to a name check.

Four measured incidents, one per shape:

- `driver_is_main_gunner` — the founding incident. `safe_get(entity, …)` on a name that has never
  existed, silent for months on both car and spider-vehicle.
- `auto_launch` — a bare read of a member removed in 2.0; killed an instance on the first silo export.
- `planting_position` — a bare read of a member that never existed; the throw escapes uncaught through
  the export pipeline's re-raise to `on_tick`, killing the instance. Removed in #221.
- `auto_targeting_with/without_gunner` — misnamed fields on a plain CONCEPT table, producing an
  always-empty capture. **Out of scope** (see below).

Scope — three arms over `module/**/*.lua`, parsed with the vendored `scripts/vendor/luaparse.cjs`
rather than matched with regexes, so comments and string literals cannot fire:

1. **bare reads and writes** — `RECEIVER.member` anywhere, for the receivers below;
2. **`safe_get(RECEIVER, "NAME")`** — both the bare and the `GameUtils.`-qualified call shape, and
   only the two-argument form (`connection-scanner.lua` defines a *local one-argument* `safe_get`
   closure over a control behavior; reading its argument as a member name would invent 28 false
   positives);
3. **`pcall(function() return RECEIVER.NAME end)`** probes.

Receivers are mapped to classes **by name**, from `module/` convention — there is no type inference.
A receiver earns the bare-read arm only if a sweep of every binding of that name in `module/`
(parameters, locals, loop variables, assignments) finds it bound exclusively to that engine class:

| receiver | class | arms |
|---|---|---|
| `entity` | `LuaEntity` | all three |
| `platform` | `LuaSpacePlatform` | all three |
| `surface` | `LuaSurface` | all three |
| `player` | `LuaPlayer` | all three |
| `force` | `LuaForce` | all three |
| `stack` | `LuaItemStack` | `safe_get` + probe only |
| `inventory` | `LuaInventory` | `safe_get` + probe only |

`stack` and `inventory` are held back from the bare arm because the binding sweep disproves the
assumption: `core/json.lua` binds `stack` to a recursion-guard table and `utils/version-compat.lua`
to a plain `{name=, count=}` item table. That every `stack.` read happens to resolve today is luck —
`.name` and `.count` exist on both shapes. Inside a `safe_get` or a pcall probe the receiver is an
engine object by construction (there is nothing to catch when reading a plain table), so those two
arms are safe for them — and arm 3 is what caught `stack.spoil_result`, a live misname whose real
home is `LuaItemPrototype`.

Receivers deliberately left out: `item`, `entity_data`, `data`, `job`, `result`, `rec` and friends
are payload tables, not engine objects. `e` (121 reads) is a genuine coverage hole rather than an
oversight — `control.lua` uses it as a `defines.events` alias while other files use it for records
and for entities, so no single class maps to it.

**Concept fields are out of scope**, which is why the `auto_targeting_*` class is not covered here.
Two independent reasons: the extractor fills only `index.classes`, so the vendored oracle contains
**no concept definitions at all**; and even with them, knowing that a plain table came from a
concept-typed attribute needs the receiver type inference this guard deliberately does not do.
Linting that class at zero false positives is not currently possible, so it is named rather than
guessed at.

Controls — the guard fails loudly rather than passing vacuously if it is disarmed: a mapped class
missing from the index, fewer than 800 member reads found in `module/`, any configured receiver
contributing zero reads, or any `.lua` file failing to parse (an unparsed file is an unchecked file).

A miss names the file:line, the arm that saw it, whether the name exists on another class, and the
near-misses. The runtime half of the fix lives in `safe_get` itself: a THROW logs once per property
name. Self-tests live in `test/lint-api-names.test.cjs` and are picked up by the `npm test` glob.

No allow marker — a wrong name has no legitimate use; `testkit api <Class.member>` finds the real one.
If a receiver name is ever legitimately bound to a plain table, rename the variable (that is what
`validators/verification.lua` needed) or drop the receiver from the map; do not annotate around it.

## lint:tick-portability — durations cross instances, absolute ticks never do

An absolute engine tick is a reading of one instance's clock. A transferred payload is consumed by
an instance whose `game.tick` is unrelated, so a raw copy of `spoil_tick`, `tick_grown`, or
`character_corpse_tick_of_death` lands as a random point in the destination's past or future —
upstream documents the consequence for spoilage directly: "setting to anything < the current game
tick will spoil the item instantly." The portable representation is a duration: capture
`attr - game.tick` at read time, restore as `game.tick + duration`. The serializer already does the
equivalent for spoilage by carrying the engine's own relative twin, `spoil_percent`; attributes
without a relative twin get the subtraction by hand (owner ruling 2026-08-14: the invariant is
universal, so it is linted rather than remembered).

The watched-attribute list is not authored: it derives from the vendored
`scripts/factorio-api-index.json` — every attribute whose upstream first-sentence doc opens
"The tick" / "The last tick" (and whose name contains `tick`). The guard carries a control: if the
derived list stops containing `tick_grown` and `spoil_tick`, it fails rather than passing empty —
an index regenerated without doc fields would otherwise silently disarm the rule, the same
matched-nothing failure mode that bit the coverage tool's reference filter twice.

Mechanics: any `module/**/*.lua` line touching a watched attribute must also reference `game.tick`
(the subtraction on capture, the addition on restore — keep the arithmetic on the same line), or
carry `-- tick:allow` on that line or the line above, enumerated in the allow manifest like every
escape hatch. Self-tests live in `test/lint-tick-portability.test.cjs` and are picked up by the
`npm test` glob.
