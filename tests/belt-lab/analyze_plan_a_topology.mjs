#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";

const [populatedPath, clearedPath, payloadPath, blackBoxPath] = process.argv.slice(2);
if (!blackBoxPath) {
	throw new Error("usage: node analyze_plan_a_topology.mjs <populated.json> <cleared.json> <payload.json> <black-box.json>");
}

const populated = JSON.parse(fs.readFileSync(populatedPath, "utf8"));
const cleared = JSON.parse(fs.readFileSync(clearedPath, "utf8"));
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
const blackBox = JSON.parse(fs.readFileSync(blackBoxPath, "utf8"));

const beltTypes = new Set(["transport-belt", "underground-belt", "splitter", "linked-belt", "loader", "loader-1x1"]);
const payloadBelts = payload.entities.filter(entity => beltTypes.has(entity.type));

function entityJoinKey(entity) {
	return [
		entity.entity_name ?? entity.name,
		entity.entity_type ?? entity.type,
		Number(entity.position.x),
		Number(entity.position.y),
		Number(entity.direction || 0),
	].join("|");
}

const payloadByJoin = new Map();
for (const entity of payloadBelts) {
	const key = entityJoinKey(entity);
	const rows = payloadByJoin.get(key) || [];
	rows.push(entity);
	payloadByJoin.set(key, rows);
}

function list(value) {
	return Array.isArray(value) ? value : [];
}

function canonicalizeGraph(graph) {
	const nodes = new Map();
	const runtimeToCanonical = new Map();
	const joinFailures = [];
	for (const node of graph.nodes) {
		const matches = payloadByJoin.get(entityJoinKey(node)) || [];
		if (matches.length !== 1) {
			joinFailures.push({runtime: node.key, join: entityJoinKey(node), matches: matches.length});
			continue;
		}
		const canonical = `${matches[0].entity_id}:${node.line_index}`;
		runtimeToCanonical.set(node.key, canonical);
		if (nodes.has(canonical)) throw new Error(`duplicate canonical node ${canonical}`);
		nodes.set(canonical, node);
	}

	const components = new Map();
	for (const component of graph.components) {
		const canonicalNodes = list(component.nodes).map(key => runtimeToCanonical.get(key)).filter(Boolean).sort();
		components.set(component.id, {
			id: component.id,
			nodes: canonicalNodes,
			signature: canonicalNodes.join(","),
			ambiguous: false,
			ambiguousNodes: [],
			types: new Set(),
		});
	}
	const edges = [];
	const ambiguousLinks = [];

	for (const [canonical, node] of nodes) {
		const component = components.get(node.component);
		component.types.add(node.entity_type);
		const links = [
			...list(node.inputs).map(link => ({...link, direction: "input"})),
			...list(node.outputs).map(link => ({...link, direction: "output"})),
		];
		let nodeAmbiguous = false;
		for (const link of links) {
			const matches = list(link.matches);
			const runtimeTarget = link.owner_unit != null && matches.length === 1 ? `${link.owner_unit}:${matches[0]}` : null;
			const canonicalTarget = runtimeTarget ? runtimeToCanonical.get(runtimeTarget) : null;
			if (!canonicalTarget) {
				nodeAmbiguous = true;
				ambiguousLinks.push({
					source: canonical,
					direction: link.direction,
					ownerUnit: link.owner_unit ?? null,
					matches,
					candidateTargets: link.owner_unit == null ? [] : matches.map(line => runtimeToCanonical.get(`${link.owner_unit}:${line}`) || null),
				});
			}
			else edges.push(`${canonical}|${link.direction}|${canonicalTarget}`);
		}
		if (nodeAmbiguous) {
			component.ambiguous = true;
			component.ambiguousNodes.push(canonical);
		}
	}
	edges.sort();

	return {nodes, components, joinFailures, edges, ambiguousLinks};
}

const pop = canonicalizeGraph(populated);
const emp = canonicalizeGraph(cleared);

const popSignatureByNode = new Map();
const clearedSignatureByNode = new Map();
for (const [canonical, node] of pop.nodes) popSignatureByNode.set(canonical, pop.components.get(node.component).signature);
for (const [canonical, node] of emp.nodes) clearedSignatureByNode.set(canonical, emp.components.get(node.component).signature);

const allCanonical = new Set([...pop.nodes.keys(), ...emp.nodes.keys()]);
const globalMismatches = [];
for (const canonical of allCanonical) {
	const sourceSignature = popSignatureByNode.get(canonical);
	const targetSignature = clearedSignatureByNode.get(canonical);
	if (!sourceSignature || !targetSignature || sourceSignature !== targetSignature) {
		globalMismatches.push({canonical, sourceSignature, targetSignature});
	}
}

function hashRows(rows) {
	return crypto.createHash("sha256").update(rows.join("\n")).digest("hex");
}

function hashObjects(rows) {
	return hashRows(rows.map(row => JSON.stringify(row)));
}

const populatedEdgeHash = hashRows(pop.edges);
const clearedEdgeHash = hashRows(emp.edges);
const edgeMultisetMatch = pop.edges.length === emp.edges.length && populatedEdgeHash === clearedEdgeHash;

// Exact compressed-loss endpoints established by the DUP-233855 black-box forensic rung:
// metallic-asteroid-chunk -4 at 65243:1, explosive-rocket -8 at 65243:2,
// and explosive-rocket -20 at 65907:2. Their adjacent positive rows explain the
// displacement; these exact negative endpoints anchor eligibility without sweeping
// unrelated same-item movement elsewhere on the platform.
const endpointExpectations = new Map([
	["65243:1", {name: "metallic-asteroid-chunk", delta: -4}],
	["65243:2", {name: "explosive-rocket", delta: -8}],
	["65907:2", {name: "explosive-rocket", delta: -20}],
]);
const blackBoxRows = new Map(blackBox.restore_time_belt_lines.rows.map(row => [`${row.entity_id}:${row.line_index}`, row]));
for (const [canonical, expected] of endpointExpectations) {
	const row = blackBoxRows.get(canonical);
	if (!row || Number(row.delta?.[expected.name]) !== expected.delta) {
		throw new Error(`black-box endpoint ${canonical} did not have ${expected.name} delta ${expected.delta}`);
	}
}
const knownChain = new Set(endpointExpectations.keys());

const knownResults = [];
const knownComponentSignatures = new Set();
for (const canonical of [...knownChain].sort()) {
	const popNode = pop.nodes.get(canonical);
	const clearedNode = emp.nodes.get(canonical);
	const popComponent = popNode ? pop.components.get(popNode.component) : null;
	const clearedComponent = clearedNode ? emp.components.get(clearedNode.component) : null;
	const signatureMatch = Boolean(popComponent && clearedComponent && popComponent.signature === clearedComponent.signature);
	if (popComponent) knownComponentSignatures.add(popComponent.signature);
	knownResults.push({
		canonical,
		presentPopulated: Boolean(popNode),
		presentCleared: Boolean(clearedNode),
		signatureMatch,
		populatedAmbiguous: popComponent?.ambiguous ?? true,
		clearedAmbiguous: clearedComponent?.ambiguous ?? true,
		componentTypes: popComponent ? [...popComponent.types].sort() : [],
	});
}

const knownFailures = knownResults.filter(row => !row.presentPopulated || !row.presentCleared || !row.signatureMatch || row.populatedAmbiguous || row.clearedAmbiguous);
const knownComponents = [...knownComponentSignatures].map(signature => {
	const component = [...pop.components.values()].find(row => row.signature === signature);
	return {
		nodes: component.nodes.length,
		ambiguous: component.ambiguous,
		ambiguousNodes: component.ambiguousNodes,
		types: [...component.types].sort(),
	};
});

function serializedLines(entity) {
	return Array.isArray(entity.specific_data?.items) ? entity.specific_data.items : [];
}

const payloadSlots = payloadBelts.reduce((total, entity) => total + serializedLines(entity).reduce((lineTotal, line) => lineTotal + (Array.isArray(line.items) ? line.items.length : 0), 0), 0);
const payloadQuantity = payloadBelts.reduce((total, entity) => total + serializedLines(entity).reduce((lineTotal, line) => lineTotal + (Array.isArray(line.items) ? line.items : []).reduce((itemTotal, item) => itemTotal + Number(item.count || 0), 0), 0), 0);

const report = {
	version: populated.version,
	payload: {beltEntities: payloadBelts.length, serializedSlots: payloadSlots, serializedQuantity: payloadQuantity},
	populated: {
		nodes: pop.nodes.size,
		components: pop.components.size,
		joinFailureCount: pop.joinFailures.length,
		joinFailureExamples: pop.joinFailures.slice(0, 10),
		ambiguousComponents: [...pop.components.values()].filter(row => row.ambiguous).length,
		ambiguousLinkCount: pop.ambiguousLinks.length,
		ambiguousLinksSha256: hashObjects(pop.ambiguousLinks),
		ambiguousLinks: pop.ambiguousLinks,
		ownership: populated.ownership,
	},
	cleared: {
		nodes: emp.nodes.size,
		components: emp.components.size,
		joinFailureCount: emp.joinFailures.length,
		joinFailureExamples: emp.joinFailures.slice(0, 10),
		ambiguousComponents: [...emp.components.values()].filter(row => row.ambiguous).length,
		ambiguousLinkCount: emp.ambiguousLinks.length,
		ambiguousLinksSha256: hashObjects(emp.ambiguousLinks),
	},
	globalSignatureMismatches: globalMismatches.length,
	directedEdges: {
		populated: pop.edges.length,
		cleared: emp.edges.length,
		populatedSha256: populatedEdgeHash,
		clearedSha256: clearedEdgeHash,
		multisetMatch: edgeMultisetMatch,
	},
	knownChain: {
		nodes: knownChain.size,
		components: knownComponents,
		failureCount: knownFailures.length,
		failureExamples: knownFailures.slice(0, 10),
		oneToOneEligible: knownFailures.length === 0,
	},
};

console.log(JSON.stringify(report, null, 2));
if (pop.joinFailures.length || emp.joinFailures.length || globalMismatches.length || !edgeMultisetMatch || knownFailures.length) process.exitCode = 1;
