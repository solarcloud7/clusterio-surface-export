/**
 * Projecting gateway link config into a node graph, and edits back out of it.
 *
 * Pure — no React, no @xyflow import — so it stays readable on its own, but it is UI code and lives
 * with the UI. Its behaviour is covered end-to-end by driving the canvas, not by unit tests.
 *
 * THE MODEL IS THE EDITS MAP. `GatewayEdits` is keyed exactly as the controller keys its own config
 * (`${sourceInstanceId}:${gatewayName}` -> that gateway's whole target list), so a save is one
 * setGatewayLink call per changed key with no translation. Edges are a PROJECTION of that map, never
 * a second source of truth — which is why there is nothing to reconcile between what is drawn and
 * what will be saved.
 */

import type { GatewayLink, GatewayMode } from "../../shared/dto";
import { DEFAULT_GATEWAY_MODE, gatewayNamesFor } from "../../shared/dto";
import type { PlatformStatusFields } from "../platform-actions";

// ── Structural inputs ───────────────────────────────────────────────────────
// Declared structurally rather than imported from the DTO so this file states exactly which fields
// it reads: the platform tree is re-pushed on every status change and re-projected each time, so
// what a node carries is a performance decision as well as a typing one. These are subsets of
// InstanceNodeModel / HostNodeModel / PlatformModel.

export type PlatformLike = PlatformStatusFields & {
	platformIndex: number;
	platformName: string;
	forceName?: string;
	hasSpaceHub?: boolean;
};

export type InstanceLike = {
	instanceId: number;
	instanceName: string;
	gamePort?: number | null;
	/** `publicAddress:gamePort`, or "" when the instance has no port because it is not running. */
	address?: string;
	status?: string;
	connected?: boolean;
	platforms?: PlatformLike[];
};

export type HostLike = {
	hostId: number;
	hostName: string;
	connected?: boolean;
	instances?: InstanceLike[];
};

export type TreeLike = {
	forceName?: string;
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

/** The host filter's key for instances the controller reports with no host assignment. */
export const UNASSIGNED_HOST_KEY = "unassigned";

/** The host filter's "don't dim anything" value. Not a host key, so it can never collide with one. */
export const ALL_HOSTS = "all";

/**
 * A gateway needs BOTH handles: links are directional, and the same gateway can be an origin for one
 * link and a destination for another. React Flow only starts a connection from a source handle and
 * only completes it on a target handle, so the two are never ambiguous despite sharing a position.
 *
 * Handle ids optionally carry the SIDE of the node they sit on: `s:surfexp_gateway_hub@right`.
 *
 * Multi mode needs no side — each of the four gateways owns one side, so its name already says where
 * it is. One-gate mode has a single gateway and four sides, and React Flow requires every handle on a
 * node to have a distinct id, so the side is what distinguishes them. It is presentation only: every
 * side decodes back to the same gateway, and edge identity is built from instance+gateway rather
 * than from handles, so which side a link was drawn from never changes what is stored.
 */
export type HandleSide = "top" | "right" | "bottom" | "left";

export function sourceHandleId(gatewayName: string, side?: HandleSide): string {
	return side ? `s:${gatewayName}@${side}` : `s:${gatewayName}`;
}

export function targetHandleId(gatewayName: string, side?: HandleSide): string {
	return side ? `t:${gatewayName}@${side}` : `t:${gatewayName}`;
}

/**
 * A PLATFORM ROW's drag handle — a THIRD namespace, deliberately not a gateway handle.
 *
 * Dragging from a platform row to another instance's portal starts a TRANSFER, which is a one-shot
 * operation, not a link that gets staged and saved. Giving it its own `p:` prefix is what keeps the
 * two apart at the one place it matters: `gatewayFromHandleId` returns null for it, so a platform
 * handle can never be mistaken for a gateway endpoint and silently written into the config.
 *
 * Keyed on the platform INDEX, not its name: names collide across a force, the index does not
 * (see the lookup-by-unique-ID rule this repo enforces elsewhere).
 */
export function platformHandleId(platformIndex: number): string {
	return `p:${platformIndex}`;
}

export function platformIndexFromHandleId(handleId: string | null | undefined): number | null {
	if (!handleId || !handleId.startsWith("p:")) {
		return null;
	}
	const index = Number(handleId.slice(2));
	return Number.isFinite(index) ? index : null;
}

export function gatewayFromHandleId(handleId: string | null | undefined): string | null {
	if (!handleId || handleId.length < 3) {
		return null;
	}
	const prefix = handleId.slice(0, 2);
	if (prefix !== "s:" && prefix !== "t:") {
		return null;
	}
	const body = handleId.slice(2);
	// A gateway name never contains "@" (they are `surfexp_gateway_<suffix>`), so the last "@" is
	// unambiguously the side separator when one is present.
	const at = body.lastIndexOf("@");
	const name = at === -1 ? body : body.slice(0, at);
	return name || null;
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

export function buildEdges(edits: GatewayEdits, _mode: GatewayMode = DEFAULT_GATEWAY_MODE): GatewayEdgeModel[] {
	// Handle ids carry no side. Multi mode gives each gateway its own pair (unique by name), and
	// one-gate mode has a single easy-connect pair covering the whole node — so in both modes the
	// gateway name alone identifies the handle. Edges float anyway, so the id is only an anchor for
	// React Flow’s bookkeeping, never a position.
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
/**
 * Room under each node for its label.
 *
 * In one-gate mode the gateway art fills the whole circle, so the instance name cannot sit inside
 * it and is drawn BELOW instead. The layout has to reserve that space or the label spills out of
 * the host box and collides with whatever is stacked underneath. Reserved in BOTH modes so a mode
 * switch never reflows the graph.
 */
export const CAPTION_HEIGHT = 76;
/** Labels are wider than the circle they sit under; the column is as wide as whichever is bigger. */
export const CAPTION_WIDTH = 190;
/** Gap between stacked instances in one host's column, and between the columns themselves. */
export const INSTANCE_GAP = 70;
export const COLUMN_GAP = 90;

// ── The platform list hanging under each node ───────────────────────────────
// These describe the list's SHAPE, and must agree with `.surface-export-platform-list` in
// web/style.css. They are deliberately NOT part of the layout pitch: the list opens on click and
// hides itself again, so it is a transient overlay — exactly like the NodeToolbar it replaced, which
// also reserved nothing. Reserving a block under every node for a strip that is almost never drawn
// cost permanent dead space in the column and made fitView zoom out for it. The price is that an
// open list can briefly cover the node below, which resolves itself in three seconds.

/**
 * How many rows are drawn before the list stops and says how many it is not showing.
 *
 * NOT a scroll container. React Flow measures handle positions once, when the node is measured — a
 * row scrolled out of view and back would drag from a stale origin, which reads as the connection
 * line starting from nowhere. A hard cap with an honest "+k more" line has no such failure mode, and
 * the overflow row is deliberately NOT a handle: what it stands for is several platforms, so there is
 * no single thing a drag from it could mean.
 *
 * The cap is also what keeps an open list from being unboundedly tall, which matters more now that
 * nothing reserves room for one.
 */
export const PLATFORM_LIST_MAX_ROWS = 6;

/** How much of its own opacity a node keeps when the host filter is pointed somewhere else. */
export const DIMMED_OPACITY = 0.12;

export interface GraphNodeModel {
	id: string;
	type: "instance";
	position: { x: number; y: number };
	data: Record<string, unknown>;
	style?: Record<string, number | string>;
	/**
	 * Always false. A node is an INSTANCE — nothing on this canvas may delete one, and letting React
	 * Flow try was a link-destroying trap: deleting a node cascades into `onEdgesDelete` for every
	 * edge touching it, which stages an `applyDisconnect` for each. Measured on the live canvas:
	 * selecting a node and pressing Backspace took the drawn edges from 1 to 0 and the pending count
	 * to "2 unsaved changes", while the node itself came straight back on the next platform-tree
	 * push — so the board looked untouched with two link deletions queued behind it.
	 *
	 * Per-node rather than a canvas-wide prop because React Flow 12 has no `nodesDeletable`.
	 */
	deletable: false;
}

/** One entry per host in the tree, for the canvas's host filter. */
export interface GraphHostModel {
	key: string;
	name: string;
	connected: boolean;
}

function isOnline(instance: InstanceLike): boolean {
	// Must keep matching the controller's isInstanceOnline (connected AND running), or the canvas
	// disagrees with the config it pushes. Moved from GatewaysTab, not re-derived.
	return Boolean(instance.connected) && instance.status === "running";
}

/**
 * Every instance as a free-floating node, laid out one column per host.
 *
 * NO SUB-FLOWS. Instances used to be React Flow children of a host `group` node with
 * `extent: "parent"`, which drew a box per host and — the part that mattered — refused to let a node
 * be dragged out of it. The host is now a FILTER (see `hostFilter` below) rather than a fence, so
 * the operator can arrange the graph however the cluster's topology actually reads. Host locality
 * survives as the column layout; it is a starting position now, not a constraint.
 *
 * Deterministic rather than force-directed: this graph is small (one instance per host on the dev
 * cluster) and a stable layout means a node is where the operator last saw it. Sorting mirrors the
 * old tab's ordering so the canvas does not silently reshuffle relative to the list it replaces.
 *
 * `hostFilter` DIMS, it does not remove: a hidden node would take its edges with it, and an edge
 * that vanishes on a display setting is indistinguishable from one that was never configured. An
 * unrecognised value (a host that has left the tree since it was picked) dims nothing, so the filter
 * heals itself rather than fading the whole canvas out.
 */
export function buildGraph(
	tree: TreeLike | null | undefined,
	edits: GatewayEdits,
	mode: GatewayMode = DEFAULT_GATEWAY_MODE,
	hostFilter: string = ALL_HOSTS,
): {
	nodes: GraphNodeModel[];
	edges: GatewayEdgeModel[];
	hosts: GraphHostModel[];
} {
	const columns: Array<{ key: string; name: string; connected: boolean; instances: InstanceLike[] }> = [];

	for (const host of [...(tree?.hosts || [])].sort((a, b) => String(a.hostName || "").localeCompare(String(b.hostName || "")))) {
		columns.push({
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
		columns.push({ key: UNASSIGNED_HOST_KEY, name: "Unassigned", connected: false, instances: unassigned });
	}

	const hosts: GraphHostModel[] = columns.map(column => ({
		key: column.key,
		name: column.name,
		connected: column.connected,
	}));
	const filtering = hostFilter !== ALL_HOSTS && hosts.some(host => host.key === hostFilter);

	const usage = gatewayUsage(edits);
	const nodes: GraphNodeModel[] = [];
	// As wide as the widest thing a column draws PERMANENTLY — the circle or its caption. The platform
	// list is wider than both but transient, and only one is ever open (only one node is selected), so
	// two of them cannot collide; widening every column for it was permanent cost for a transient
	// overlap that cannot happen.
	const columnWidth = Math.max(NODE_DIAMETER, CAPTION_WIDTH);
	const columnPitch = columnWidth + COLUMN_GAP;
	// Centres the circle under that column, since the things overhanging it are centred on it too.
	const columnInset = Math.max(0, (columnWidth - NODE_DIAMETER) / 2);

	columns.forEach((column, columnIndex) => {
		column.instances.forEach((instance, index) => {
			const perGateway: Record<string, GatewayUsage> = {};
			for (const gatewayName of gatewayNamesFor(mode)) {
				perGateway[gatewayName] = usage.get(instance.instanceId)?.get(gatewayName) || { outgoing: 0, incoming: 0 };
			}
			const dimmed = filtering && column.key !== hostFilter;
			// Only hub-bearing platforms: a platform without a space hub cannot be exported or
			// transferred, and the controller refuses one. Offering the rows anyway would put the
			// refusal after the click instead of before it.
			const platforms = (instance.platforms || [])
				.filter(platform => platform && platform.hasSpaceHub)
				.map(platform => ({
					...platform,
					forceName: platform.forceName || tree?.forceName || "player",
				}));
			nodes.push({
				id: instanceNodeId(instance.instanceId),
				type: "instance",
				deletable: false,
				position: {
					x: columnIndex * columnPitch + columnInset,
					// Every node owns its diameter PLUS its caption; the gap sits between those blocks.
					// The platform list is NOT in this sum — it is a transient overlay, see the note on
					// PLATFORM_LIST_MAX_ROWS above.
					y: index * (NODE_DIAMETER + CAPTION_HEIGHT + INSTANCE_GAP),
				},
				// Dimming is a node STYLE rather than a class on the inner element so it covers the
				// caption too — the caption is positioned outside the node's own box, and fading the
				// gate while its label stayed bright would read as a rendering fault.
				//
				// The style is DERIVED from data.dimmed, and the canvas dims edges from data.dimmed as
				// well — one boolean, decided here. Reading it back off the rendered opacity instead
				// would be a second representation of the same fact, and a falsy opacity (0) would then
				// read as "focused".
				style: dimmed ? { opacity: DIMMED_OPACITY } : undefined,
				data: {
					dimmed,
					mode,
					instanceId: instance.instanceId,
					instanceName: instance.instanceName,
					address: instance.address || "",
					online: isOnline(instance),
					hostKey: column.key,
					hostName: column.name,
					platforms,
					gateways: perGateway,
				},
			});
		});
	});

	return { nodes, edges: buildEdges(edits, mode), hosts };
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
