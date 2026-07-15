# Belt Truth Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct durable belt-restoration guidance so it distinguishes exact global conservation from unresolved same-logical-segment fidelity.

**Architecture:** This is a documentation-only correction grounded in BELT-R9 and its saved Phase A stop result. Three durable guidance surfaces receive role-specific wording; historical plans and production behavior remain untouched.

**Tech Stack:** Markdown, PowerShell, ripgrep, existing Node.js documentation/evidence guards.

## Global Constraints

- Add no restoration code, serializer field, configuration, validation behavior, test hook, lint allow, or new guard.
- Preserve the existing global exact item gate and hub/ground recovery behavior.
- Preserve the 2.0.76 physical item-counting evidence; BELT-R9 invalidates durable engine-line mapping, not the counting meter.
- Describe physical adjacency-walk restoration only as an unproven follow-up hypothesis.
- Ground every new 2.0.77 claim in `tests/belt-lab/NOTEBOOK.md` BELT-R9 and `tests/belt-lab/results/plan-a-phase-a-stop-2.0.77.txt`.

---

### Task 1: Correct the durable belt contract

**Files:**
- Modify: `CLAUDE.md:675`
- Modify: `docs/ENGINEERING_FAQ.md:173`
- Modify: `docs/factorio-2.0-api-notes.md:149`

**Interfaces:**
- Consumes: BELT-R9 notebook conclusion and the saved Phase A stop result.
- Produces: one consistent three-part contract—global conservation is enforced, recovery may relocate belt deficits, and same-segment fidelity remains unresolved.

- [ ] **Step 1: Confirm the stale claims are present**

Run:

```powershell
rg -n "fixed to exact physical totals|100% preserved|fixed to zero" CLAUDE.md docs/ENGINEERING_FAQ.md
```

Expected: matches at `CLAUDE.md:676` and `docs/ENGINEERING_FAQ.md:174-175`.

- [ ] **Step 2: Replace the `CLAUDE.md` belt invariant**

Replace the existing “Historical belt restore loss” bullet with:

```markdown
- **Historical belt restore loss (formerly described as ±4–8 cosmetic drift).** The residual was real
  restore-time loss, not harmless redistribution. The frozen `items` verdict requires exact global
  conservation, and the existing hub/ground recovery can satisfy that verdict after a belt-phase deficit.
  This does **not** guarantee that fully compressed items remain on the same logical belt segment. BELT-R9
  proved that owner-narrowed `line_equals` resolution is ambiguous on the known DUP-233855 loss components
  and that the imported engine-line graph varies across identical imports, so engine transport-line identity
  is not a durable restoration key. See [the belt lab notebook](tests/belt-lab/NOTEBOOK.md#belt-r9-empirical-2077---topology-first-plan-a-stops-on-the-real-dup-233855-component).
```

- [ ] **Step 3: Replace the packed-belt FAQ answer**

Replace the answer under `Q: What if my belts are packed with items?` with:

```markdown
A: Exact **global item conservation** is mandatory at the frozen `items` gate. When ordinary belt
restoration cannot reproduce a fully compressed state, the shipped hub/ground recovery may conserve the
deficit elsewhere and allow the transfer to pass. Exact same-logical-segment placement is therefore not yet
guaranteed. BELT-R9 rejected cross-import engine transport-line identity as a restoration key for the known
DUP-233855 loss components; physical adjacency-walk restoration remains an unproven lab candidate. Preserve
repeated small belt-loss black boxes as described above rather than treating a globally green transfer as
proof of same-segment fidelity.
```

- [ ] **Step 4: Add the 2.0.77 topology limitation to the API notes**

Append this paragraph after the existing 2.0.76 `line_equals` warning and before the engine-invariants bullet:

```markdown
- **[empirical, 2.0.77, BELT-R9] Engine transport-line identity is not a durable cross-import restoration
  key.** On five DUP-233855 baseline replays, the known belt-phase deficit was exactly five items before
  recovery. Owner-narrowed `line_equals` resolution produced multiple matches on both known loss components,
  and three identical imports produced different component/ambiguity/resolved-edge counts. This does not
  invalidate `get_item_count` or unique-ID enumeration as physical meters; it invalidates using the engine
  line graph to certify that a source line and an empty imported line are the same logical segment. See
  [BELT-R9](../tests/belt-lab/NOTEBOOK.md#belt-r9-empirical-2077---topology-first-plan-a-stops-on-the-real-dup-233855-component).
```

- [ ] **Step 5: Confirm the stale claims are gone and the boundary is present**

Run:

```powershell
rg -n "fixed to exact physical totals|A: ✅ 100% preserved|residual once described as cosmetic.*fixed to zero" CLAUDE.md docs/ENGINEERING_FAQ.md
rg -n "same logical belt segment|same-logical-segment|durable cross-import restoration" CLAUDE.md docs/ENGINEERING_FAQ.md docs/factorio-2.0-api-notes.md
```

Expected: the first command returns no matches; the second returns one scoped statement in each changed file.

### Task 2: Verify evidence grounding and commit the correction

**Files:**
- Verify: `CLAUDE.md`
- Verify: `docs/ENGINEERING_FAQ.md`
- Verify: `docs/factorio-2.0-api-notes.md`
- Verify: `tests/belt-lab/NOTEBOOK.md`
- Verify: `tests/belt-lab/results/plan-a-phase-a-stop-2.0.77.txt`

**Interfaces:**
- Consumes: the three corrected documentation surfaces from Task 1.
- Produces: a documentation-only commit with resolving links and green evidence guards.

- [ ] **Step 1: Verify the Markdown anchors exist**

Run:

```powershell
rg -n "^## BELT-R9 \[empirical, 2\.0\.77\]" tests/belt-lab/NOTEBOOK.md
rg -n "VERDICT: PHASE A STOP|expected 15,866, actual 15,861|ambiguous" tests/belt-lab/results/plan-a-phase-a-stop-2.0.77.txt
```

Expected: the BELT-R9 heading and the stop-result evidence all match.

- [ ] **Step 2: Run documentation and evidence guards**

Run from `docker/seed-data/external_plugins/surface_export`:

```powershell
npm run lint:doc-refs
npm run lint:evidence-claims
npm run lint:version-certification
```

Expected: all three commands exit zero.

- [ ] **Step 3: Verify scope and whitespace**

Run from the repository root:

```powershell
git diff --check
git diff --name-only HEAD
```

Expected: `git diff --check` exits zero; the name-only list contains exactly `CLAUDE.md`, `docs/ENGINEERING_FAQ.md`, and `docs/factorio-2.0-api-notes.md`.

- [ ] **Step 4: Commit the docs-only correction**

```powershell
git add CLAUDE.md docs/ENGINEERING_FAQ.md docs/factorio-2.0-api-notes.md
git commit -m "docs: correct packed-belt fidelity claims"
```

- [ ] **Step 5: Verify the branch result**

Run:

```powershell
git status --short --branch
git diff --stat origin/main...HEAD
```

Expected: clean status; branch diff contains only the approved spec, this plan, and the three durable documentation files.
