import { createHash } from "node:crypto";

import { BELT_TYPES } from "./fixture-contract.mjs";
import { buildSemanticGraph, nodeKey, ROLE_SIDE } from "./semantic-graph.mjs";

const READ_CEILING = 5_000_000;

const TRANSPORT_LINE_ROLES = {
	"transport-belt": ["left_line", "right_line"],
	"underground-belt": ["left_line", "right_line", "left_underground_line", "right_underground_line"],
	splitter: [
		"left_line", "right_line", "secondary_left_line", "secondary_right_line",
		"left_split_line", "right_split_line", "secondary_left_split_line", "secondary_right_split_line",
	],
};

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

function signature(value) {
	return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function sequence(value) {
	if (Array.isArray(value)) return value;
	if (value && typeof value === "object") return Object.values(value);
	return [];
}

export function constructionDescriptors(payload) {
	return (payload?.entities || []).filter(entity => BELT_TYPES.has(entity.type)).map(entity => ({
		entityId: entity.entity_id,
		name: entity.name,
		type: entity.type,
		position: { x: entity.position.x, y: entity.position.y },
		direction: entity.direction,
		force: entity.force,
		quality: entity.quality,
		undergroundType: entity.specific_data?.belt_to_ground_type,
		expectsPartner: entity.type === "underground-belt" ? entity.specific_data?.has_partner === true : undefined,
		splitterFilter: entity.specific_data?.filter,
		inputPriority: entity.specific_data?.input_priority,
		outputPriority: entity.specific_data?.output_priority,
	})).sort((left, right) => Number(left.entityId) - Number(right.entityId));
}

function comparable(row) {
	return {
		entityId: Number(row.entityId), name: row.name, type: row.type,
		position: row.position, direction: row.direction,
		undergroundType: row.undergroundType,
		expectsPartner: row.expectsPartner,
		splitterFilter: row.splitterFilter, inputPriority: row.inputPriority, outputPriority: row.outputPriority,
	};
}

export function roleForEntityLine(entityType, lineIndex) {
	const role = TRANSPORT_LINE_ROLES[entityType]?.[Number(lineIndex) - 1];
	if (!role) throw new Error(`unsupported transport line ${entityType}:${lineIndex}`);
	return role;
}

export function normalizeObservationRoles(observation) {
	return {
		...observation,
		entities: (observation?.entities || []).map(entity => ({
			...entity,
			lines: (entity.lines || []).map(line => ({
				...line,
				role: roleForEntityLine(entity.type, line.index),
			})),
		})),
	};
}

export function assertExactConstruction(expected, observed) {
	const seen = new Set();
	for (const row of observed) {
		const key = String(row.entityId);
		if (seen.has(key)) throw new Error(`duplicate observed entity ${key}`);
		seen.add(key);
	}
	const expectedRows = expected.map(comparable).sort((a, b) => a.entityId - b.entityId);
	const observedRows = observed.map(comparable).sort((a, b) => a.entityId - b.entityId);
	if (JSON.stringify(expectedRows) !== JSON.stringify(observedRows)) {
		const expectedById = new Map(expectedRows.map(row => [String(row.entityId), row]));
		const observedById = new Map(observedRows.map(row => [String(row.entityId), row]));
		const ids = new Set([...expectedById.keys(), ...observedById.keys()]);
		const changedEntities = [...ids].filter(id => JSON.stringify(expectedById.get(id)) !== JSON.stringify(observedById.get(id))).sort();
		const error = new Error(`construction mismatch: expected ${expectedRows.length}, observed ${observedRows.length}`);
		error.details = { changedEntities, examples: changedEntities.slice(0, 10).map(id => ({ id, expected: expectedById.get(id), observed: observedById.get(id) })) };
		throw error;
	}
	return { entities: observedRows.length };
}

export function assertDeterministicObservations(observations) {
	if (!Array.isArray(observations) || observations.length < 2) throw new Error("at least two observations are required");
	const structural = observations.map(observation => (observation.entities || []).map(entity => {
		const { unitNumber: _unitNumber, ...stable } = entity;
		return stable;
	}).sort((left, right) => String(left.entityId).localeCompare(String(right.entityId))));
	const signatures = structural.map(signature);
	if (new Set(signatures).size !== 1) {
		const entityIds = new Set(structural.flatMap(rows => rows.map(row => String(row.entityId))));
		const changedEntities = [...entityIds].filter(entityId => {
			const rows = structural.map(run => run.find(row => String(row.entityId) === entityId));
			return new Set(rows.map(signature)).size !== 1;
		}).sort();
		const error = new Error(`nondeterministic empty-target graph: ${signatures.join(",")}`);
		error.details = { signatures, changedEntities };
		throw error;
	}
	return { runs: observations.length, signature: signatures[0] };
}

function weakNetworks(entities) {
	const byId = new Map(entities.map(entity => [String(entity.entityId), entity]));
	const undirected = new Map([...byId.keys()].map(key => [key, new Set()]));
	for (const entity of entities) {
		const key = String(entity.entityId);
		for (const neighbour of [...sequence(entity.inputs), ...sequence(entity.outputs), entity.undergroundPartner].filter(Boolean).map(String)) {
			if (!byId.has(neighbour)) continue;
			undirected.get(key).add(neighbour);
			undirected.get(neighbour).add(key);
		}
	}
	const network = new Map();
	for (const start of [...byId.keys()].sort()) {
		if (network.has(start)) continue;
		const members = [];
		const queue = [start];
		network.set(start, "pending");
		for (let index = 0; index < queue.length; index += 1) {
			members.push(queue[index]);
			for (const next of undirected.get(queue[index])) {
				if (network.has(next)) continue;
				network.set(next, "pending");
				queue.push(next);
			}
		}
		const id = members.sort().join(",");
		for (const member of members) network.set(member, id);
	}
	return network;
}

function geometryDistance(from, to) {
	const finish = from?.geometry?.finish;
	const start = to?.geometry?.start;
	if (!finish || !start) return Number.POSITIVE_INFINITY;
	const distance = Math.hypot(Number(finish.x) - Number(start.x), Number(finish.y) - Number(start.y));
	return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

export function buildDupTopology(observation, endpointKeys) {
	const entities = observation?.entities || [];
	const byId = new Map(entities.map(entity => [String(entity.entityId), entity]));
	const networks = weakNetworks(entities);
	const nodes = [];
	const lineNode = new Map();
	for (const entity of entities) {
		for (const line of entity.lines || []) {
			const side = ROLE_SIDE.get(line.role);
			const descriptor = {
				entityId: String(entity.entityId), role: line.role, side,
				entityType: entity.type, networkId: networks.get(String(entity.entityId)),
				splitterFilter: entity.splitterFilter, inputPriority: entity.inputPriority,
				outputPriority: entity.outputPriority, undergroundPartner: entity.undergroundPartner,
				expectsPartner: entity.expectsPartner,
			};
			nodes.push(descriptor);
			lineNode.set(`${entity.entityId}:${line.index}`, { key: nodeKey(descriptor.entityId, line.role), line, entity });
		}
	}
	const transitions = [];
	const transitionReasons = [];
	const addSameSide = (fromEntity, toEntity, kind) => {
		for (const from of fromEntity.lines || []) {
			const candidates = (toEntity.lines || []).filter(to => ROLE_SIDE.get(from.role) === ROLE_SIDE.get(to.role))
				.map(to => ({ to, distance: geometryDistance(from, to) })).sort((left, right) => left.distance - right.distance);
			const fromKey = nodeKey(String(fromEntity.entityId), from.role);
			if (!candidates.length || !Number.isFinite(candidates[0].distance)) {
				transitionReasons.push(`missing geometry transition ${fromKey}->${toEntity.entityId}`);
				continue;
			}
			if (candidates[1] && Math.abs(candidates[1].distance - candidates[0].distance) < 1e-9) {
				transitionReasons.push(`ambiguous transition ${fromKey}->${toEntity.entityId}`);
				continue;
			}
			const { to, distance } = candidates[0];
			transitions.push({
				from: fromKey,
				to: nodeKey(String(toEntity.entityId), to.role), kind,
				geometryAgreement: kind === "underground-forward" || distance <= 1.01,
			});
		}
	};
	for (const entity of entities) {
		for (const outputId of sequence(entity.outputs)) {
			const output = byId.get(String(outputId));
			if (!output) continue;
			const kind = entity.type === "splitter" ? "splitter-forward" : sequence(output.inputs).length > 1 ? "merge-forward" : "forward";
			addSameSide(entity, output, kind);
		}
		if (entity.type === "underground-belt" && entity.undergroundType === "input" && entity.undergroundPartner) {
			const partner = byId.get(String(entity.undergroundPartner));
			if (partner) addSameSide(entity, partner, "underground-forward");
		}
	}
	const graph = buildSemanticGraph({ nodes, transitions, reasons: transitionReasons });
	const knownEndpoints = endpointKeys.map(key => {
		const mapped = lineNode.get(key);
		if (!mapped) throw new Error(`known-loss endpoint is unmapped: ${key}`);
		return { source: key, node: mapped.key, legalRegion: graph.routes[mapped.key] || [] };
	});
	return { graph, knownEndpoints, lineNode };
}

export function maximumLineNodes(payload) {
	const maxima = { "transport-belt": 2, "underground-belt": 4, splitter: 8 };
	return constructionDescriptors(payload).reduce((total, entity) => total + maxima[entity.type], 0);
}

export function projectDetailedContentReads({ observationRuns, maximumLineNodes: nodes }) {
	const reads = Number(observationRuns) * Number(nodes);
	if (!Number.isSafeInteger(reads) || reads > READ_CEILING) throw new Error(`projected detailed-content reads ${reads} exceed ${READ_CEILING}`);
	return reads;
}

export function certifyGeometryControls(observation) {
	const entities = observation?.entities || [];
	const straight = entities.filter(entity => entity.type === "transport-belt" && entity.beltShape === "straight").length;
	const corners = entities.filter(entity => entity.type === "transport-belt" && entity.beltShape !== "straight").length;
	const splitters = entities.filter(entity => entity.type === "splitter").length;
	const underground = entities.filter(entity => entity.type === "underground-belt");
	const undergroundIds = new Set(underground.map(entity => String(entity.entityId)));
	const pairKeys = new Set();
	for (const entity of underground) {
		const partner = String(entity.undergroundPartner || "");
		if (!entity.expectsPartner) {
			if (partner) throw new Error(`unexpected underground geometry partner ${entity.entityId}->${partner}`);
			continue;
		}
		if (!undergroundIds.has(partner)) throw new Error(`inconsistent underground geometry control ${entity.entityId}->${partner || "missing"}`);
		pairKeys.add([String(entity.entityId), partner].sort().join(":"));
	}
	if (!straight) throw new Error("missing straight geometry control");
	if (!corners) throw new Error("missing corner geometry control");
	if (!splitters) throw new Error("missing splitter geometry control");
	if (!pairKeys.size) throw new Error("missing underground geometry control");
	let lines = 0;
	const remapExamples = [];
	let insertRemaps = 0;
	for (const entity of entities) for (const line of entity.lines || []) {
		lines += 1;
		const geometry = line.geometry;
		const numbers = [geometry?.lineLength, geometry?.start?.x, geometry?.start?.y, geometry?.finish?.x, geometry?.finish?.y,
			geometry?.startInsert?.position, geometry?.finishInsert?.position];
		if (numbers.some(value => !Number.isFinite(Number(value)))) throw new Error(`invalid line geometry ${entity.entityId}:${line.index}`);
		if (Number(geometry.startInsert.line) !== Number(line.index) || Number(geometry.finishInsert.line) !== Number(line.index)) {
			insertRemaps += 1;
			if (remapExamples.length < 10) remapExamples.push({
				entityId: String(entity.entityId), line: Number(line.index),
				startInsertLine: Number(geometry.startInsert.line), finishInsertLine: Number(geometry.finishInsert.line),
			});
		}
	}
	return { corners, splitters, straight, undergroundPairs: pairKeys.size, lines, insertRemaps, remapExamples };
}

export { READ_CEILING };
