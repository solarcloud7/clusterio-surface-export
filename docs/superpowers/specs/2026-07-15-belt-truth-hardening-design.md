# Belt truth-hardening design

## Purpose

Fortify the merged BELT-R9 negative result by correcting durable project guidance before another belt-restoration design is attempted. The documentation must distinguish global item conservation from continuous belt-lane fidelity and must prevent the rejected cross-import engine-line mapper from being revived as established architecture.

## Evidence boundary

The authoritative evidence is `tests/belt-lab/NOTEBOOK.md` BELT-R9 and the saved `tests/belt-lab/results/plan-a-phase-a-stop-2.0.77.txt` result:

- Five DUP-233855 baseline replays reproduced a belt-phase deficit of five items, followed by the existing recovery.
- The known loss endpoints belong to components whose owner-narrowed `line_equals` resolution is ambiguous.
- Identical imports produced different component, ambiguity, and resolved-edge counts.
- Therefore a source-to-destination mapper based on engine transport-line identity is not certifiable for the known production failure class.

This evidence does **not** prove that every packed-belt transfer loses items, that global conservation is broken after recovery, or that a physical adjacency-walk restoration will work.

The owner-defined belt-fidelity unit is one whole continuous lane/side, aggregated across the belt entities that comprise it. A faithful restore preserves that lane's exact multiset of `(name, quality, stack count)` and neither removes quantity from nor adds quantity to the lane. Item order, exact coordinate, and ownership by an individual belt-tile window are not fidelity requirements because transport is the belt's purpose.

## Documentation changes

### `CLAUDE.md`

Replace the unqualified statement that belt restoration is fixed to exact physical totals with a three-part contract:

1. The frozen item verdict requires exact whole-transfer conservation.
2. Existing hub/ground recovery can satisfy that global verdict after a belt-phase deficit.
3. Whole-lane fidelity for fully compressed belts is not yet guaranteed; BELT-R9 rejects cross-import engine-line identity mapping as the solution.

The text will point to the belt lab notebook and retain the existing warning that historical loss was real rather than cosmetic.

### `docs/ENGINEERING_FAQ.md`

Replace “packed belts are 100% preserved” with operator-facing truth:

- Exact global item conservation remains mandatory.
- A successful transfer may use existing recovery after belt restoration cannot reproduce the compressed state.
- Exact continuous-lane/side stack and quality preservation is an open fidelity gap; per-tile positions are not the contract.
- Repeated small belt-attributed deficits remain a retain-the-black-box/stop-retrying condition.

The FAQ must not describe physical adjacency restoration as implemented or proven.

### `docs/factorio-2.0-api-notes.md`

Preserve the 2.0.76 item-counting facts, which BELT-R9 does not refute. Add a separate 2.0.77 transport-line topology note stating that:

- `get_item_count` and unique-ID enumeration remain valid physical meters within their documented scope.
- Owner-narrowed `line_equals` resolution can be ambiguous.
- Cross-import graph shape is nondeterministic on DUP-233855.
- Engine line identity must not be used as a durable source-to-destination restoration key for the owner-defined continuous lane/side.

## Scope boundaries

This change is documentation-only. It adds no restoration code, serializer field, configuration, validation behavior, test hook, lint allow, or new guard. It does not alter the existing global exact gate or recovery behavior.

The physical adjacency-walk candidate and guard red-team are separate follow-up designs. The adjacency candidate must receive a fresh lab-only Phase A with the real DUP-233855 replay and explicit stop conditions before production implementation.

## Verification

- Check every changed claim against BELT-R9 and the saved stop-result artifact.
- Search the durable guidance surfaces for remaining unqualified claims that packed belts are fully or exactly preserved.
- Verify all relative Markdown links resolve.
- Run the existing repository documentation/evidence-claim checks that apply to Markdown-only changes.
- Confirm the diff contains no production or test-hook files.

## Approaches considered

1. **Documentation first — selected.** Locks the proof boundary before another hypothesis creates fresh prose drift.
2. **Adjacency lab first.** Advances the possible fix sooner but leaves current operator and implementer guidance overstated during the experiment.
3. **Guard red-team first.** Valuable infrastructure hardening, but it does not protect this newly established belt-specific decision boundary.

## Acceptance criteria

- Durable documentation explicitly distinguishes global conservation from whole-lane/side stack fidelity.
- BELT-R9 is cited as a negative result with its scope intact.
- No document calls adjacency-walk restoration proven or production-ready.
- No code or runtime behavior changes.
