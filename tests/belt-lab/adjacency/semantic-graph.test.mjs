import assert from "node:assert/strict";
import test from "node:test";

import { buildSemanticGraph, legalRegion, nodeKey } from "./semantic-graph.mjs";

function node(entityId, role, side, networkId = "n1", extra = {}) {
	return { entityId, entityType: "transport-belt", role, side, networkId, ...extra };
}

test("node identity is stable source entity plus named semantic role", () => {
	assert.equal(nodeKey(65243, "left_line"), "65243:left_line");
});

test("merge reaches shared downstream without reaching the sibling input", () => {
	const nodes = [
		node("in-a", "left_line", "left", "merge", { routeClass: "merge-input-a" }),
		node("in-b", "left_line", "left", "merge", { routeClass: "merge-input-b" }),
		node("merge", "left_line", "left", "merge", { routeClass: "merge-shared" }),
		node("out", "left_line", "left", "merge", { routeClass: "forward" }),
	];
	const transitions = [
		{ from: "in-a:left_line", to: "merge:left_line", kind: "merge-forward", geometryAgreement: true },
		{ from: "in-b:left_line", to: "merge:left_line", kind: "merge-forward", geometryAgreement: true },
		{ from: "merge:left_line", to: "out:left_line", kind: "forward", geometryAgreement: true },
	];
	const graph = buildSemanticGraph({ nodes, transitions });
	assert.equal(graph.supported, true);
	assert.deepEqual(legalRegion(graph, "in-a:left_line"), ["in-a:left_line", "merge:left_line", "out:left_line"]);
	assert.equal(legalRegion(graph, "in-a:left_line").includes("in-b:left_line"), false);
});

test("unconfigured splitter permits both forward outputs on the same side", () => {
	const nodes = [
		node("input", "left_line", "left", "split"),
		node("split", "left_line", "left", "split", { entityType: "splitter", splitterFilter: null, inputPriority: "none", outputPriority: "none" }),
		node("out-a", "left_line", "left", "split"),
		node("out-b", "left_line", "left", "split"),
	];
	const transitions = [
		{ from: "input:left_line", to: "split:left_line", kind: "forward", geometryAgreement: true },
		{ from: "split:left_line", to: "out-a:left_line", kind: "splitter-forward", geometryAgreement: true },
		{ from: "split:left_line", to: "out-b:left_line", kind: "splitter-forward", geometryAgreement: true },
	];
	const graph = buildSemanticGraph({ nodes, transitions });
	assert.deepEqual(legalRegion(graph, "input:left_line"), ["input:left_line", "out-a:left_line", "out-b:left_line", "split:left_line"]);
});

test("configured splitter rejects its entire weak network before edges become usable", () => {
	const nodes = [
		node("input", "left_line", "left", "configured"),
		node("split", "left_line", "left", "configured", { entityType: "splitter", splitterFilter: "iron-plate", inputPriority: "none", outputPriority: "none" }),
		node("other", "left_line", "left", "safe"),
	];
	const graph = buildSemanticGraph({
		nodes,
		transitions: [{ from: "input:left_line", to: "split:left_line", kind: "forward", geometryAgreement: true }],
	});
	assert.equal(graph.supported, false);
	assert.deepEqual(graph.unsupportedNetworks, { configured: ["configured splitter split"] });
	assert.deepEqual(legalRegion(graph, "input:left_line"), []);
	assert.deepEqual(legalRegion(graph, "other:left_line"), ["other:left_line"]);
});

test("unknown roles, cross-side edges, and geometry disagreement fail closed", () => {
	const base = [node("a", "left_line", "left"), node("b", "left_line", "left")];
	const unknown = buildSemanticGraph({ nodes: [node("a", "mystery", "left")], transitions: [] });
	assert.match(unknown.reasons.join("\n"), /unknown role/);
	assert.deepEqual(legalRegion(unknown, "a:mystery"), []);
	assert.match(buildSemanticGraph({ nodes: [base[0], node("b", "right_line", "right")], transitions: [{ from: "a:left_line", to: "b:right_line", kind: "forward", geometryAgreement: true }] }).reasons.join("\n"), /crosses side/);
	assert.match(buildSemanticGraph({ nodes: base, transitions: [{ from: "a:left_line", to: "b:left_line", kind: "forward", geometryAgreement: false }] }).reasons.join("\n"), /geometry disagreement/);
});

test("inconsistent underground pairs and explicit reverse transitions fail closed", () => {
	const nodes = [
		node("u-in", "left_underground_line", "left", "u", { entityType: "underground-belt", expectsPartner: true, undergroundPartner: "u-out" }),
		node("u-out", "left_underground_line", "left", "u", { entityType: "underground-belt", expectsPartner: true, undergroundPartner: "wrong" }),
	];
	assert.match(buildSemanticGraph({ nodes, transitions: [] }).reasons.join("\n"), /underground pair/);
	assert.match(buildSemanticGraph({ nodes: [node("a", "left_line", "left"), node("b", "left_line", "left")], transitions: [{ from: "a:left_line", to: "b:left_line", kind: "reverse", geometryAgreement: true }] }).reasons.join("\n"), /reverse transition/);
});

test("a source-declared unpaired underground dead end is consistent", () => {
	const graph = buildSemanticGraph({
		nodes: [node("u", "left_underground_line", "left", "u", { entityType: "underground-belt", expectsPartner: false })],
		transitions: [],
	});
	assert.equal(graph.supported, true);
});

test("canonical signature is independent of input ordering", () => {
	const nodes = [node("a", "left_line", "left"), node("b", "left_line", "left")];
	const transitions = [{ from: "a:left_line", to: "b:left_line", kind: "forward", geometryAgreement: true }];
	const first = buildSemanticGraph({ nodes, transitions });
	const second = buildSemanticGraph({ nodes: [...nodes].reverse(), transitions: [...transitions].reverse() });
	assert.equal(first.signature, second.signature);
});
