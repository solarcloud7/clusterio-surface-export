/**
 * Projecting gateway link config into a node graph, and edits back out of it.
 *
 * Lives in shared/ (rather than beside its only caller in web/) so it is reachable from dist/node
 * and therefore testable: tsconfig.node.json excludes web/** but includes shared/**, and the web
 * bundle is never built into dist/node. Same reason as shared/planets.ts. Everything here is pure —
 * no React, no @xyflow import — so the one part of the canvas that has decisions in it is covered by
 * test/gateway-graph.test.cjs, in a repo with no React test harness.
 *
 * THE MODEL IS THE EDITS MAP. `GatewayEdits` is keyed exactly as the controller keys its own config
 * (`${sourceInstanceId}:${gatewayName}` -> that gateway's whole target list), so a save is one
 * setGatewayLink call per changed key with no translation. Edges are a PROJECTION of that map, never
 * a second source of truth — which is why there is nothing to reconcile between what is drawn and
 * what will be saved.
 */

import type { GatewayLink } from "./dto";
import { GATEWAY_NAMES } from "./dto";

// ── Structural inputs ───────────────────────────────────────────────────────
// Declared structurally rather than imported from the DTO so a test can build one without inventing
// platform arrays it does not exercise. These are subsets of InstanceNodeModel / HostNodeModel.

export type InstanceLike = {
	instanceId: number;
	instanceName: string;
	gamePort?: number | null;
	status?: string;
	connected?: boolean;
};

export type HostLike = {
	hostId: number;
	hostName: string;
	connected?: boolean;
	instances?: InstanceLike[];
};

export type TreeLike = {
	hosts?: HostLike[];
	unassignedInstances?: InstanceLike[];
};

/** Staged config: `${sourceInstanceId}:${gatewayName}` -> that gateway's complete target list. */
export type GatewayEdits = Record<string, GatewayLink[]>;

/** The shape `GetGatewaysRequest` answers with. */
export type RawGatewayLinkRow = {
	sourceInstanceId: number;
	gatewayName: string;
	targets?: GatewayLink[];
};

// ── Identity ────────────────────────────────────────────────────────────────
// Every id here is parsed somewhere, so each has a matching reader. Gateway names never contain ":"
// (they are `surfexp_gateway_<n>`), which is what makes the first-colon split unambiguous.

export function editKey(sourceInstanceId: number, gatewayName: string): string {
	return `${sourceInstanceId}:${gatewayName}`;
}

export function parseEditKey(key: string): { sourceInstanceId: number; gatewayName: string } | null {
	const split = key.indexOf(":");
	if (split <= 0) {
		return null;
	}
	const sourceInstanceId = Number(key.slice(0, split));
	const gatewayName = key.slice(split + 1);
	if (!Number.isFinite(sourceInstanceId) || !gatewayName) {
		return null;
	}
	return { sourceInstanceId, gatewayName };
}

export function instanceNodeId(instanceId: number): string {
	return `instance:${instanceId}`;
}

export function instanceIdFromNodeId(nodeId: string | null | undefined): number | null {
	if (!nodeId || !nodeId.startsWith("instance:")) {
		return null;
	}
	const id = Number(nodeId.slice("instance:".length));
	return Number.isFinite(id) ? id : null;
}

export const UNASSIGNED_HOST_KEY = "unassigned";

export function hostNodeId(hostKey: number | string): string {
	return `host:${hostKey}`;
}

/**
 * A gateway needs BOTH handles: links are directional, and the same gateway can be an origin for one
 * link and a destination for another. React Flow only starts a connection from a source handle and
 * only completes it on a target handle, so the two are never ambiguous despite sharing a position.
 */
export function sourceHandleId(gatewayName: string): string {
	return `s:${gatewayName}`;
}

export function targetHandleId(gatewayName: string): string {
	return `t:${gatewayName}`;
}

export function gatewayFromHandleId(handleId: string | null | undefined): string | null {
	if (!handleId || handleId.length < 3) {
		return null;
	}
	const prefix = handleId.slice(0, 2);
	if (prefix !== "s:" && prefix !== "t:") {
		return null;
	}
	return handleId.slice(2);
}

// ── Edges ───────────────────────────────────────────────────────────────────

/**
 * One rendered edge per unordered endpoint PAIR, carrying which directions actually exist.
 *
 * Why not one edge per stored link: the owner's ruling is that drawing an edge creates the return
 * link too, so the common case is two stored links that must read as one line. But the controller's
 * config can already hold a ONE-WAY link, and an edge model that could only say "connected" would
 * render that as symmetric — and the next save would then quietly create the return link nobody
 * asked for. So direction is carried explicitly and drawn as arrowheads.
 */
export interface GatewayEdgeModel {
	id: string;
	/** Node/handle ids for the canonical (low) end. */
	source: string;
	sourceHandle: string;
	/** Node/handle ids for the canonical (high) end. */
	target: string;
	targetHandle: string;
	sourceInstanceId: number;
	sourceGateway: string;
	targetInstanceId: number;
	targetGateway: string;
	/** A link exists from the canonical source end to the canonical target end. */
	forward: boolean;
	/** A link exists in the opposite direction. */
	reverse: boolean;
}

type Endpoint = { instanceId: number; gatewayName: string };

function endpointKey(endpoint: Endpoint): string {
	return `${endpoint.instanceId}/${endpoint.gatewayName}`;
}

/**
 * Canonical orientation for a pair, so the same two endpoints always yield the same edge id no
 * matter which direction was stored first. Lexicographic on the endpoint key: it only has to be a
 * stable total order, not a meaningful one.
 */
function orient(a: Endpoint, b: Endpoint): { low: Endpoint; high: Endpoint; flipped: boolean } {
	const flipped = endpointKey(a) > endpointKey(b);
	return flipped ? { low: b, high: a, flipped } : { low: a, high: b, flipped };
}

export function edgeId(a: Endpoint, b: Endpoint): string {
	const { low, high } = orient(a, b);
	return `link:${endpointKey(low)}|${endpointKey(high)}`;
}

/** Every stored link as a flat directed list. Skips malformed keys rather than throwing. */
function directedLinks(edits: GatewayEdits): Array<{ from: Endpoint; to: Endpoint }> {
	const out: Array<{ from: Endpoint; to: Endpoint }> = [];
	for (const [key, targets] of Object.entries(edits)) {
		const parsed = parseEditKey(key);
		if (!parsed) {
			continue;
		}
		for (const target of targets || []) {
			if (target == null || !Number.isFinite(target.targetInstanceId)) {
				continue;
			}
			out.push({
				from: { instanceId: parsed.sourceInstanceId, gatewayName: parsed.gatewayName },
				to: { instanceId: target.targetInstanceId, gatewayName: target.targetGateway || parsed.gatewayName },
			});
		}
	}
	return out;
}

export function buildEdges(edits: GatewayEdits): GatewayEdgeModel[] {
	const byPair = new Map<string, GatewayEdgeModel>();
	for (const link of directedLinks(edits)) {
		const { low, high, flipped } = orient(link.from, link.to);
		const id = edgeId(low, high);
		let edge = byPair.get(id);
		if (!edge) {
			edge = {
				id,
				source: instanceNodeId(low.instanceId),
				sourceHandle: sourceHandleId(low.gatewayName),
				target: instanceNodeId(high.instanceId),
				targetHandle: targetHandleId(high.gatewayName),
				sourceInstanceId: low.instanceId,
				sourceGateway: low.gatewayName,
				targetInstanceId: high.instanceId,
				targetGateway: high.gatewayName,
				forward: false,
				reverse: false,
			};
			byPair.set(id, edge);
		}
		// `flipped` means the stored link ran high -> low, i.e. against the canonical orientation.
		if (flipped) {
			edge.reverse = true;
		} else {
			edge.forward = true;
		}
	}
	return [...byPair.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ── Per-gateway usage, for the handle affordance ────────────────────────────

export type GatewayUsage = { outgoing: number; incoming: number };

/**
 * How many links leave and arrive at each gateway of each instance.
 *
 * A gateway with zero OUTGOING links is disabled — a platform parked there cannot go anywhere. The
 * form UI said so in words ("No targets — this gateway is disabled"); on a canvas that has to be an
 * affordance or the silent-disable hazard comes back wearing a new hat. Incoming is reported
 * separately because an arrival-only gateway is not dead, just not a departure point.
 */
export function gatewayUsage(edits: GatewayEdits): Map<number, Map<string, GatewayUsage>> {
	const usage = new Map<number, Map<string, GatewayUsage>>();
	const bump = (instanceId: number, gatewayName: string, field: keyof GatewayUsage) => {
		let perInstance = usage.get(instanceId);
		if (!perInstance) {
			perInstance = new Map();
			usage.set(instanceId, perInstance);
		}
		const entry = perInstance.get(gatewayName) || { outgoing: 0, incoming: 0 };
		entry[field] += 1;
		perInstance.set(gatewayName, entry);
	};
	for (const link of directedLinks(edits)) {
		bump(link.from.instanceId, link.from.gatewayName, "outgoing");
		bump(link.to.instanceId, link.to.gatewayName, "incoming");
	}
	return usage;
}

// ── Editing ─────────────────────────────────────────────────────────────────

export type ConnectRequest = {
	sourceInstanceId: number;
	sourceGateway: string;
	targetInstanceId: number;
	targetGateway: string;
};

function withTarget(targets: GatewayLink[], add: GatewayLink): GatewayLink[] {
	const exists = targets.some(t => t.targetInstanceId === add.targetInstanceId && t.targetGateway === add.targetGateway);
	return exists ? targets : [...targets, add];
}

function withoutTarget(targets: GatewayLink[], drop: GatewayLink): GatewayLink[] {
	return targets.filter(t => !(t.targetInstanceId === drop.targetInstanceId && t.targetGateway === drop.targetGateway));
}

/**
 * Stage a new link, in BOTH directions (owner ruling: a drawn edge is a two-way portal).
 *
 * Returns the edits unchanged when the request is not a legal link, rather than staging something
 * the controller would reject: an instance cannot gateway to itself (the form UI enforced the same
 * rule by excluding the source from its destination options).
 */
export function applyConnect(edits: GatewayEdits, request: ConnectRequest): GatewayEdits {
	const { sourceInstanceId, sourceGateway, targetInstanceId, targetGateway } = request;
	if (sourceInstanceId === targetInstanceId) {
		return edits;
	}
	if (!sourceGateway || !targetGateway) {
		return edits;
	}
	const forwardKey = editKey(sourceInstanceId, sourceGateway);
	const reverseKey = editKey(targetInstanceId, targetGateway);
	return {
		...edits,
		[forwardKey]: withTarget(edits[forwardKey] || [], { targetInstanceId, targetGateway }),
		[reverseKey]: withTarget(edits[reverseKey] || [], {
			targetInstanceId: sourceInstanceId,
			targetGateway: sourceGateway,
		}),
	};
}

/** Remove a link in both directions. Symmetric with applyConnect, including on a one-way link. */
export function applyDisconnect(edits: GatewayEdits, request: ConnectRequest): GatewayEdits {
	const { sourceInstanceId, sourceGateway, targetInstanceId, targetGateway } = request;
	const forwardKey = editKey(sourceInstanceId, sourceGateway);
	const reverseKey = editKey(targetInstanceId, targetGateway);
	return {
		...edits,
		[forwardKey]: withoutTarget(edits[forwardKey] || [], { targetInstanceId, targetGateway }),
		[reverseKey]: withoutTarget(edits[reverseKey] || [], {
			targetInstanceId: sourceInstanceId,
			targetGateway: sourceGateway,
		}),
	};
}

/** Normalise the GetGateways response into the edits shape. */
export function editsFromLinks(links: RawGatewayLinkRow[] | null | undefined): GatewayEdits {
	const edits: GatewayEdits = {};
	for (const row of links || []) {
		if (!row || !Number.isFinite(row.sourceInstanceId) || !row.gatewayName) {
			continue;
		}
		edits[editKey(row.sourceInstanceId, row.gatewayName)] = (row.targets || []).map(t => ({
			targetInstanceId: t.targetInstanceId,
			targetGateway: t.targetGateway || row.gatewayName,
		}));
	}
	return edits;
}

function sameTargets(a: GatewayLink[], b: GatewayLink[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	// Order-insensitive: the controller stores a list, but two lists holding the same links are the
	// same config, and staging order is an artefact of which edge the user drew first.
	const encode = (list: GatewayLink[]) => list.map(t => `${t.targetInstanceId}/${t.targetGateway}`).sort();
	const left = encode(a);
	const right = encode(b);
	return left.every((value, index) => value === right[index]);
}

/**
 * Keys whose target list differs from the loaded baseline — one setGatewayLink call each.
 *
 * Includes keys present in only one side, so both "gateway gained its first target" and "gateway
 * cleared to empty" are saved. An empty list is a meaningful value (it disables the gateway), not an
 * absence, which is why a missing key is compared against [] rather than skipped.
 */
export function dirtyKeys(edits: GatewayEdits, baseline: GatewayEdits): string[] {
	const keys = new Set([...Object.keys(edits), ...Object.keys(baseline)]);
	const dirty: string[] = [];
	for (const key of keys) {
		if (!sameTargets(edits[key] || [], baseline[key] || [])) {
			dirty.push(key);
		}
	}
	return dirty.sort();
}

// ── Layout ──────────────────────────────────────────────────────────────────

export const NODE_DIAMETER = 150;
/** Room inside a host box: symmetric sides/bottom, extra on top for the host's own label. */
export const GROUP_PADDING = 48;
export const GROUP_LABEL_SPACE = 40;
/** Gap between stacked instances inside one host, and between host boxes. */
export const INSTANCE_GAP = 70;
export const GROUP_GAP = 90;

export interface GraphNodeModel {
	id: string;
	type: "group" | "instance";
	position: { x: number; y: number };
	data: Record<string, unknown>;
	parentId?: string;
	extent?: "parent";
	style?: Record<string, number | string>;
	draggable?: boolean;
	selectable?: boolean;
	connectable?: boolean;
}

function isOnline(instance: InstanceLike): boolean {
	// Must keep matching the controller's isInstanceOnline (connected AND running), or the canvas
	// disagrees with the config it pushes. Moved from GatewaysTab, not re-derived.
	return Boolean(instance.connected) && instance.status === "running";
}

/**
 * Hosts as columns, their instances stacked inside.
 *
 * Deterministic rather than force-directed: this graph is small (one instance per host on the dev
 * cluster) and a stable layout means a node is where the operator last saw it. Sorting mirrors the
 * old tab's ordering so the canvas does not silently reshuffle relative to the list it replaces.
 */
export function buildGraph(tree: TreeLike | null | undefined, edits: GatewayEdits): {
	nodes: GraphNodeModel[];
	edges: GatewayEdgeModel[];
} {
	const groups: Array<{ key: string; name: string; connected: boolean; instances: InstanceLike[] }> = [];

	for (const host of [...(tree?.hosts || [])].sort((a, b) => String(a.hostName || "").localeCompare(String(b.hostName || "")))) {
		groups.push({
			key: String(host.hostId),
			name: host.hostName,
			connected: Boolean(host.connected),
			instances: [...(host.instances || [])].sort((a, b) => String(a.instanceName || "").localeCompare(String(b.instanceName || ""))),
		});
	}

	const unassigned = [...(tree?.unassignedInstances || [])].sort((a, b) =>
		String(a.instanceName || "").localeCompare(String(b.instanceName || "")),
	);
	if (unassigned.length) {
		groups.push({ key: UNASSIGNED_HOST_KEY, name: "Unassigned", connected: false, instances: unassigned });
	}

	const usage = gatewayUsage(edits);
	const groupNodes: GraphNodeModel[] = [];
	const instanceNodes: GraphNodeModel[] = [];
	let cursorX = 0;

	for (const group of groups) {
		const count = Math.max(group.instances.length, 1);
		const innerWidth = NODE_DIAMETER;
		const innerHeight = count * NODE_DIAMETER + (count - 1) * INSTANCE_GAP;
		const width = innerWidth + GROUP_PADDING * 2;
		const height = innerHeight + GROUP_PADDING * 2 + GROUP_LABEL_SPACE;

		groupNodes.push({
			id: hostNodeId(group.key),
			type: "group",
			position: { x: cursorX, y: 0 },
			data: { hostName: group.name, connected: group.connected },
			style: { width, height },
			// A host box is scenery: dragging it would drag its instances and buys nothing, and
			// selecting it only competes with selecting the nodes inside.
			draggable: false,
			selectable: false,
		});

		group.instances.forEach((instance, index) => {
			const perGateway: Record<string, GatewayUsage> = {};
			for (const gatewayName of GATEWAY_NAMES) {
				perGateway[gatewayName] = usage.get(instance.instanceId)?.get(gatewayName) || { outgoing: 0, incoming: 0 };
			}
			instanceNodes.push({
				id: instanceNodeId(instance.instanceId),
				type: "instance",
				// Child coordinates are PARENT-RELATIVE: {0,0} is the host box's top-left corner.
				position: {
					x: GROUP_PADDING,
					y: GROUP_PADDING + GROUP_LABEL_SPACE + index * (NODE_DIAMETER + INSTANCE_GAP),
				},
				parentId: hostNodeId(group.key),
				extent: "parent",
				data: {
					instanceId: instance.instanceId,
					instanceName: instance.instanceName,
					gamePort: instance.gamePort ?? null,
					online: isOnline(instance),
					gateways: perGateway,
				},
			});
		});

		cursorX += width + GROUP_GAP;
	}

	// Parents MUST precede their children in the array or React Flow does not resolve parentId.
	// This concatenation is the guarantee, and is asserted by the unit tests.
	return { nodes: [...groupNodes, ...instanceNodes], edges: buildEdges(edits) };
}

export type PositionedNode = {
	id: string;
	position: { x: number; y: number };
	selected?: boolean;
};

/**
 * Carry user-owned node state across a rebuild of the graph.
 *
 * Position and selection exist only in the browser — the controller has no opinion about either. But
 * the platform tree is re-pushed on every status change, and rebuilding from it would hand React
 * Flow a fresh array with layout positions, snapping every node back mid-drag. So a rebuild keeps
 * whatever the user has done to nodes that still exist, takes the computed layout for nodes that are
 * new, and drops nodes that are gone (returning `next`, never a merge of both lists).
 */
export function preservePositions<T extends PositionedNode>(
	previous: readonly PositionedNode[] | null | undefined,
	next: T[],
): T[] {
	if (!previous || previous.length === 0) {
		return next;
	}
	const byId = new Map(previous.map(node => [node.id, node]));
	return next.map(node => {
		const existing = byId.get(node.id);
		return existing ? { ...node, position: existing.position, selected: existing.selected } : node;
	});
}
