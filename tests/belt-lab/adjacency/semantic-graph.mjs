import { createHash } from "node:crypto";

const ROLE_SIDE = new Map([
	["left_line", "left"],
	["left_underground_line", "left"],
	["secondary_left_line", "left"],
	["left_split_line", "left"],
	["secondary_left_split_line", "left"],
	["right_line", "right"],
	["right_underground_line", "right"],
	["secondary_right_line", "right"],
	["right_split_line", "right"],
	["secondary_right_split_line", "right"],
]);

const ALLOWED_TRANSITIONS = new Set(["forward", "merge-forward", "splitter-forward", "underground-forward", "internal-forward"]);

export function nodeKey(entityId, role) {
	return `${entityId}:${role}`;
}

function configuredSplitterReason(node) {
	if (node.entityType !== "splitter") return null;
	if (node.splitterFilter != null || (node.inputPriority ?? "none") !== "none" || (node.outputPriority ?? "none") !== "none") {
		return `configured splitter ${node.entityId}`;
	}
	return null;
}

function sortedObjectOfSets(value) {
	return Object.fromEntries([...value.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, rows]) => [key, [...rows].sort()]));
}

function reachable(start, adjacency) {
	const seen = new Set([start]);
	const queue = [start];
	for (let index = 0; index < queue.length; index += 1) {
		for (const next of adjacency.get(queue[index]) || []) {
			if (seen.has(next)) continue;
			seen.add(next);
			queue.push(next);
		}
	}
	return [...seen].sort();
}

export function buildSemanticGraph(input) {
	const reasons = [];
	const nodes = [];
	const byKey = new Map();
	for (const descriptor of input?.nodes || []) {
		const key = nodeKey(descriptor.entityId, descriptor.role);
		if (byKey.has(key)) {
			reasons.push(`duplicate node ${key}`);
			continue;
		}
		const expectedSide = ROLE_SIDE.get(descriptor.role);
		if (!expectedSide) reasons.push(`unknown role ${descriptor.role} on ${descriptor.entityId}`);
		else if (descriptor.side !== expectedSide) reasons.push(`role ${descriptor.role} must be ${expectedSide}, got ${descriptor.side}`);
		const node = { ...descriptor, key };
		nodes.push(node);
		byKey.set(key, node);
	}

	const unsupported = new Map();
	for (const node of nodes) {
		const reason = configuredSplitterReason(node);
		if (!reason) continue;
		const rows = unsupported.get(node.networkId) || new Set();
		rows.add(reason);
		unsupported.set(node.networkId, rows);
	}

	const undergroundByEntity = new Map();
	for (const node of nodes.filter(row => row.entityType === "underground-belt")) {
		if (!undergroundByEntity.has(String(node.entityId))) undergroundByEntity.set(String(node.entityId), node);
	}
	for (const node of undergroundByEntity.values()) {
		const partner = undergroundByEntity.get(String(node.undergroundPartner));
		if (!partner || String(partner.undergroundPartner) !== String(node.entityId)) {
			reasons.push(`inconsistent underground pair ${node.entityId}->${node.undergroundPartner ?? "missing"}`);
		}
	}

	const edges = [];
	const adjacency = new Map(nodes.map(node => [node.key, new Set()]));
	for (const transition of input?.transitions || []) {
		const from = byKey.get(transition.from);
		const to = byKey.get(transition.to);
		if (!from || !to) {
			reasons.push(`transition endpoint missing ${transition.from}>${transition.to}`);
			continue;
		}
		if (!ALLOWED_TRANSITIONS.has(transition.kind)) {
			reasons.push(`${transition.kind === "reverse" ? "reverse transition" : "unknown transition kind"} ${transition.from}>${transition.to}`);
			continue;
		}
		if (from.side !== to.side) {
			reasons.push(`transition crosses side ${transition.from}>${transition.to}`);
			continue;
		}
		if (from.networkId !== to.networkId) {
			reasons.push(`transition crosses network ${transition.from}>${transition.to}`);
			continue;
		}
		if (transition.geometryAgreement !== true) {
			reasons.push(`geometry disagreement ${transition.from}>${transition.to}`);
			continue;
		}
		if (unsupported.has(from.networkId)) continue;
		const edge = { from: transition.from, to: transition.to, kind: transition.kind };
		edges.push(edge);
		adjacency.get(edge.from).add(edge.to);
	}

	const routes = {};
	for (const node of nodes) {
		routes[node.key] = unsupported.has(node.networkId) || reasons.length > 0
			? []
			: reachable(node.key, adjacency);
	}
	const unsupportedNetworks = sortedObjectOfSets(unsupported);
	const signatureRows = [
		...nodes.map(node => `N|${node.key}|${node.entityType}|${node.side}|${node.networkId}`).sort(),
		...edges.map(edge => `E|${edge.from}>${edge.to}|${edge.kind}`).sort(),
		...Object.entries(unsupportedNetworks).flatMap(([network, rows]) => rows.map(reason => `U|${network}|${reason}`)).sort(),
		...reasons.map(reason => `R|${reason}`).sort(),
	];
	return {
		supported: reasons.length === 0 && unsupported.size === 0,
		reasons: [...reasons].sort(),
		unsupportedNetworks,
		nodes: [...nodes].sort((left, right) => left.key.localeCompare(right.key)),
		edges: edges.sort((left, right) => `${left.from}>${left.to}`.localeCompare(`${right.from}>${right.to}`)),
		routes,
		signature: createHash("sha256").update(signatureRows.join("\n")).digest("hex"),
	};
}

export function legalRegion(graph, sourceNodeKey) {
	return [...(graph?.routes?.[sourceNodeKey] || [])].sort();
}

export { ROLE_SIDE };
