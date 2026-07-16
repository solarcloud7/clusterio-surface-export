# Belt Adjacency Phase A Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a lab-only, topology-first demonstration that either reconstructs the real `DUP-233855` belt state with exact lane/side/stack fidelity or stops with a durable negative result before any production restoration code is written.

**Architecture:** A host-side Node runner reads the committed hash-pinned replay and attribution fixtures, builds stable semantic `(source_entity_id, semantic_line_role)` graphs from bounded live observations, and drives disposable Factorio surfaces through RCON. Pure modules own API certification, topology signatures, route legality, scheduling, and verdict calculation; Lua owns only live construction, measurement, and bounded insertion. Rung 0 is a hard gate: later scheduler and restoration tasks are not executed if the real known-loss topology is ambiguous, configured, nondeterministic, geometrically inconsistent, or over budget.

**Tech Stack:** Node.js 24 ESM and `node:test`; PowerShell only for existing cluster-suite orchestration; Factorio Lua runtime 2.0.77; Docker/Clusterio RCON; JSON evidence committed only with a notebook conclusion.

## Global Constraints

- Production files under `docker/seed-data/external_plugins/surface_export/module/` must not change.
- The engine contract is pinned to Factorio `2.0.77`; `/latest/` documentation is not evidence.
- The replay and extracted attribution fixtures are committed and hash-pinned. The downloaded official `runtime-api.json` remains a required CLI path and is certified before any cluster access.
- The fidelity unit is a continuous logical lane/side. Preserve total quantity and the exact `(name, quality, count)` stack multiset; position, order, and tile window are not invariants.
- An unconfigured splitter may use either forward output on the same side. A merge may retain its input or move to shared downstream, but never backward into the sibling input.
- Any network containing a configured splitter is rejected before its first insertion.
- RCON mutation chunks contain at most 25 source rows and at most 10,000 projected detailed-content line reads.
- The full replay has a fixed pre-mutation ceiling of 5,000,000 detailed-content line reads.
- Every source row receives at most one `insert_at` call. Return booleans are diagnostics, never fidelity evidence.
- Each captured source row remains one intact `(name, quality, count)` restoration unit; its source position is diagnostic only.
- Cleanup never writes `game.tick_paused = false` unless the runner itself recorded and owns the transition from false to true. Preflight refuses to mutate a game already paused or carrying jobs, locks, holds, or committed source tombstones.
- Every runner header repeats: **The demo must not weaken this rule to make the replay pass.**
- No cluster execution occurs until the runner receives a read-only code review and its cleanup is proven on an injected synthetic failure.

---

### Task 1: Certify the pinned runtime API offline

**Files:**
- Create: `tests/belt-lab/adjacency/api-contract.mjs`
- Create: `tests/belt-lab/adjacency/api-contract.test.mjs`

**Interfaces:**
- Consumes: parsed official `https://lua-api.factorio.com/2.0.77/runtime-api.json`.
- Produces: `certifyRuntimeApi(schema) -> { version, methods, transportLineRoles }`; throws on any missing or changed contract.

- [ ] **Step 1: Write the failing API-contract test**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { certifyRuntimeApi } from "./api-contract.mjs";

const schema = {
	application_version: "2.0.77",
	classes: [{ name: "LuaEntity", methods: [
		{ name: "get_item_insert_specification", parameters: [{ name: "position", type: "MapPosition" }], return_values: [{ type: "uint32" }, { type: "float" }] },
		{ name: "get_line_item_position", parameters: [{ name: "index", type: "defines.transport_line" }, { name: "position", type: "float" }], return_values: [{ type: "MapPosition" }] },
		{ name: "get_transport_line", parameters: [{ name: "index", type: "defines.transport_line" }], return_values: [{ type: "LuaTransportLine" }] },
	] }],
	defines: [{ name: "transport_line", values: [
		{ name: "left_line" }, { name: "right_line" },
		{ name: "left_underground_line" }, { name: "right_underground_line" },
		{ name: "secondary_left_line" }, { name: "secondary_right_line" },
		{ name: "left_split_line" }, { name: "right_split_line" },
		{ name: "secondary_left_split_line" }, { name: "secondary_right_split_line" },
	] }],
};

test("certifies the complete Factorio 2.0.77 belt API contract", () => {
	const result = certifyRuntimeApi(schema);
	assert.equal(result.version, "2.0.77");
	assert.equal(result.transportLineRoles.length, 10);
	assert.deepEqual(result.methods.get_item_insert_specification.returns, ["uint32", "float"]);
});

test("fails closed when a role or method shape changes", () => {
	const changed = structuredClone(schema);
	changed.defines[0].values.pop();
	assert.throws(() => certifyRuntimeApi(changed), /secondary_right_split_line/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/belt-lab/adjacency/api-contract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `api-contract.mjs`.

- [ ] **Step 3: Implement exact schema lookup and signature comparison**

```js
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXPECTED_ROLES = [
	"left_line", "right_line", "left_underground_line", "right_underground_line",
	"secondary_left_line", "secondary_right_line", "left_split_line", "right_split_line",
	"secondary_left_split_line", "secondary_right_split_line",
];

const EXPECTED_METHODS = {
	get_item_insert_specification: { parameters: ["MapPosition"], returns: ["uint32", "float"] },
	get_line_item_position: { parameters: ["defines.transport_line", "float"], returns: ["MapPosition"] },
	get_transport_line: { parameters: ["defines.transport_line"], returns: ["LuaTransportLine"] },
};

function typeName(value) {
	return typeof value === "string" ? value : value?.complex_type || value?.type || value?.name;
}

export function certifyRuntimeApi(schema) {
	if (schema.application_version !== "2.0.77") throw new Error(`expected 2.0.77, got ${schema.application_version}`);
	const entity = schema.classes?.find(row => row.name === "LuaEntity");
	const methods = {};
	for (const [name, expected] of Object.entries(EXPECTED_METHODS)) {
		const method = entity?.methods?.find(row => row.name === name);
		if (!method) throw new Error(`missing LuaEntity.${name}`);
		const actual = {
			parameters: (method.parameters || []).map(row => typeName(row.type)),
			returns: (method.return_values || []).map(row => typeName(row.type)),
		};
		if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${name} shape changed: ${JSON.stringify(actual)}`);
		methods[name] = actual;
	}
	const define = schema.defines?.find(row => row.name === "transport_line");
	const roles = (define?.values || []).map(row => row.name);
	for (const role of EXPECTED_ROLES) if (!roles.includes(role)) throw new Error(`missing transport-line role ${role}`);
	if (roles.length !== EXPECTED_ROLES.length) throw new Error(`unexpected transport-line role count ${roles.length}`);
	return { version: schema.application_version, methods, transportLineRoles: EXPECTED_ROLES };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const path = process.argv[2];
	if (!path) throw new Error("usage: node api-contract.mjs <runtime-api.json>");
	console.log(JSON.stringify(certifyRuntimeApi(JSON.parse(readFileSync(path, "utf8"))), null, 2));
}
```

- [ ] **Step 4: Test against both the fixture and the downloaded official schema**

Run:

```powershell
Invoke-WebRequest https://lua-api.factorio.com/2.0.77/runtime-api.json -OutFile C:\tmp\runtime-api-2.0.77.json
node tests/belt-lab/adjacency/api-contract.mjs C:\tmp\runtime-api-2.0.77.json
node --test tests/belt-lab/adjacency/api-contract.test.mjs
```

Expected: the CLI prints a JSON contract with version `2.0.77`, three methods, and ten roles; tests PASS.

- [ ] **Step 5: Commit the offline prerequisite**

```powershell
git add tests/belt-lab/adjacency/api-contract.mjs tests/belt-lab/adjacency/api-contract.test.mjs
git commit -m "test(belt-lab): certify adjacency API prerequisites"
```

---

### Task 2: Build and test the semantic lane graph as a pure module

**Files:**
- Create: `tests/belt-lab/adjacency/semantic-graph.mjs`
- Create: `tests/belt-lab/adjacency/semantic-graph.test.mjs`

**Interfaces:**
- Consumes: `{ entities, observations }`, where entity IDs come from the payload and observations contain role-named neighbour and geometry readings.
- Produces: `buildSemanticGraph(input) -> { supported, unsupportedReasons, nodes, edges, routes, signature }`.
- Produces: `legalRegion(graph, sourceNodeKey) -> string[]` using directed forward reachability only.
- Private functions are fixed as `validateDescriptors(input) -> string[]`, `createRoleNamedNodes(input) -> Node[]`, `deriveDirectedEdges(nodes, observations, roleSide) -> Edge[]`, `compareStructuralEdgesToGeometry(edges, observations) -> string[]`, and `directedSameSideReachability(startKey, edges, nodes) -> string[]`.
- Node keys are exactly `${sourceEntityId}:${semanticRole}`; edges are sorted `${from}>${to}` strings before hashing.

- [ ] **Step 1: Write failing tests for side preservation, merge direction, splitter branching, underground pairing, loops, and configured-splitter rejection**

```js
test("merge reaches shared downstream but never the sibling input", () => {
	const graph = buildSemanticGraph(mergeFixture());
	assert.deepEqual(legalRegion(graph, "in-a:left_line"), ["in-a:left_line", "merge:left_line", "out:left_line"]);
	assert.equal(legalRegion(graph, "in-a:left_line").includes("in-b:left_line"), false);
});

test("unconfigured splitter permits either forward same-side output", () => {
	const graph = buildSemanticGraph(splitterFixture({ filter: null, inputPriority: "none", outputPriority: "none" }));
	assert.deepEqual(legalRegion(graph, "input:left_line"), [
		"input:left_line", "split:left_line", "out-a:left_line", "out-b:left_line",
	]);
	assert.equal(legalRegion(graph, "input:left_line").some(key => key.includes("right_line")), false);
});

test("configured splitter rejects its entire weakly connected network", () => {
	const graph = buildSemanticGraph(splitterFixture({ filter: "iron-plate", inputPriority: "none", outputPriority: "none" }));
	assert.equal(graph.supported, false);
	assert.match(graph.unsupportedReasons.join("\n"), /configured splitter/);
	assert.equal(graph.edges.length, 0);
});

test("identical descriptors produce an identical canonical signature", () => {
	assert.equal(buildSemanticGraph(loopFixture()).signature, buildSemanticGraph(loopFixture()).signature);
});
```

- [ ] **Step 2: Run the graph test and verify RED**

Run: `node --test tests/belt-lab/adjacency/semantic-graph.test.mjs`

Expected: FAIL because the graph module and fixtures do not exist.

- [ ] **Step 3: Implement the explicit role-to-side table and fail-closed graph builder**

```js
const ROLE_SIDE = new Map([
	["left_line", "left"], ["left_underground_line", "left"],
	["secondary_left_line", "left"], ["left_split_line", "left"],
	["secondary_left_split_line", "left"],
	["right_line", "right"], ["right_underground_line", "right"],
	["secondary_right_line", "right"], ["right_split_line", "right"],
	["secondary_right_split_line", "right"],
]);

export function nodeKey(entityId, role) { return `${entityId}:${role}`; }

export function buildSemanticGraph(input) {
	const unsupportedReasons = validateDescriptors(input);
	if (unsupportedReasons.length) return { supported: false, unsupportedReasons, nodes: [], edges: [], routes: {}, signature: null };
	const nodes = createRoleNamedNodes(input);
	const edges = deriveDirectedEdges(nodes, input.observations, ROLE_SIDE);
	const geometryFailures = compareStructuralEdgesToGeometry(edges, input.observations);
	if (geometryFailures.length) return { supported: false, unsupportedReasons: geometryFailures, nodes, edges: [], routes: {}, signature: null };
	const routes = Object.fromEntries(nodes.map(node => [node.key, directedSameSideReachability(node.key, edges, nodes)]));
	const signatureRows = [
		...nodes.map(node => `N|${node.key}|${node.side}|${node.entityType}`).sort(),
		...edges.map(edge => `E|${edge.from}>${edge.to}`).sort(),
	];
	return { supported: true, unsupportedReasons: [], nodes, edges, routes, signature: sha256(signatureRows.join("\n")) };
}

export function legalRegion(graph, sourceNodeKey) {
	if (!graph.supported) return [];
	return [...(graph.routes[sourceNodeKey] || [])].sort();
}
```

`deriveDirectedEdges` must accept only observations whose source and target roles map to the same `ROLE_SIDE`, whose neighbour relation is forward under entity position/direction, and whose underground transition names the reciprocal partner. It must not synthesize reverse edges. `validateDescriptors` returns `configured splitter <entity_id>` when any filter is non-null or either priority differs from `none`; the caller rejects every node in that weak network before mutation.

- [ ] **Step 4: Run graph tests and mutation tests**

Run: `node --test tests/belt-lab/adjacency/semantic-graph.test.mjs`

Expected: all topology tests PASS; changing one expected side, merge direction, or configured-splitter check makes its named test fail.

- [ ] **Step 5: Commit the pure topology model**

```powershell
git add tests/belt-lab/adjacency/semantic-graph.mjs tests/belt-lab/adjacency/semantic-graph.test.mjs
git commit -m "test(belt-lab): model directed belt lane adjacency"
```

---

### Task 3: Add fail-safe live construction and observation primitives

**Files:**
- Create: `tests/belt-lab/adjacency/lab-runtime.lua`
- Create: `tests/belt-lab/adjacency/lab-safety.mjs`
- Create: `tests/belt-lab/adjacency/lab-safety.test.mjs`
- Create: `tests/belt-lab/adjacency/runtime-client.mjs`

**Interfaces:**
- `preflight(instances, inspect)` refuses mutation on an existing global pause or any nonzero job/lock/hold/tombstone count.
- `cleanupAll(instances, cleanup, inspect)` attempts cleanup and inspection for every instance even after an earlier failure.
- `RuntimeClient.call(operation, payload)` invokes one Lua operation and rejects any response without `success === true`.
- `RuntimeClient.beginOwnedPause()` first proves `game.tick_paused == false`, sets it true, verifies the readback, and records local ownership; `endOwnedPause()` writes false only when that ownership flag is set.
- Lua operations: `construct`, `observe_graph`, `capture`, `insert_chunk`, `census`, `cleanup`, and `inspect`.

- [ ] **Step 1: Write failing safety tests**

```js
test("preflight blocks before mutation when another operation owns the pause", () => {
	let mutations = 0;
	assert.throws(() => preflight(["host"], () => ({ success: true, gamePaused: true, jobs: 1, locks: 0, holds: 0, tombstones: 0 })), /gamePaused/);
	assert.equal(mutations, 0);
});

test("cleanup visits both instances after the first action throws", () => {
	const calls = [];
	const result = cleanupAll(["one", "two"], instance => {
		calls.push(`clean:${instance}`);
		if (instance === "one") throw new Error("injected cleanup failure");
	}, instance => calls.push(`inspect:${instance}`));
	assert.deepEqual(calls, ["clean:one", "inspect:one", "clean:two", "inspect:two"]);
	assert.match(result.one.errors.join("\n"), /injected cleanup failure/);
});

test("runtime rejects a caught Lua failure payload", () => {
	assert.throws(() => requireLuaSuccess({ success: false, error: "construction failed" }, "construct"), /construction failed/);
});
```

- [ ] **Step 2: Run safety tests and verify RED**

Run: `node --test tests/belt-lab/adjacency/lab-safety.test.mjs`

Expected: FAIL because the safety module does not exist.

- [ ] **Step 3: Implement the safety helpers using the merged PR #105 behavior**

```js
export function requireLuaSuccess(result, operation) {
	if (result?.success !== true) throw new Error(`${operation} failed: ${result?.error || "missing success=true"}`);
	return result;
}

export function preflight(instances, inspect) {
	for (const instance of instances) {
		const state = requireLuaSuccess(inspect(instance), `preflight:${instance}`);
		for (const field of ["gamePaused", "jobs", "locks", "holds", "tombstones"]) {
			if (state[field]) throw new Error(`${instance} preflight blocked by ${field}: ${JSON.stringify(state)}`);
		}
	}
}
```

`cleanupAll` must contain separate `try` blocks for cleanup and final inspection inside the per-instance loop. It records all errors and never changes global pause state it did not acquire.

- [ ] **Step 4: Implement prefix-owned Lua operations**

`lab-runtime.lua` dispatches by `request.operation`. `construct` accepts no more than 25 descriptors, creates only `transport-belt`, `underground-belt`, or `splitter` entities on a disposable prefixed surface, and applies prototype, position, direction, force, quality, underground type, filter, and priorities. `observe_graph` emits role names, runtime line indexes, `belt_shape`, belt neighbours, underground partner, `get_line_item_position`, and `get_item_insert_specification` readings. The geometry control operation must cover one straight, one inside/outside corner, one unconfigured splitter, and one paired underground before R0 trusts those readings. `capture` and `census` emit `{stack={name,quality,count},position,unique_id,ownerEntityId,role}` while the client-owned pause is active. `cleanup` deletes only the prefixed surface and lab storage. `inspect` returns prefix surface count, prefix ground-item count, lab storage, global pause, jobs, locks, holds, and canonical committed tombstones.

- [ ] **Step 5: Prove the cleanup failure path without a shared cluster**

Run: `node --test tests/belt-lab/adjacency/lab-safety.test.mjs`

Expected: PASS, including the injected first-instance cleanup failure and the preflight no-mutation assertion.

- [ ] **Step 6: Commit the live boundary**

```powershell
git add tests/belt-lab/adjacency/lab-runtime.lua tests/belt-lab/adjacency/lab-safety.mjs tests/belt-lab/adjacency/lab-safety.test.mjs tests/belt-lab/adjacency/runtime-client.mjs
git commit -m "test(belt-lab): add fail-safe adjacency runtime"
```

---

### Task 4: Implement and execute the mandatory ADJ-R0 kill check

**Files:**
- Create: `tests/belt-lab/adjacency/run-adjacency.mjs`
- Create: `tests/belt-lab/adjacency/run-adjacency.test.mjs`
- Create: `tests/belt-lab/adjacency/dup-topology.mjs`
- Create after execution only: `tests/belt-lab/results/adjacency-r0-2.0.77.json`
- Modify after execution only: `tests/belt-lab/NOTEBOOK.md`

**Interfaces:**
- CLI: `node run-adjacency.mjs --rung r0 --runtime-api <path> [--dry-run] [--inject-failure] [--write-evidence <new-path>]`.
- Evidence is printed to stdout by default. `--write-evidence` is explicit and create-only; it never overwrites a committed result.
- `analyzeKnownLossTopology(payload, blackBox, graph) -> { endpoints, configuredSplitter, eligible, reasons }` anchors exactly `65243:1`, `65243:2`, and `65907:2`.
- `assertStableSignatures(signatures)`, `assertGeometryControlShapes(controls)`, `assertGeometryAgreement(observations)`, `assertKnownLossEligibility(result)`, and `assertBudgetBelowFixedCeiling(budget)` throw a stop-condition error and never downgrade it to a warning.
- R0 performs no `insert_chunk` operation.

- [ ] **Step 1: Write runner red-teeth tests**

```js
test("R0 rejects any configured splitter in a known-loss weak network before insertion", () => {
	const result = analyzeKnownLossTopology(payloadFixture, blackBoxFixture, configuredGraphFixture);
	assert.equal(result.eligible, false);
	assert.match(result.reasons.join("\n"), /configured splitter/);
});

test("R0 rejects differing hashes from repeated empty-target observations", () => {
	assert.throws(() => assertStableSignatures(["a", "a", "b"]), /nondeterministic/);
});

test("R0 source contains no path that can dispatch insert_chunk", () => {
	assert.doesNotMatch(r0Source, /insert_chunk/);
});
```

- [ ] **Step 2: Run R0 tests and verify RED**

Run: `node --test tests/belt-lab/adjacency/run-adjacency.test.mjs`

Expected: FAIL because the runner and analyzer do not exist.

- [ ] **Step 3: Implement offline payload filtering and exact clean-target comparison**

Filter payload entities to `transport-belt`, `underground-belt`, and `splitter`. Reject unsupported belt-connectable types instead of dropping them. Join live entities back to `entity_id` by the complete construction descriptor and require exactly one match. Compute source stack count, quantity, raw-row count, unique-ID count, network node count, maximum legal-region size, projected reads, and the 5,000,000-read stop before mutation.

- [ ] **Step 4: Implement R0 orchestration in mandatory order**

The runner must execute exactly:

```js
certifyRuntimeApi(runtimeSchema);
preflight([instance], inspect);
constructEmptyTargetInChunks(payloadBelts, 25);
assertOneToOneConstruction();
assert.equal(await wholeSurfaceItemCount(), 0);
await assertGeometryControlShapes(["straight", "corner", "splitter", "underground"]);
const observations = [await observeGraph(), await observeGraph(), await observeGraph()];
assertStableSignatures(observations.map(row => buildSemanticGraph(row).signature));
assertGeometryAgreement(observations);
assertKnownLossEligibility(analyzeKnownLossTopology(payload, blackBox, buildSemanticGraph(observations[0])));
assertBudgetBelowFixedCeiling(projectBudget());
```

All mutation sits after preflight and inside `try/finally`. The `finally` path uses `cleanupAll`, then fails the run unless prefix surfaces, prefix items, lab storage, jobs, locks, holds, tombstones, and pause ownership all return to their pre-run state.

- [ ] **Step 5: Run static tests and every guard before cluster access**

Run:

```powershell
node --test tests/belt-lab/adjacency/*.test.mjs
npm run lint
git diff --check
```

Expected: all tests and guards PASS. Obtain a read-only code review of `tests/belt-lab/adjacency/`; resolve every finding before the next step.

- [ ] **Step 6: Exercise cleanup on an injected synthetic failure**

Run the runner with `--inject-failure after-construction` on the selected idle host. Expected: nonzero exit, zero prefixed surfaces/items/storage, unchanged pre-existing pause state, and zero new jobs/locks/holds/tombstones.

- [ ] **Step 7: Execute R0 once**

Run:

```powershell
node tests/belt-lab/adjacency/run-adjacency.mjs --rung r0 --runtime-api C:\tmp\runtime-api-2.0.77.json --write-evidence C:\tmp\adjacency-r0-fixed.json
```

Expected: either `R0 PASS` with stable signatures, zero ambiguity, geometry agreement, known endpoints eligible, and budget below ceiling; or `R0 STOP` with one exact stop condition and zero leftovers.

- [ ] **Step 8: Enforce the fork in the plan**

If R0 stops, skip Tasks 5–7. Commit the runner, saved concise result, and a `[empirical, 2.0.77]` notebook conclusion that labels scheduler/restoration `NOT TESTED`. Do not write production code.

If R0 passes, commit the R0 runner and evidence, then continue to Task 5.

```powershell
git add tests/belt-lab/adjacency tests/belt-lab/results/adjacency-r0-2.0.77.json tests/belt-lab/NOTEBOOK.md
git commit -m "test(belt-lab): gate adjacency restore on DUP topology"
```

---

### Task 5: Implement the bounded scheduler only after R0 passes

**Files:**
- Create: `tests/belt-lab/adjacency/scheduler.mjs`
- Create: `tests/belt-lab/adjacency/scheduler.test.mjs`

**Interfaces:**
- `distinctCandidates(aliasEvidence, node) -> Candidate[]` removes observational aliases.
- `planReverseWalk(graph, rows, candidates) -> RowPlan[]` returns downstream-to-upstream legal pairs.
- `planCaptureOrderControl(graph, rows, candidates) -> { role: "control", productionCandidate: false, rowPlans: RowPlan[] }` preserves source capture order.
- `planReverseFirstFitOracle(graph, rows, candidates) -> { role: "oracle", productionCandidate: false, rowPlans: RowPlan[] }` provides the prior fixture-local reconstructability oracle.
- `projectReadBudget(rowPlans, fullNetworkLineCount) -> { total, maximumRegion, counterfactual }`.
- `assertReadBudget(budget)` throws when `budget.total > 5_000_000`.
- `executeRowPlan(rowPlan, runtime)`: probes until first true, makes zero or one insertion, and consumes the row.

- [ ] **Step 1: Write failing tests for alias removal, route restriction, bounds, and one-attempt semantics**

```js
test("one accepted probe produces exactly one insertion even when insertion reports false", async () => {
	const calls = [];
	const runtime = {
		canInsert: async pair => (calls.push(`probe:${pair.position}`), true),
		insert: async pair => (calls.push(`insert:${pair.position}`), false),
	};
	const result = await executeRowPlan({ pairs: [{ node: "n", position: 0.5 }] }, runtime);
	assert.deepEqual(calls, ["probe:0.5", "insert:0.5"]);
	assert.equal(result.consumed, true);
});

test("merge plans never contain the sibling input", () => {
	const plan = planReverseWalk(mergeGraph, [rowFromInputA], candidates);
	assert.equal(plan[0].pairs.some(pair => pair.node === "input-b:left_line"), false);
});

test("projected reads stop above the fixed ceiling", () => {
	assert.throws(() => assertReadBudget({ total: 5_000_001 }), /5,000,000/);
});

test("control and oracle can never identify themselves as production candidates", () => {
	assert.equal(planCaptureOrderControl(loopGraph, rows, candidates).productionCandidate, false);
	assert.equal(planReverseFirstFitOracle(loopGraph, rows, candidates).productionCandidate, false);
});
```

- [ ] **Step 2: Verify RED, implement the minimal scheduler, and verify GREEN**

Run: `node --test tests/belt-lab/adjacency/scheduler.test.mjs`

Expected before implementation: FAIL. Expected after implementation: PASS with exact probe bound `sum(row.pairs.length)` and insert bound `rows.length`.

The executor partitions plans before dispatch so every Lua call satisfies both limits: no more than 25 source rows and no more than 10,000 projected legal-region line reads. After each chunk it records Lua profiler duration and performs a read-only RCON heartbeat before sending the next chunk.

- [ ] **Step 3: Commit the scheduler**

```powershell
git add tests/belt-lab/adjacency/scheduler.mjs tests/belt-lab/adjacency/scheduler.test.mjs
git commit -m "test(belt-lab): bound semantic adjacency scheduling"
```

---

### Task 6: Run the conditional synthetic ladder

**Files:**
- Create: `tests/belt-lab/adjacency/fixtures.mjs`
- Create: `tests/belt-lab/adjacency/verdict.mjs`
- Create: `tests/belt-lab/adjacency/verdict.test.mjs`
- Modify: `tests/belt-lab/adjacency/run-adjacency.mjs`
- Create after execution: `tests/belt-lab/results/adjacency-synthetic-2.0.77.json`

**Interfaces:**
- Fixtures construct ADJ-R1 through ADJ-R9 exactly as specified in the design.
- `fixtures.mjs` exports `aliasingFixture`, `closedLoopFixture`, `naturalStacksFixture`, `mixedKeysFixture`, `cornerDeadEndFixture`, `mergeFixture`, `splitterFixture`, `configuredSplitterFixtures`, and `undergroundFixture`.
- `independentVerdict(source, target, associations, graph)` compares whole-surface counts, exact stack multisets, physical side, directed-route legality, outside-region items, and forbidden recovery usage.
- Each schedule runs on a fresh disposable target and is labeled `candidate`, `control`, or `oracle`.

- [ ] **Step 1: Write verdict mutation tests**

Create one valid evidence fixture, then separately mutate quantity, quality, stack count, side, and merge route. Each mutation must make exactly its named verdict field false. Include a configured-splitter fixture asserting zero changed unique IDs and an unchanged whole-network multiset.

- [ ] **Step 2: Verify RED, implement the independent verdict, and verify GREEN**

Run: `node --test tests/belt-lab/adjacency/verdict.test.mjs`

Expected: all independent-meter and mutation tests PASS only after implementation.

- [ ] **Step 3: Add fixtures in rung order**

Implement aliasing/landing, 67/58 closed loop with maximum stack one, natural stacks 1–4, mixed names and qualities on both sides, inside corner plus dead end, merge with distinct origin keys, unconfigured splitter with distinct branch keys, three configured-splitter negative controls, and an underground pair. Before each reconstruction, capture the paused synthetic source atomically and assert raw detailed-content row count equals unique-ID count; a duplicate or missing ownership observation stops that rung. Run the semantic reverse walk as `schedule role=candidate`, capture-order replay as `schedule role=control`, and reverse-first-fit as `schedule role=oracle`, each on a fresh target. The closed-loop candidate uses the smallest `(source_entity_id, role)` anchor and repeats with alternate anchors.

- [ ] **Step 4: Execute one rung at a time**

Run `--sections r1`, inspect and save its evidence, then advance through `r9`. Each schedule uses a newly constructed target and prints `schedule role`, `production candidate`, source stacks, target stacks, quantity delta, side escapes, route escapes, stack changes, unsupported reason, probes, insert calls, detailed-content reads, profiler time, and heartbeat result. When an attempted insertion yields zero or multiple unexplained new unique IDs, perform exactly one immediate full-network diagnostic read, record escaped IDs if present, and stop mutation on that target. Stop immediately on the first failed fidelity or cleanup assertion. Never rerun a failed target with a relaxed bound or eligibility rule.

- [ ] **Step 5: Commit only after the ladder has a conclusion**

```powershell
git add tests/belt-lab/adjacency tests/belt-lab/results/adjacency-synthetic-2.0.77.json
git commit -m "test(belt-lab): exercise adjacency synthetic ladder"
```

---

### Task 7: Run the five-run DUP closing gate and publish the bounded conclusion

**Files:**
- Modify: `tests/belt-lab/adjacency/run-adjacency.mjs`
- Create after execution: `tests/belt-lab/results/adjacency-dup-closing-2.0.77.json`
- Modify after execution: `tests/belt-lab/NOTEBOOK.md`

- [ ] **Step 1: Add the closing-gate assertion before running it**

The runner accepts `--sections r10 --runs 5` only when saved R0 and R1–R9 evidence are green. Each run requires quantity delta zero, exact source/target `(name,quality,count)` multiset per lane region, zero side escapes, zero route escapes, zero stack changes, zero consolidation, zero Plan B, zero hub recovery, zero ground spill, heartbeat continuity, and complete cleanup.

- [ ] **Step 2: Execute five consecutive fresh-target runs**

Run:

```powershell
node tests/belt-lab/adjacency/run-adjacency.mjs --sections r10 --runs 5 --payload C:\Users\Solar\source\FactorioSurfaceExport\tests\belt-lab\evidence\replay_payload_DUP-233855.json --black-box C:\Users\Solar\source\FactorioSurfaceExport\tests\belt-lab\evidence\failure_black_box_DUP-233855_935331.json --runtime-api C:\tmp\runtime-api-2.0.77.json --instance clusterio-host-2-instance-1 --evidence-dir C:\tmp\belt-adjacency-r10
```

Expected: five independent run records. Any single mismatch is a final Phase A negative result, not a retry invitation.

- [ ] **Step 3: Allocate the durable BELT rung without guessing**

Run `git for-each-ref --format='%(refname)'`, then run `git grep -n "BELT-R[0-9]" <each relevant ref> -- tests/belt-lab/NOTEBOOK.md CLAUDE.md docs`. Select the next unused ID only after checking every branch and worktree reference.

- [ ] **Step 4: Write the notebook conclusion**

Append one `[empirical, 2.0.77]` entry containing exact commands, hashes, budgets, timings, run-by-run verdicts, cleanup census, and a `PROVEN / REFUTED / NOT TESTED` table. Explicitly state that even a five-run pass does not authorize production implementation.

- [ ] **Step 5: Run final repository gates twice**

Run the complete integration suite twice consecutively with zero leftovers, then run the full plugin `npm test` and `npm run lint`. Report the two integration suites once. Verify scope with:

```powershell
git diff --name-only origin/main...HEAD
```

Expected: only `tests/belt-lab/**` and this design/plan documentation; no production module, payload, configuration, gate, or hook changes.

- [ ] **Step 6: Request independent adversarial review and commit the conclusion**

The reviewer must attack route legality, configured-splitter pre-mutation rejection, per-row one-attempt semantics, unique-ID ownership, verdict independence, cleanup pause ownership, read budgets, and the claimed proof boundary. Resolve or explicitly adjudicate every finding before opening or updating the PR.

```powershell
git add tests/belt-lab docs/superpowers/specs/2026-07-15-belt-adjacency-phase-a-demo-design.md docs/superpowers/plans/2026-07-15-belt-adjacency-phase-a-demo.md
git commit -m "test(belt-lab): conclude semantic adjacency Phase A"
```

## Final Self-Review Checklist

- [ ] Every included topology has a named rung and an independent verdict.
- [ ] Filtered and priority splitters reject the entire weak network before insertion.
- [ ] R0 runs before scheduler implementation or insertion cluster time.
- [ ] No engine line identity, `line_equals`, `input_lines`, or `output_lines` is used as a cross-import key.
- [ ] Every insertion is associated by new unique IDs found only through independent detailed-content reads.
- [ ] Every read and insertion budget is computed before mutation and never raised after failure.
- [ ] All cleanup paths preserve unrelated global pause ownership and attempt every instance.
- [ ] A negative R0 or later rung stops production work and still produces a durable conclusion.
- [ ] No production file, payload field, configuration key, gate, recovery route, or test hook changed.
