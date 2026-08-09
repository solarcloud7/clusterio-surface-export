import type { GatewayLink, GatewayMode } from "../../shared/dto";
import { DEFAULT_GATEWAY_MODE, gatewayNamesFor } from "../../shared/dto";
import type { PlatformStatusFields } from "../platform-actions";


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

export type GatewayEdits = Record<string, GatewayLink[]>;

export type RawGatewayLinkRow = {
	sourceInstanceId: number;
	gatewayName: string;
	targets?: GatewayLink[];
};


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

export const ALL_HOSTS = "all";

export type HandleSide = "top" | "right" | "bottom" | "left";

export function sourceHandleId(gatewayName: string, side?: HandleSide): string {
	return side ? `s:${gatewayName}@${side}` : `s:${gatewayName}`;
}

export function targetHandleId(gatewayName: string, side?: HandleSide): string {
	return side ? `t:${gatewayName}@${side}` : `t:${gatewayName}`;
}

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
	const at = body.lastIndexOf("@");
	const name = at === -1 ? body : body.slice(0, at);
	return name || null;
}


export interface GatewayEdgeModel {
	id: string;
	source: string;
	sourceHandle: string;
	target: string;
	targetHandle: string;
	sourceInstanceId: number;
	sourceGateway: string;
	targetInstanceId: number;
	targetGateway: string;
	forward: boolean;
	reverse: boolean;
}

type Endpoint = { instanceId: number; gatewayName: string };

function endpointKey(endpoint: Endpoint): string {
	return `${endpoint.instanceId}/${endpoint.gatewayName}`;
}

function orient(a: Endpoint, b: Endpoint): { low: Endpoint; high: Endpoint; flipped: boolean } {
	const flipped = endpointKey(a) > endpointKey(b);
	return flipped ? { low: b, high: a, flipped } : { low: a, high: b, flipped };
}

export function edgeId(a: Endpoint, b: Endpoint): string {
	const { low, high } = orient(a, b);
	return `link:${endpointKey(low)}|${endpointKey(high)}`;
}

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
		if (flipped) {
			edge.reverse = true;
		} else {
			edge.forward = true;
		}
	}
	return [...byPair.values()].sort((a, b) => a.id.localeCompare(b.id));
}


export type GatewayUsage = { outgoing: number; incoming: number };

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
	const encode = (list: GatewayLink[]) => list.map(t => `${t.targetInstanceId}/${t.targetGateway}`).sort();
	const left = encode(a);
	const right = encode(b);
	return left.every((value, index) => value === right[index]);
}

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


export const NODE_DIAMETER = 150;
export const CAPTION_HEIGHT = 76;
export const CAPTION_WIDTH = 190;
export const INSTANCE_GAP = 70;
export const COLUMN_GAP = 90;


export const PLATFORM_LIST_MAX_ROWS = 6;

export const DIMMED_OPACITY = 0.12;

export interface GraphNodeModel {
	id: string;
	type: "instance";
	position: { x: number; y: number };
	data: Record<string, unknown>;
	style?: Record<string, number | string>;
	deletable: false;
}

export interface GraphHostModel {
	key: string;
	name: string;
	connected: boolean;
}

function isOnline(instance: InstanceLike): boolean {
	return Boolean(instance.connected) && instance.status === "running";
}

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
	const columnWidth = Math.max(NODE_DIAMETER, CAPTION_WIDTH);
	const columnPitch = columnWidth + COLUMN_GAP;
	const columnInset = Math.max(0, (columnWidth - NODE_DIAMETER) / 2);

	columns.forEach((column, columnIndex) => {
		column.instances.forEach((instance, index) => {
			const perGateway: Record<string, GatewayUsage> = {};
			for (const gatewayName of gatewayNamesFor(mode)) {
				perGateway[gatewayName] = usage.get(instance.instanceId)?.get(gatewayName) || { outgoing: 0, incoming: 0 };
			}
			const dimmed = filtering && column.key !== hostFilter;
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
					y: index * (NODE_DIAMETER + CAPTION_HEIGHT + INSTANCE_GAP),
				},
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
