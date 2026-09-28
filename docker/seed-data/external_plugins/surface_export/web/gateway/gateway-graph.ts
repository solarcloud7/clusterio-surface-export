import { CAPTION_WIDTH } from "../../shared/edge-geometry";
import { portalSlotOf } from "../../shared/portals";
import type { PortalAssignment } from "../../shared/portals";
import type { PlatformStatusFields } from "../platform-actions";

export { PORTAL_COLOURS, portalColour, portalGatewayName } from "../../shared/portals";


export type PlatformLike = PlatformStatusFields & {
	platformUid?: string | null;
	platformIndex: number;
	platformName: string;
	forceName?: string;
	hasSpaceHub?: boolean;
};

export type Portal = PortalAssignment;

export type InstanceLike = {
	instanceId: number;
	instanceName: string;
	gamePort?: number | null;
	address?: string;
	status?: string;
	connected?: boolean;
	autoPause?: boolean;
	defaultPlanet?: string;
	disabledPlanets?: string[];
	portal?: Portal | null;
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

export type PeerPortal = { instanceId: number; instanceName: string; portal: Portal | null };

export function peerPortalHandleId(peerInstanceId: number): string {
	return `portal:${peerInstanceId}`;
}

export function portalOrientation(index: number, count: number): number {
	return (index + 0.5) / count;
}

function wrapTurn(turn: number): number {
	let wrapped = turn % 1;
	if (wrapped < 0) {
		wrapped += 1;
	}
	return wrapped;
}

export function facingTurn(from: { x: number; y: number }, to: { x: number; y: number }): number {
	return wrapTurn(Math.atan2(to.x - from.x, from.y - to.y) / (2 * Math.PI));
}

export const MIN_PORTAL_GAP = 1 / 10;

export const CAPTION_CLEAR_TURN = 1 / 8;

export function clearOfCaption(turn: number): number {
	const wrapped = wrapTurn(turn);
	if (wrapped < CAPTION_CLEAR_TURN) {
		return CAPTION_CLEAR_TURN;
	}
	if (wrapped > 1 - CAPTION_CLEAR_TURN) {
		return 1 - CAPTION_CLEAR_TURN;
	}
	return wrapped;
}

export function spreadTurns(turns: readonly number[], gap: number = MIN_PORTAL_GAP): number[] {
	const low = CAPTION_CLEAR_TURN;
	const high = 1 - CAPTION_CLEAR_TURN;
	const order = turns.map((turn, index) => ({ turn: clearOfCaption(turn), index })).sort((a, b) => a.turn - b.turn);
	const spaced = order.map(entry => entry.turn);
	for (let pass = 0; pass < order.length; pass += 1) {
		for (let i = 1; i < spaced.length; i += 1) {
			const overlap = gap - (spaced[i] - spaced[i - 1]);
			if (overlap > 0) {
				spaced[i - 1] -= overlap / 2;
				spaced[i] += overlap / 2;
			}
		}
	}
	for (let i = 0; i < spaced.length; i += 1) {
		spaced[i] = Math.max(spaced[i], i === 0 ? low : spaced[i - 1] + gap);
	}
	for (let i = spaced.length - 1; i >= 0; i -= 1) {
		spaced[i] = Math.min(spaced[i], i === spaced.length - 1 ? high : spaced[i + 1] - gap);
	}
	const result = new Array<number>(turns.length);
	order.forEach((entry, position) => { result[entry.index] = Math.min(high, Math.max(low, spaced[position])); });
	return result;
}

export function peerPortalsFor(instanceId: number, instances: readonly InstanceLike[]): PeerPortal[] {
	return instances
		.filter(peer => peer.instanceId !== instanceId)
		.map(peer => ({ instanceId: peer.instanceId, instanceName: peer.instanceName, portal: peer.portal ?? null }))
		.sort((a, b) => (a.portal?.slot ?? Infinity) - (b.portal?.slot ?? Infinity)
			|| a.instanceName.localeCompare(b.instanceName) || a.instanceId - b.instanceId);
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


export function activePlanets(installed: readonly string[], defaultPlanet: string, disabled: readonly string[]): string[] {
	const off = new Set(disabled);
	const names = installed.includes(defaultPlanet) ? [...installed] : [defaultPlanet, ...installed];
	return names.filter(name => name === defaultPlanet || !off.has(name));
}

export interface TrafficRouteModel {
	sourceInstanceId: number;
	targetInstanceId: number;
	platforms: Array<{ platformIndex: number; platformName: string }>;
}

export function portalHolders(instances: readonly InstanceLike[]): Map<number, number> {
	const holders = new Map<number, number>();
	for (const instance of instances) {
		const slot = instance.portal?.slot;
		if (typeof slot === "number" && !holders.has(slot)) {
			holders.set(slot, instance.instanceId);
		}
	}
	return holders;
}

export function headingInstanceId(
	target: string | null | undefined,
	sourceInstanceId: number,
	holders: ReadonlyMap<number, number>,
): number | null {
	const slot = portalSlotOf(target);
	const holder = slot === null ? undefined : holders.get(slot);
	return holder === undefined || holder === sourceInstanceId ? null : holder;
}

export function buildTrafficRoutes(instances: readonly InstanceLike[]): TrafficRouteModel[] {
	const drawn = new Set(instances.map(instance => instance.instanceId));
	const holders = portalHolders(instances);
	const routes = new Map<string, TrafficRouteModel>();
	for (const instance of instances) {
		for (const platform of instance.platforms || []) {
			const targetInstanceId = platform?.hasSpaceHub ? headingInstanceId(platform.currentTarget, instance.instanceId, holders) : null;
			if (targetInstanceId === null || !drawn.has(targetInstanceId)) {
				continue;
			}
			const key = `${instance.instanceId}>${targetInstanceId}`;
			let route = routes.get(key);
			if (!route) {
				route = { sourceInstanceId: instance.instanceId, targetInstanceId, platforms: [] };
				routes.set(key, route);
			}
			route.platforms.push({ platformIndex: platform.platformIndex, platformName: platform.platformName });
		}
	}
	return [...routes.values()].sort((a, b) =>
		a.sourceInstanceId - b.sourceInstanceId || a.targetInstanceId - b.targetInstanceId);
}

export interface TrafficPair<S> {
	key: string;
	sourceInstanceId: number;
	targetInstanceId: number;
	forward: boolean;
	reverse: boolean;
	routes: TrafficRouteModel[];
	ships: S[];
}

export function groupTraffic<S extends { sourceInstanceId: number; targetInstanceId: number }>(
	routes: readonly TrafficRouteModel[],
	ships: readonly S[],
	drawnInstanceIds: ReadonlySet<number>,
): TrafficPair<S>[] {
	const pairs = new Map<string, TrafficPair<S>>();
	const pairFor = (sourceInstanceId: number, targetInstanceId: number) => {
		if (sourceInstanceId === targetInstanceId
			|| !drawnInstanceIds.has(sourceInstanceId) || !drawnInstanceIds.has(targetInstanceId)) {
			return null;
		}
		const key = sourceInstanceId <= targetInstanceId
			? `${sourceInstanceId}|${targetInstanceId}` : `${targetInstanceId}|${sourceInstanceId}`;
		let pair = pairs.get(key);
		if (!pair) {
			pair = { key, sourceInstanceId, targetInstanceId, forward: false, reverse: false, routes: [], ships: [] };
			pairs.set(key, pair);
		}
		if (sourceInstanceId === pair.sourceInstanceId) {
			pair.forward = true;
		} else {
			pair.reverse = true;
		}
		return pair;
	};
	for (const route of routes) {
		pairFor(route.sourceInstanceId, route.targetInstanceId)?.routes.push(route);
	}
	for (const ship of ships) {
		pairFor(ship.sourceInstanceId, ship.targetInstanceId)?.ships.push(ship);
	}
	return [...pairs.values()];
}


export const NODE_DIAMETER = 150;
export const CAPTION_HEIGHT = 76;
export { CAPTION_WIDTH };
export const INSTANCE_GAP = 70;
export const COLUMN_GAP = 90;


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
	hostFilter: string = ALL_HOSTS,
): {
	nodes: GraphNodeModel[];
	routes: TrafficRouteModel[];
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

	const nodes: GraphNodeModel[] = [];
	const everyInstance = columns.flatMap(column => column.instances);
	const columnWidth = Math.max(NODE_DIAMETER, CAPTION_WIDTH);
	const columnPitch = columnWidth + COLUMN_GAP;
	const columnInset = Math.max(0, (columnWidth - NODE_DIAMETER) / 2);

	columns.forEach((column, columnIndex) => {
		column.instances.forEach((instance, index) => {
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
					instanceId: instance.instanceId,
					instanceName: instance.instanceName,
					address: instance.address || "",
					online: isOnline(instance),
					autoPause: instance.autoPause === true,
					hostKey: column.key,
					hostName: column.name,
					platforms,
					defaultPlanet: instance.defaultPlanet || "nauvis",
					disabledPlanets: instance.disabledPlanets || [],
					portal: instance.portal ?? null,
					peers: peerPortalsFor(instance.instanceId, everyInstance),
				},
			});
		});
	});

	const instances = columns.flatMap(column => column.instances);
	return { nodes, routes: buildTrafficRoutes(instances), hosts };
}

export type PositionedNode = {
	id: string;
	position: { x: number; y: number };
	selected?: boolean;
	measured?: { width?: number; height?: number };
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
		return existing ? {
			...node,
			position: existing.position,
			selected: existing.selected,
			measured: existing.measured,
		} : node;
	});
}
