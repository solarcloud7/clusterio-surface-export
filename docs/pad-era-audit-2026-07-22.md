# Pad-era documentation & regression audit — 2026-07-22

Audit of the ~160 commits since the pad system landed (`25640b6`, "add baked lab gallery save"),
against the goal that motivated it: **put every fixture on a visually inspectable pad that simulates
a transfer**, because the pad campaign kept refuting assumed engine behavior. Belts and fluids are
solved; this audit asks what the documentation still claims, and what stops it regressing.

Status: findings only. No re-tagging or guard changes have been made — sequencing matters (see
"Proposed guard").

---

## Finding 1 (STRUCTURAL) — nothing checks a claim's measured version against the engine pin

The evidence-tag system has two guards, and neither closes the loop:

| Guard | Checks | Does NOT check |
|---|---|---|
| `lint:evidence-claims` | an empirical claim in a **code comment** carries a citation within ±3 lines | whether the cited measurement's **version** is current |
| `lint:version-certification` | pinned Factorio version == `tests/labs-certified.json` | anything about **individual claims** |

So a claim can be well-formed, correctly cited, and **completely stale** — mechanically invisible.

The engine pin moved 2.0.77 → **2.1.11** (certificate `certified_at 2026-07-21`). Tag census across
`docs/*.md` (61 tagged claims total):

| Tag | Count | Meaning |
|---|---|---|
| `[empirical, 2.0.77]` | 29 | measured on the **old** engine |
| `[empirical, 2.0.76]` | 4 | measured on the **old** engine |
| `[empirical]` (no version) | 10 | **cannot be checked at all** |
| `[empirical, 2.1.11]` | 4 | current |
| `[hypothesis]` | 6 | honest, unproven |
| `[API]` | 5 | version-independent |
| other (`[unverified]`, historical, `<pin>` template) | 3 | — |

**43 of 61 claims (33 old-pinned + 10 unversioned) cannot be validated against the current pin.**
Concentration: 31 in `docs/factorio-2.0-api-notes.md`, 2 in `docs/pitfalls.md`.

This is the regression hole. Until a guard closes it, **the next engine bump repeats this exactly** —
re-tagging alone is a one-time cleanup, not a fix.

---

## Finding 2 (COVERAGE) — 19 of 27 pads never ride a real transfer

The pad goal was to *simulate transfers*. Actual split (`tests/lab-gallery/manifest.json`):

**TRANSFER-ACT (8)** — sent through the real transfer by `tests/integration/pad-transfer-suite`:
`transfer-workhorse`, `omnibus-spoilage-midspoil`, `gate-item-loss`, `gate-fluid-loss`,
`rollback-validation-failure`, `failed-entity-attribution`, `force-bonus-held`,
`census-omission-abort`.

**PASTE-AUDIT ONLY (19)** — fingerprint verified by copy/paste in `/test-run`, never transferred:
`omnibus-adversarial-inventory`, `omnibus-heat-temperature`, `omnibus-decider-latch`,
`omnibus-midcraft-progress`, `omnibus-burner-fuel`, `omnibus-equipment-grid`,
`omnibus-circuit-config`, `omnibus-module-bonus-progress`, `omnibus-crafting-fluids`,
`omnibus-ghosts-and-proxies`, `omnibus-ground-items`, `omnibus-platform-schedule`,
`inserter-held-capacity`, `no-tick-sync-frozen-pair`, `repin-beacon-speed`,
`belt-combined-omnibus`, `mining-drill-acid-feed`, `fusion-loop`, `thruster-pair`.

**Paste-audit is stronger than it sounds** — it is not a toy. The lab copy path runs the *real*
`EntityScanner.serialize_entity` per entity, audits with the *gate's own* meters
(`SurfaceCounter.count_entity_items` / `count_entity_fluids`), and runs `FluidRestoration` on
isolated pastes. It is a genuine serialize→restore roundtrip through production components.

**What paste-audit does NOT exercise** (only a transfer-act pad does):
- the chunked RCON transport + payload schema (`schema_version` gate)
- cross-**instance** delivery and controller routing
- the strict pre-activation gate verdict, two-phase commit, and **source deletion**
- Phase-0 destination force sync (dest research governs inserter hand capacity — Pitfall #29)
- fluid restore on **non-isolated** pastes (documented skip: if a pasted fluidbox connects outside
  the pasted set, fluid restore is skipped)

So the 19 prove *capture/restore fidelity*, not *transfer* fidelity. Notable members carrying real
risk if only paste-audited: `omnibus-ghosts-and-proxies` (item-request proxies were a measured loss
class), `omnibus-crafting-fluids`, `fusion-loop`, `thruster-pair` (the two ACTIVE-fluid rigs),
`belt-combined-omnibus`, `mining-drill-acid-feed`.

---

## Finding 3 (REGRESSION) — 16 of 25 active pitfalls have no mechanical guard

Many are operational facts that legitimately need none (#1 empty RCON, #3 post-deploy version, #10
mod pack, #13 debug mode, #14 instance-2 seed, #27 icons). The ones that are **code invariants on a
data-integrity path** and currently prose-only:

| # | Slug | Why it matters | Note |
|---|---|---|---|
| 16 | `atomic-belt-scan` | belts keep moving; a non-atomic scan silently drifts counts | no guard |
| 18 | `crafter-handlers-export-fluids` | a new handler forgetting fluidboxes = silent fluid loss | registry **fail-loud arming** is now a structural guard — registry says `null`, **doc inaccuracy** |
| 20 | `failed-entity-loss-attribution` | mis-attribution makes the gate blame a phantom loss | no guard |
| 25 | `localisedstring-20-param-limit` | **hard-crashes the instance** | no guard |
| 32 | `export-only-destination-nil` | `Number(null)===0` is Lua-truthy → source stays locked | no guard |
| 2 | `import-chunking-required` | a single RCON command silently truncates | no guard |

---

## Finding 4 (ZOMBIE LAW — highest severity) — **FIXED in this commit**

> **Status: RESOLVED.** All three sites below were corrected in the same commit that added this audit.
> The table is retained as the record of what was wrong and why it mattered.


The `engine_owned` fluid classification was **deleted** from production (owner ruling 2026-07-20/21;
plasma now rides transfers like any fluid, and the only lawful fluid subtraction is physically
measured `write_rejected`). Three doc sites still present it as current truth — two of them in
**operator-facing incident guidance**:

| Site | What it says | Reality |
|---|---|---|
| `docs/ENGINEERING_FAQ.md:178` | On a `fluids` gate failure on fusion plasma, operator should "Confirm the engine-owned category and symmetric export/restore/census exclusion for the current Factorio pin" | That category/exclusion **does not exist**. Sends an operator hunting deleted code *mid-incident*. |
| `docs/ENGINEERING_FAQ.md:183` | "Engine-owned fluid handling is covered by the `plasma-engine-owned` integration fixture" | Fixture **deleted** (MIGRATION.md Wave 3, 2026-07-21) |
| `docs/testing.md:277-278` | census excludes engine-owned fluids via `count_fluids(..., exclude_engine_owned)`; cites a "queued revision" | Verified signature is `count_fluids(surface, segment_temps)` — **no such parameter**. The "queued revision" was resolved by deletion. |

**The FAQ row is not just stale — it is inverted.** Under current law a plasma mismatch at the gate
is a **real fluid loss** that must fail the transfer and preserve the source. The doc tells the
operator to treat it as a misclassification to be "corrected" — i.e. it advises explaining away a
genuine data-loss signal. This is the single most dangerous item in the audit.

Clean (correctly written as history, no action): `docs/factorio-2.0-api-notes.md` (the 2.0.x fluid section, since purged)
("then-excluded"), `census-accumulator.lua:33` ("No engine-owned exclusion exists on either side").

---

## Proposed guard (NOT built — sequencing matters)

Extend `lint:evidence-claims` to parse `[empirical, <version>]` and fail when `<version>` ≠
`tests/labs-certified.json.factorio_version`, unless the claim carries an explicit
carry-forward annotation (e.g. `[empirical, 2.0.77, carried-forward: <reason>]`).

**It will go red on all 43 immediately.** Correct order:
1. Triage each claim (superseded / load-bearing-unverified / version-independent).
2. Re-tag: superseded → `historical`; unverified → `[hypothesis]` or explicit carry-forward.
3. **Then** land the guard.

**Do not re-tag a claim to 2.1.11 without a measurement.** That launders a hypothesis into an
empirical — precisely the failure the guard's own header was written for (the false "verified
empirically" comment that justified source-deletion constants).

---

## Claim triage

_(filled in below — see "Triage results")_
