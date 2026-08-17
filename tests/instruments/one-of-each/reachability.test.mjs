// reachability.test — the return-dominance arm, calibrated against the shape that shipped the bug
//
// requires: reachability.mjs and the vendored Lua 5.2 parser it loads
// produces: the calibration pair (the pre-#277 restore_entity_state shape flags its `tags` write, the
//           post-#277 shape does not, with the same considered/evaluated counts either way), and one
//           case per narrowing the arm claims — type-constrained writes, specific_data-derived keys,
//           refused goto scopes, closure transparency, and the block shapes that are NOT exit gates
// does not: read the module tree (every source here is synthetic), or assert anything about whether a
//           flagged write loses data — that is the payload question the arm never asks

import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeSources } from "./reachability.mjs";

const lua = (...lines) => [{ rel: "synthetic.lua", source: lines.join("\n") }];
const analyze = (...lines) => analyzeSources(lua(...lines));

const GHOST_BRANCHES = [
	"  local data = entity_data.specific_data",
	"  if entity.type == \"entity-ghost\" then",
	"    entity.insert_plan = data.insert_plan",
	"    return",
	"  end",
	"  if entity.type == \"tile-ghost\" then",
	"    return",
	"  end",
	"  if data.grown_ticks_remaining ~= nil then",
	"    entity.tick_grown = data.grown_ticks_remaining",
	"  end",
	"  if entity.type == \"linked-belt\" and entity_data.direction ~= nil then",
	"    safe_call(\"d\", function() entity.direction = entity_data.direction end)",
	"  end",
	"  if entity.type == \"train-stop\" then",
	"    if entity_data.backer_name then",
	"      entity.backer_name = entity_data.backer_name",
	"    end",
	"  end",
];

const TAGS_BLOCK = [
	"  if entity_data.tags then",
	"    entity.tags = entity_data.tags",
	"  end",
];

const SPECIFIC_DATA_GATE = [
	"  if not entity_data.specific_data then",
	"    return",
	"  end",
];

const preFix = analyze(
	"function Deserializer.restore_entity_state(entity, entity_data)",
	"  if not entity.valid then",
	"    return",
	"  end",
	...SPECIFIC_DATA_GATE,
	...GHOST_BRANCHES,
	...TAGS_BLOCK,
	"end",
);

const postFix = analyze(
	"function Deserializer.restore_entity_state(entity, entity_data)",
	"  if not entity.valid then",
	"    return",
	"  end",
	"  if entity_data.tags then",
	"    safe_call(\"tags\", function() entity.tags = entity_data.tags end)",
	"  end",
	...SPECIFIC_DATA_GATE,
	...GHOST_BRANCHES,
	"end",
);

test("CALIBRATION RED: the pre-#277 tags write is return-dominated, and says by what", () => {
	assert.equal(preFix.return_dominated.length, 1);
	const row = preFix.return_dominated[0];
	assert.equal(row.property, "tags");
	assert.equal(row.function, "Deserializer.restore_entity_state");
	assert.deepEqual(row.payload_fields, ["tags"]);
	assert.deepEqual(row.excluded_types, ["entity-ghost", "tile-ghost"],
		"the two branches that return are the classes the write can never reach — naming them is the whole "
		+ "finding, because a reader then asks whether those are the classes that carry the field");
	assert.deepEqual(row.required_fields, ["specific_data"],
		"the write's own key is entity_data.tags, a TOP-LEVEL field, yet a return above it requires an "
		+ "unrelated sibling field to be present first");
});

test("CALIBRATION GREEN: moving the write above the returns clears it, with nothing hidden", () => {
	assert.deepEqual(postFix.return_dominated, []);
	assert.equal(postFix.considered, preFix.considered,
		"the fix must not clear the finding by making the write invisible — the same write sites are seen");
	assert.equal(postFix.evaluated, preFix.evaluated,
		"and the tags write is still EVALUATED after the fix (it is inside a safe_call closure there), so "
		+ "the green is a reachability result, not a walk that stopped at the closure boundary");
	assert.ok(preFix.evaluated > 0 && preFix.considered > preFix.evaluated);
});

test("a write that names an entity type in its guard chain is not evaluated, in EITHER shape", () => {
	assert.equal(preFix.return_dominated.some(row => row.property === "direction"), false,
		"linked-belt's type test is a CONJUNCT of the write's own `if` condition");
	assert.equal(preFix.return_dominated.some(row => row.property === "backer_name"), false,
		"train-stop's type test is an ENCLOSING clause condition, a different AST shape — an arm that "
		+ "reads only one of the two shapes reports the other as a universal write below the ghost returns");

	const enclosing = analyze(
		"function M.f(entity, entity_data)",
		"  if not entity_data.specific_data then return end",
		"  if entity.type == \"container\" then",
		"    entity.tags = entity_data.tags",
		"  end",
		"end",
	);
	assert.deepEqual(enclosing.return_dominated, []);
	assert.equal(enclosing.evaluated, 0, "a type-constrained write is not evaluated at all, not evaluated-and-cleared");

	const conjunct = analyze(
		"function M.f(entity, entity_data)",
		"  if not entity_data.specific_data then return end",
		"  if entity.type == \"container\" and entity_data.tags then",
		"    entity.tags = entity_data.tags",
		"  end",
		"end",
	);
	assert.deepEqual(conjunct.return_dominated, []);
	assert.equal(conjunct.evaluated, 0);
});

test("a write keyed on a specific_data-derived local is not evaluated", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if not entity_data.specific_data then return end",
		"  if entity.type == \"entity-ghost\" then return end",
		"  local data = entity_data.specific_data",
		"  if data.fluid_filter then",
		"    entity.fluid_filter = data.fluid_filter",
		"  end",
		"end",
	);
	assert.equal(result.considered, 1);
	assert.equal(result.evaluated, 0,
		"the field's presence already implies a handler ran, and which categories that covers is not in "
		+ "this file — the arm declines rather than guessing");
	assert.deepEqual(result.return_dominated, []);
});

test("a gate whose condition the arm cannot read contributes nothing, rather than a guess", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if not entity.valid then return end",
		"  if some_helper(entity) then return end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.equal(result.evaluated, 1, "the write is evaluated");
	assert.deepEqual(result.return_dominated, [],
		"`not entity.valid` reads off the RECEIVER, not the payload, and a call is opaque — neither "
		+ "excludes a type nor requires a payload field, so neither is reported as one");
});

test("a type exclusion is read off the RECEIVER's type, never off the payload's copy of it", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if entity_data.type == \"entity-ghost\" then",
		"    return",
		"  end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.equal(result.evaluated, 1);
	assert.deepEqual(result.return_dominated, [],
		"entity_data.type is what the exporter recorded, and the arm has no evidence in this file that it "
		+ "equals the type the destination entity actually has — it reads the gate as opaque rather than "
		+ "excluding a class on an assumption");
});

test("a return-dominating gate is read through an == nil test as well as a `not`", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if entity_data.specific_data == nil then return end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.deepEqual(result.return_dominated.map(row => row.required_fields), [["specific_data"]]);
});

test("a gate requiring the write's OWN field is not reported as a condition it inherits", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if not entity_data.tags then return end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.deepEqual(result.return_dominated, [],
		"a return that requires exactly the field being restored is the write's own guard hoisted, not a "
		+ "condition that can make it unreachable while its key is present");
});

test("only a branch that ALWAYS returns is an exit gate", () => {
	const conditional = analyze(
		"function M.f(entity, entity_data)",
		"  if entity.type == \"entity-ghost\" then",
		"    if entity_data.deep then return end",
		"  end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.deepEqual(conditional.return_dominated, [],
		"the ghost branch can fall through, so reaching the write says nothing about the entity's type");

	const withElse = analyze(
		"function M.f(entity, entity_data)",
		"  if entity.type == \"entity-ghost\" then",
		"    return",
		"  else",
		"    log(\"other\")",
		"  end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.deepEqual(withElse.return_dominated, [],
		"an if/else is not read as a gate — the arm only claims dominance for the single-clause shape");
});

test("an elseif chain whose every arm returns is still not read as a gate", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if entity.type == \"entity-ghost\" then",
		"    return",
		"  elseif entity.type == \"tile-ghost\" then",
		"    return",
		"  end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.equal(result.evaluated, 1);
	assert.deepEqual(result.return_dominated, [],
		"reaching the write does exclude both classes here, so this is a MISSED finding, not a wrong one — "
		+ "the arm reads only the single-clause shape, and the conservative direction is the safe one");
});

test("error() is not read as an exit, so a write below one is not dominated by it", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if entity.type == \"entity-ghost\" then",
		"    error(\"ghosts are handled elsewhere\")",
		"  end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.equal(result.evaluated, 1);
	assert.deepEqual(result.return_dominated, [],
		"error() does leave the function, so this is another MISSED finding — the arm claims dominance only "
		+ "from a literal `return`, and a caller's pcall could make the claim wrong anyway");
});

test("a return in a block that does not ENCLOSE the write does not dominate it", () => {
	const sibling = analyze(
		"function M.f(entity, entity_data)",
		"  for _, item in ipairs(entity_data.list) do",
		"    if entity.type == \"entity-ghost\" then return end",
		"  end",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.deepEqual(sibling.return_dominated, [],
		"a loop that runs zero times never executes its gate, so a gate inside one cannot be read as a "
		+ "condition the code after the loop inherits");

	const nested = analyze(
		"function M.f(entity, entity_data)",
		"  for _, item in ipairs(entity_data.list) do",
		"    if entity.type == \"entity-ghost\" then return end",
		"    entity.tags = entity_data.tags",
		"  end",
		"end",
	);
	assert.deepEqual(nested.return_dominated.map(row => row.excluded_types), [["entity-ghost"]],
		"inside the same loop body the gate does precede the write on every iteration that reaches it");
});

test("a closure is walked through only when its call site invokes it there", () => {
	const immediate = analyze(
		"function M.f(entity, entity_data)",
		"  if entity.type == \"entity-ghost\" then return end",
		"  safe_call(\"tags\", function() entity.tags = entity_data.tags end)",
		"  local ok = pcall(function() entity.name_tag = entity_data.name_tag end)",
		"end",
	);
	assert.deepEqual(immediate.return_dominated.map(row => row.property).sort(), ["name_tag", "tags"],
		"safe_call and pcall run the closure at that line, so the gates above it govern the write inside");

	const deferred = analyze(
		"function M.f(entity, entity_data)",
		"  if entity.type == \"entity-ghost\" then return end",
		"  script.on_nth_tick(60, function() entity.tags = entity_data.tags end)",
		"end",
	);
	assert.equal(deferred.considered, 1, "the write is still counted");
	assert.deepEqual(deferred.return_dominated, [],
		"a closure handed to anything else may run at another time entirely, so the gates above its "
		+ "construction are not conditions on the write inside it");
});

test("a return inside a closure is the closure's exit, never the function's", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  safe_call(\"probe\", function()",
		"    if entity.type == \"entity-ghost\" then return end",
		"  end)",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.deepEqual(result.return_dominated, [],
		"reading that return as a gate on the outer function would invent an exclusion the engine never has");
});

test("a function containing goto is REFUSED by name, and contributes no writes", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if not entity_data.specific_data then return end",
		"  for _, item in ipairs(entity_data.list) do",
		"    if item.skip then goto continue end",
		"    entity.tags = entity_data.tags",
		"    ::continue::",
		"  end",
		"end",
	);
	assert.deepEqual(result.skipped, [{ file: "synthetic.lua", function: "M.f", line: 1 }]);
	assert.equal(result.considered, 0,
		"a jump can enter the block below a gate without passing it, so statement order stops standing in "
		+ "for control flow — the refusal has to be recorded, because zero findings from a scope the arm "
		+ "never read is otherwise indistinguishable from zero findings in a clean one");
	assert.deepEqual(result.return_dominated, []);
});

test("a goto at CHUNK level refuses the whole file, not just a function inside it", () => {
	const result = analyze(
		"if flag then goto done end",
		"entity.tags = entity_data.tags",
		"::done::",
	);
	assert.deepEqual(result.skipped, [{ file: "synthetic.lua", function: "<chunk>", line: 1 }]);
	assert.equal(result.considered, 0,
		"the per-function refusal never runs for code that sits outside a function, so the chunk needs its "
		+ "own check or a jump at that level is analyzed as if statement order held");
});

test("a bracket write bound by an ipairs literal list is considered, once per literal", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if not entity_data.specific_data then return end",
		"  for _, field in ipairs({ \"alpha\", \"beta\" }) do",
		"    entity[field] = entity_data[field]",
		"  end",
		"  entity[unresolved] = 1",
		"end",
	);
	assert.equal(result.considered, 2, "two literals resolve to two write sites; the unbound index resolves to none");
});

test("a multiple assignment whose counts differ pairs no value, and still counts the site", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  if not entity_data.specific_data then return end",
		"  entity.tags, entity.name_tag = unpack(entity_data.pair)",
		"end",
	);
	assert.equal(result.considered, 2);
	assert.deepEqual(result.return_dominated, [],
		"with no value paired to the target there is no payload key to reason from, so the arm declines");
});

test("a write outside any gate is clean, and a write in a gate-free function is never flagged", () => {
	const result = analyze(
		"function M.f(entity, entity_data)",
		"  entity.tags = entity_data.tags",
		"end",
	);
	assert.equal(result.evaluated, 1);
	assert.deepEqual(result.return_dominated, []);
});

test("a source that does not parse desyncs loudly rather than reporting a clean file", () => {
	assert.throws(() => analyze("function M.f(entity)", "  entity.tags = "), /unexpected|expected/i);
});
