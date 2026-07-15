# Belt Adjacency Phase A Demo Design

**Status:** Approved direction; lab design only

**Engine:** Factorio 2.0.77

**Branch:** `codex/belt-adjacency-phase-a`

## Purpose

Build a disposable, instrumented demonstration of topology-aware belt restoration without changing production restoration, validation, transfer behavior, payloads, or configuration.

The demo tests the remaining candidate after BELT-R9 ruled out cross-import `LuaTransportLine` identity: a directed graph made from stable entity structure and semantic belt-side roles. It must show where every restored stack is allowed to land, where it actually lands, and whether the final lane-wide state preserves the owner's fidelity contract.

The demo is evidence generation, not an enablement decision. A passing synthetic fixture does not authorize production work. The real `DUP-233855` replay remains the headline gate.

## Owner Fidelity Contract

The fidelity unit is a continuous logical belt lane, not an individual belt entity window.

For every supported logical lane region, restoration must preserve:

- total item quantity;
- the exact multiset of `(name, quality, count)` stacks;
- the same physical left or right belt side;
- a legal forward route through the belt network.

Exact coordinates, ordering, and the particular belt tile window are not fidelity requirements.

At an unconfigured splitter, either forward output branch is acceptable when the physical lane side is preserved. At a merge, the original input branch or the shared downstream lane is acceptable. Moving backward into the sibling input branch is not acceptable.

Consolidating stacks, splitting stacks, changing quality, crossing belt sides, losing items, or moving items onto an illegal branch is a failure.

## Scope

### Included

- A lab-only source capture and target reconstruction runner.
- Semantic entity-lane graph construction for ordinary belts, corners, closed loops, dead ends, merges, unconfigured splitters, and underground pairs.
- Independent geometry and unique-ID landing observations.
- A downstream-to-upstream adjacency restoration candidate.
- Synthetic fixtures plus the banked `DUP-233855` replay when the payload is available to the runner.
- Saved machine-readable evidence and a notebook conclusion tagged `[empirical, 2.0.77]`.

### Excluded

- Production changes under `docker/seed-data/external_plugins/surface_export/module/`.
- New payload fields, configuration keys, gates, recovery behavior, or test hooks.
- Standalone import behavior.
- Plan B consolidation or hub/ground recovery.
- Support for filtered or priority-configured splitters.
- Any claim that Factorio documents final `insert_at` landing behavior.

## Architecture

### 1. Semantic entity-lane graph

The graph does not use `LuaTransportLine.line_equals`, `input_lines`, `output_lines`, or an internal line object as durable identity.

Each node is:

```text
(source_entity_id, semantic_line_role)
```

`source_entity_id` is the serialized entity identity already used to join a created target entity through `entity_map`. `semantic_line_role` is an explicitly supported `defines.transport_line` role, recorded by name in evidence rather than inferred from an unexplained numeric index.

Primary directed edges are derived from:

- entity type, position, direction, and `belt_shape`;
- `belt_neighbours.inputs` and `belt_neighbours.outputs` for belt-connectable adjacency;
- `neighbours` for the underground partner omitted from `belt_neighbours`;
- explicit, version-certified transition tables for physical left/right lanes.

The builder refuses unknown entity types, line roles, multiple neighbour candidates for a transition that must be singular, inconsistent underground pairs, or a transition whose direction contradicts the entity geometry.

`get_line_item_position` and `get_item_insert_specification` form a separate geometric cross-check. They do not create the primary edge. A disagreement between the structural edge and the engine-assisted observation makes the region unsupported.

### 2. Splitter constraint

A splitter is eligible only when all of the following are true on both source and target:

```text
splitter_filter == nil
splitter_input_priority == "none"
splitter_output_priority == "none"
```

Any weakly connected belt network containing a filtered or priority-configured splitter is unsupported as a whole. The demo performs no restoration mutation anywhere in that network. This deliberately prevents insertion displacement from crossing a nominal boundary into a configured splitter.

The negative-control fixture proves that the runner detects the configured splitter before the first insertion and leaves every connected line unchanged.

If the known `DUP-233855` loss network contains a configured splitter, Phase A stops with that coverage result. The demo must not weaken this rule to make the replay pass.

### 3. Legal placement regions

For each captured source node, the graph computes directed forward reachability while preserving the physical lane side.

- A straight or corner continues to the matching physical side.
- An underground input continues through its verified partner to the matching exit side.
- An eligible splitter may branch to either forward output on the same side.
- A merge may continue from either input into the shared downstream side.
- No reverse edge is synthesized, so one merge input cannot reach the sibling input.

The resulting allowed node set is the source stack's legal placement region. Closed loops are represented as directed strongly connected regions; all same-side nodes in that directed loop are legal for a source stack already on the loop.

This is more precise than an undirected connected component. Aggregate membership alone would incorrectly permit backward movement through a merge.

### 4. Capture model

The source fixture is read atomically while ticks are paused. Each detailed-content row records:

```text
source node
name
quality
count
source position (diagnostic only)
source unique_id (lab observation only)
allowed target node set
```

The exact `(name, quality, count)` row is the restoration unit. Source position is not part of the verdict. Source `unique_id` is not serialized as a proposed production field and is not expected to survive export/import.

Raw rows and source unique IDs are compared to establish whether the lab capture reads each physical stack exactly once. A duplicate or missing ownership observation stops the affected rung; the demo does not silently deduplicate the restoration input.

### 5. Target matching

After all target entities exist and before any item insertion, the runner rebuilds the semantic graph using the created entities joined back to their source IDs.

The source and empty-target graph signatures must match exactly for:

- node keys;
- directed structural edges;
- underground partner relations;
- entity directions and belt shapes;
- splitter eligibility state;
- structural-versus-geometric cross-check outcomes.

The graph is built repeatedly on the same empty target. Different signatures from identical state are a stop condition. This explicitly tests that the new graph avoids BELT-R9's run-dependent internal-line result.

Unsupported mapping is detected before mutation. There is no mixed partial run in which some stacks are placed before the topology is rejected.

## Demo Restoration Candidate

The demo compares three schedules against the same captured rows:

1. **Semantic adjacency reverse walk — candidate.** Visit target nodes from downstream toward upstream. Within a node, visit only distinct version-certified candidate positions in descending line order. Offer each intact source stack only to nodes inside its legal region.
2. **Capture-order replay — control.** Replay source entity windows in capture order. This is measured because it succeeded on one observed fixture, but it cannot establish route legality and is not a production candidate.
3. **Reverse-first-fit — lab oracle.** Use the previously successful fixture-local reverse schedule to establish whether the target is physically reconstructable without stack changes. It remains an oracle, not an architecture.

Before reconstruction, an aliasing rung sweeps requested `/256` positions on a disposable line and records distinct actual landing positions. The candidate scheduler removes requests that are observationally equivalent on 2.0.77; it does not spend repeated probes on aliased positions.

For each source stack, the scheduler constructs an ordered list of legal `(target node, candidate position)` pairs. It calls `can_insert_at` in that order until the first `true`, then makes exactly one `insert_at` call and consumes the source row regardless of the return value or observed placement. Because each insertion changes the line state, probe results are not cached between source rows.

If a source stack has `C_r` legal candidate pairs, its probe bound is `C_r`. For `S` source stacks, the global round bound is the exact sum of all `C_r` values, and the insert-call bound is `S`. A row that exhausts its candidates receives no insertion. These bounds, actual calls, elapsed belt-phase time, and heartbeat continuity are reported. The lab does not raise a bound after seeing a failure.

Each source stack therefore receives at most one `insert_at` attempt in a candidate round. The return boolean is logged but never treated as proof of full placement. There is no stack-by-stack retry, consolidation, splitting, or oversized insertion.

After an attempt, the runner diffs detailed-content unique IDs across the complete eligible network. For every newly observed ID it records:

```text
requested node and position
insert_at return value
actual owner and semantic node
actual position
actual (name, quality, count)
source row association
whether the actual node is in the allowed region
```

Zero new IDs, multiple unexplained new IDs, partial counts, or a landing outside the allowed region are failures. At the first such failure, the runner records the target snapshot and performs no further mutation on that target. Other schedules or fixtures run only on newly created disposable targets. A failed schedule cannot be reported as faithful.

For a closed loop with no sink, the reverse walk uses a deterministic canonical anchor derived from the smallest source entity ID and semantic role. The loop rung repeats with alternate anchors to prove success is not an accidental capture-order property.

## Independent Verdicts

The runner's placement metrics are never the fidelity oracle.

After each schedule, independent reads calculate:

- source and target whole-surface `get_item_count`;
- source and target lane-region detailed contents;
- raw row count versus unique-ID count;
- exact `(name, quality, count)` stack multisets;
- physical left/right side membership;
- legal directed-route membership for every associated landing;
- items outside all expected belt regions;
- use of consolidation, Plan B, hub recovery, or ground spill, which must all remain zero.

The configured-splitter negative control additionally requires zero changed unique IDs and an unchanged whole-network multiset.

## Demonstration Fixtures

The first demo report contains these rungs:

1. **125-item closed loop:** the existing 5x5 source with 67/58 lane totals and an empty matching target; maximum stack count one.
2. **Natural stacks:** exact stack counts 1 through 4, with no consolidation or splitting.
3. **Mixed keys:** multiple item names and qualities on both physical sides.
4. **Corner and dead end:** short inside corner lane plus a saturated terminal section.
5. **Merge:** distinct source keys on both inputs; each may reach only itself or shared downstream, never the sibling input.
6. **Unconfigured splitter:** distinct traceable keys establish same-side branching to either forward output.
7. **Configured splitter negative control:** filter, input priority, and output priority variants each reject the entire connected network before mutation.
8. **Underground pair:** both sides across the paired gap.
9. **Aliasing and landing:** requested position, actual position, semantic node, and unique ID.
10. **`DUP-233855`:** five consecutive current-main baselines reproduce the belt-phase deficit; five candidate runs must produce lane-region delta zero with no consolidation or recovery.

The synthetic split and merge fixtures use distinct names or qualities at each origin so an illegal branch movement remains independently observable even if the engine changes a landing immediately after insertion.

## Evidence and Presentation

The demo produces:

- a concise console table per rung and schedule;
- a JSON evidence file containing graph signatures, route sets, insertion attempts, unique-ID landings, independent censuses, timing, and cleanup state;
- a human-readable result summary separating `PROVEN`, `REFUTED`, and `NOT TESTED` claims;
- a `tests/belt-lab/NOTEBOOK.md` conclusion tagged `[empirical, 2.0.77]`;
- optional screenshots only as illustrations, never as count evidence.

The discussion view should make these comparisons immediate:

```text
fixture | schedule | source stacks | target stacks | quantity delta
        | side escapes | route escapes | stack changes | unsupported reason
```

## Stop Conditions

Stop without production implementation if any of the following occurs:

- The semantic graph is ambiguous, state-dependent, or differs between source and empty target.
- Structural and engine-assisted geometry disagree.
- A configured splitter is mutated or must be crossed to cover the known loss network.
- An accepted insertion lands outside its source stack's legal region.
- An intact source stack is split, consolidated, partially placed, or has quality changed.
- The 125-item loop cannot reach exact fidelity under the candidate schedule.
- `DUP-233855` cannot reach zero lane-region delta without recovery in five consecutive runs.
- Source ownership or final census cannot be made commensurate with the global item count.
- Synchronous work causes a heartbeat, profiler, or cleanup regression.

Every stop is a valid lab result. No scheduler budget, topology eligibility rule, or fidelity criterion may be relaxed during the run to convert a negative result into a pass.

## Cleanup and Cluster Discipline

The runner uses disposable surfaces and a `finally` cleanup path. Every exit, including an assertion failure, must leave:

- zero demo surfaces;
- zero demo jobs, locks, or holds;
- no items spilled to ground or recovery hubs;
- `game.tick_paused == false`;
- the selected cluster host at its pre-run state.

The demo does not run concurrently with another mutating lab on the same host. Cluster execution begins only after the runner has a read-only review and its cleanup path has been exercised on a synthetic failure.

## Success Boundary

A successful demo proves only that the semantic adjacency model and candidate schedule satisfy the listed rungs on Factorio 2.0.77, including the real known-loss replay. It does not prove all arbitrary modded belt topologies, configured splitters, future engine versions, or production readiness.

Only after the evidence is reviewed may a separate production design and implementation plan be proposed.
