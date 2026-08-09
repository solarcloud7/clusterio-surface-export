
import { createContext, useContext } from "react";

import type { GatewayEdits, InstanceLike, TreeLike } from "./gateway-graph";
import { parseEditKey } from "./gateway-graph";
import { shipPhaseFor } from "./transfer-motion";
import type { ShipTransfer } from "./transfer-motion";
import type { TransferSummary } from "../view-models";

const STORAGE_KEY = "surface_export.gateway_debug";

const URL_PARAM = "debug";

export type DebugState = {
	enabled: boolean;
	mockInstances: number;
	mockPlatforms: number;
	shipPhases: string[];
	replayTransferIds: string[];
	showGeometry: boolean;
};

export const DEFAULT_DEBUG_STATE: DebugState = {
	enabled: false,
	mockInstances: 4,
	mockPlatforms: 3,
	shipPhases: [],
	replayTransferIds: [],
	showGeometry: false,
};

export const MAX_MOCK_INSTANCES = 24;
export const MAX_MOCK_PLATFORMS = 12;

export function mockInstanceId(index: number): number {
	return -(index + 1);
}

export function isMockInstanceId(instanceId: number | null | undefined): boolean {
	return typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId < 0;
}

export const MOCK_SHIP_PREFIX = "mock:";

export const GatewayDebugContext = createContext<{ showGeometry: boolean }>({ showGeometry: false });

export function useGatewayDebug() {
	return useContext(GatewayDebugContext);
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

export function loadDebugState(): DebugState {
	let state = { ...DEFAULT_DEBUG_STATE };
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<DebugState>;
			if (parsed && typeof parsed === "object") {
				state = {
					enabled: Boolean(parsed.enabled),
					mockInstances: clamp(parsed.mockInstances, 0, MAX_MOCK_INSTANCES, DEFAULT_DEBUG_STATE.mockInstances),
					mockPlatforms: clamp(parsed.mockPlatforms, 0, MAX_MOCK_PLATFORMS, DEFAULT_DEBUG_STATE.mockPlatforms),
					shipPhases: Array.isArray(parsed.shipPhases)
						? parsed.shipPhases.filter(name => (SHIP_PHASE_NAMES as readonly string[]).includes(name))
						: ((parsed as { showShips?: boolean }).showShips ? [...SHIP_PHASE_NAMES] : []),
					replayTransferIds: Array.isArray(parsed.replayTransferIds)
						? parsed.replayTransferIds.filter(id => typeof id === "string")
						: [],
					showGeometry: Boolean(parsed.showGeometry),
				};
			}
		}
	} catch (err: unknown) {
		console.warn("surface_export: could not read the saved gateway debug state; using defaults", err);
	}

	try {
		const param = new URLSearchParams(window.location.search).get(URL_PARAM);
		if (param === "1" || param === "true") {
			state.enabled = true;
		} else if (param === "0" || param === "false") {
			state.enabled = false;
		}
	} catch (err: unknown) {
		console.warn("surface_export: could not read the debug URL parameter", err);
	}
	return state;
}

export function saveDebugState(state: DebugState): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch (err: unknown) {
		console.warn("surface_export: could not save the gateway debug state; it will reset on reload", err);
	}
}

const MOCK_HOST_ID = -1;

export function withMockInstances(tree: TreeLike | null | undefined, state: DebugState): TreeLike | null | undefined {
	if (!state.enabled || state.mockInstances <= 0) {
		return tree;
	}
	if (!tree) {
		return tree;
	}
	const instances: InstanceLike[] = [];
	for (let index = 0; index < state.mockInstances; index += 1) {
		const instanceId = mockInstanceId(index);
		instances.push({
			instanceId,
			instanceName: `mock-instance-${index + 1}`,
			address: `mock:${34000 + index}`,
			connected: true,
			status: "running",
			platforms: Array.from({ length: state.mockPlatforms }, (_, platformIndex) => ({
				platformIndex: platformIndex + 1,
				platformName: `mock-pad-${platformIndex + 1}`,
				forceName: "player",
				hasSpaceHub: true,
				spaceLocation: ["nauvis", "vulcanus", "fulgora", "gleba", "aquilo"][platformIndex % 5],
				isLocked: platformIndex % 7 === 3,
			})),
		});
	}
	return {
		...tree,
		hosts: [
			...(tree?.hosts || []),
			{ hostId: MOCK_HOST_ID, hostName: "mock (debug)", connected: true, instances },
		],
	};
}

export const SHIP_PHASE_NAMES = [
	"transporting",
	"awaiting_validation",
	"completed",
	"failed",
	"cleanup_failed",
] as const;

export function mockShips(instanceIds: readonly number[], phases: readonly string[]): ShipTransfer[] {
	if (instanceIds.length < 2) {
		return [];
	}
	return phases.map((status, index) => {
		const sourceInstanceId = instanceIds[(index * 2) % instanceIds.length];
		const targetInstanceId = instanceIds[(index * 2 + 1) % instanceIds.length];
		return {
			transferId: `${MOCK_SHIP_PREFIX}${status}`,
			operationType: "transfer" as const,
			status,
			sourceInstanceId,
			targetInstanceId,
		};
	}).filter(ship => ship.sourceInstanceId !== ship.targetInstanceId) as ShipTransfer[];
}

export type ReplayCandidate = {
	transferId: string;
	status: string;
	sourceInstanceId: number;
	targetInstanceId: number;
	platformName?: string;
};

export function replayCandidates(summaries: readonly TransferSummary[] | null | undefined): ReplayCandidate[] {
	return (summaries || [])
		.filter(summary =>
			summary.operationType === "transfer"
			&& Number.isFinite(summary.sourceInstanceId)
			&& Number.isFinite(summary.targetInstanceId)
			&& shipPhaseFor(summary.status) !== null)
		.map(summary => ({
			transferId: summary.transferId,
			status: String(summary.status),
			sourceInstanceId: Number(summary.sourceInstanceId),
			targetInstanceId: Number(summary.targetInstanceId),
			platformName: summary.platformName,
		}));
}

export function replayShips(
	summaries: readonly TransferSummary[] | null | undefined,
	transferIds: readonly string[],
): ShipTransfer[] {
	if (!transferIds.length) {
		return [];
	}
	const wanted = new Set(transferIds);
	return (summaries || [])
		.filter(summary => wanted.has(summary.transferId))
		.filter(summary =>
			Number.isFinite(summary.sourceInstanceId)
			&& Number.isFinite(summary.targetInstanceId)
			&& shipPhaseFor(summary.status) !== null) as ShipTransfer[];
}

export type DebugScenario = {
	instances: Array<{
		name?: string;
		host?: string;
		online?: boolean;
		platforms?: Array<string | { name?: string; location?: string; status?: string; locked?: boolean }>;
	}>;
	links?: Array<[number, number]>;
	ships?: Array<{ from: number; to: number; status: string }>;
};

const SCENARIO_HOST = "scenario (debug)";

export function scenarioToTree(scenario: DebugScenario): TreeLike {
	const byHost = new Map<string, InstanceLike[]>();
	scenario.instances.forEach((spec, index) => {
		const host = spec.host || SCENARIO_HOST;
		const platforms = (spec.platforms || []).map((platform, platformIndex) => {
			const row = typeof platform === "string" ? { name: platform } : platform;
			return {
				platformIndex: platformIndex + 1,
				platformName: row.name || `pad-${platformIndex + 1}`,
				forceName: "player",
				hasSpaceHub: true,
				spaceLocation: row.location ?? "nauvis",
				transferStatus: row.status,
				isLocked: Boolean(row.locked),
			};
		});
		const list = byHost.get(host) || [];
		list.push({
			instanceId: mockInstanceId(index),
			instanceName: spec.name || `scenario-${index + 1}`,
			address: `scenario:${34000 + index}`,
			connected: spec.online !== false,
			status: spec.online === false ? "stopped" : "running",
			platforms,
		});
		byHost.set(host, list);
	});
	return {
		hosts: [...byHost.entries()].map(([hostName, instances], hostIndex) => ({
			hostId: -(hostIndex + 1),
			hostName,
			connected: true,
			instances,
		})),
	};
}

export function scenarioToEdits(scenario: DebugScenario, gatewayName: string): GatewayEdits {
	const edits: GatewayEdits = {};
	const push = (from: number, to: number) => {
		const key = `${mockInstanceId(from)}:${gatewayName}`;
		const targets = edits[key] || [];
		targets.push({ targetInstanceId: mockInstanceId(to), targetGateway: gatewayName });
		edits[key] = targets;
	};
	for (const [from, to] of scenario.links || []) {
		if (from === to) {
			continue;
		}
		push(from, to);
		push(to, from);
	}
	return edits;
}

export function scenarioToShips(scenario: DebugScenario): ShipTransfer[] {
	return (scenario.ships || [])
		.filter(ship => ship.from !== ship.to)
		.map((ship, index) => ({
			transferId: `${MOCK_SHIP_PREFIX}scenario-${index}-${ship.status}`,
			operationType: "transfer" as const,
			status: ship.status,
			sourceInstanceId: mockInstanceId(ship.from),
			targetInstanceId: mockInstanceId(ship.to),
		})) as ShipTransfer[];
}

export function isMockEditKey(key: string): boolean {
	const parsed = parseEditKey(key);
	return parsed ? isMockInstanceId(parsed.sourceInstanceId) : false;
}

export type GatewaySavePayload = ReadonlyMap<number, ReadonlyArray<{
	gatewayName: string;
	targets: ReadonlyArray<{ targetInstanceId: number; targetGateway: string }>;
}>>;

export function mockLeaksInPayload(payload: GatewaySavePayload): string[] {
	const leaks: string[] = [];
	for (const [sourceInstanceId, gateways] of payload) {
		if (isMockInstanceId(sourceInstanceId)) {
			leaks.push(`source instance ${sourceInstanceId}`);
		}
		for (const entry of gateways) {
			for (const target of entry.targets) {
				if (isMockInstanceId(target?.targetInstanceId)) {
					leaks.push(`${entry.gatewayName} -> instance ${target.targetInstanceId}`);
				}
			}
		}
	}
	return leaks;
}
