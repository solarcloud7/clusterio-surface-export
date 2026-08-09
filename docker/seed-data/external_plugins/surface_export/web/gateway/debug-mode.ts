/**
 * Debug mode: make the canvas show things a real two-instance cluster cannot.
 *
 * WHY THIS EXISTS, concretely. The dev cluster has two instances with one platform each, so a whole
 * class of behaviour is unreachable by looking: the column layout past one column, the running-total
 * vertical pitch, the six-row platform cap and its "+k more" line, every transfer phase except the
 * one currently running, and the invisible geometry (the measured node box, the portal hit-zone, the
 * edge anchor) that three separate bugs have now hidden in. Those were checked with throwaway
 * probes, which prove a number and then evaporate. This puts the same things on screen.
 *
 * NOTHING MOCK MAY REACH THE CONTROLLER. That is the one hard rule, and it has to be held at EVERY
 * path out of the canvas — there are two, and an earlier version of this comment claimed the rule
 * while covering only one of them.
 *
 * STAGED GATEWAY EDITS — the path that could corrupt cluster config:
 *
 *   1. A mock instance id is NEGATIVE. Clusterio's own ids are unsigned (the live cluster's are
 *      472806668 and 1285554351), so the two sets cannot collide — no seeding, no coordination, no
 *      chance of a mock id naming a real instance.
 *   2. Mock and real may never LINK. `isValidConnection` refuses any pairing that crosses the
 *      boundary, so every staged edit is wholly-mock or wholly-real, and dropping the mock ones is
 *      then a clean partition rather than a per-target rewrite.
 *   3. `save` re-checks at the point that actually writes (`mockLeakIn`), because the two above are
 *      refusals in the UI layer and the write is where the damage would be.
 *
 * PER-PLATFORM ACTIONS — the path those three do NOT cover. Export and Transfer are requests sent
 * straight from a row, carrying whatever instance id the row holds; no staging, no Save, so nothing
 * above sees them. Export on a mock row would send `sourceInstanceId: -1` to the controller, and
 * Transfer would offer real destinations for a platform that does not exist. Those controls are
 * therefore disabled on mock rows, in PlatformRows.tsx, where the click is.
 */

import { createContext, useContext } from "react";

import type { GatewayEdits, InstanceLike, TreeLike } from "./gateway-graph";
import { parseEditKey } from "./gateway-graph";
import type { ShipTransfer } from "./transfer-motion";

/** The one place the on/off state is remembered. Separate from the layout key; different lifetime. */
const STORAGE_KEY = "surface_export.gateway_debug";

/** `?debug=1` turns it on, `?debug=0` off. Anything else leaves the remembered value alone. */
const URL_PARAM = "debug";

export type DebugState = {
	enabled: boolean;
	/** How many fake instances to append to the tree. */
	mockInstances: number;
	/** How many fake platforms each fake instance carries. */
	mockPlatforms: number;
	/**
	 * WHICH transfer phases to draw a fake ship for — not a single on/off.
	 *
	 * Per-phase because the phases are what you are usually looking at: comparing "validating" against
	 * "failed — returned" means having exactly those two on screen, and an all-or-nothing switch put
	 * five ships up and left you picking one out of the pile.
	 */
	shipPhases: string[];
	/** Outline the measured node box, the portal hit-zone and the edge anchor. */
	showGeometry: boolean;
};

export const DEFAULT_DEBUG_STATE: DebugState = {
	enabled: false,
	mockInstances: 4,
	mockPlatforms: 3,
	shipPhases: [],
	showGeometry: false,
};

/** Bounds, so a stored value (or a fat finger on the + button) cannot wedge the canvas. */
export const MAX_MOCK_INSTANCES = 24;
export const MAX_MOCK_PLATFORMS = 12;

/**
 * A mock instance id. NEGATIVE, which is what makes it structurally disjoint from every real one.
 *
 * Offset from -1 rather than starting at 0 so `isMockInstanceId(0)` is false: 0 is not a real
 * Clusterio id either, but a falsy id has a habit of arriving from somewhere unexpected, and a
 * predicate that claims it is "ours" would then quietly adopt it.
 */
export function mockInstanceId(index: number): number {
	return -(index + 1);
}

export function isMockInstanceId(instanceId: number | null | undefined): boolean {
	return typeof instanceId === "number" && Number.isFinite(instanceId) && instanceId < 0;
}

/** Mock transfer ids share a prefix, so one is recognisable in a tooltip or a console log. */
export const MOCK_SHIP_PREFIX = "mock:";

/**
 * Whether a node should draw its geometry overlay, handed down by context.
 *
 * NOT through node data, for the reason node-actions.ts gives about the callbacks: node data is
 * rebuilt from the platform tree on every status push, and this is a view setting that has nothing
 * to do with what the graph projection knows. It also keeps `buildGraph` — which is pure, and is the
 * file the layout lives in — from growing an opinion about a debug switch.
 *
 * Defaults to false outside a provider, so a node rendered without one simply draws normally.
 */
export const GatewayDebugContext = createContext<{ showGeometry: boolean }>({ showGeometry: false });

export function useGatewayDebug() {
	return useContext(GatewayDebugContext);
}

// ── Persistence ─────────────────────────────────────────────────────────────

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

/**
 * The remembered state, overridden by `?debug=` when present.
 *
 * Read once into a ref by the canvas, like the saved layout: this is a starting value, not a live
 * input, and re-reading it every render would let a stale copy fight the controls.
 */
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
					// Filtered against the live phase list rather than trusted: a stored phase name that no
					// longer exists would draw nothing and look like a broken toggle. Also absorbs the
					// older `showShips: true` shape, which meant "all of them".
					shipPhases: Array.isArray(parsed.shipPhases)
						? parsed.shipPhases.filter(name => (SHIP_PHASE_NAMES as readonly string[]).includes(name))
						: ((parsed as { showShips?: boolean }).showShips ? [...SHIP_PHASE_NAMES] : []),
					showGeometry: Boolean(parsed.showGeometry),
				};
			}
		}
	} catch (err: unknown) {
		// Not swallowed: a debug panel that silently stops remembering its settings is exactly the kind
		// of thing that gets rediscovered as a bug. The default state is a fine place to continue from.
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

// ── Mock tree ───────────────────────────────────────────────────────────────

/**
 * The host id the mock column is stacked under. NEGATIVE, for the same reason the instance ids are:
 * `buildGraph` keys each column by `String(host.hostId)`, and no real Clusterio host id is negative.
 *
 * (There was a `MOCK_HOST_KEY = "mock"` constant here that nothing read — the key has always been
 * `String(-1)` — carrying a comment explaining a collision-safety mechanism that was not in play.)
 */
const MOCK_HOST_ID = -1;

/**
 * The real tree with fake instances appended as one extra host column.
 *
 * They are injected INTO THE TREE, upstream of `buildGraph`, on purpose: a mock instance then goes
 * through exactly the same projection, layout, node rendering and edge code as a real one. A mock
 * that took a shortcut would be testing the shortcut. This is what lets the debug panel exercise the
 * running-total pitch and the platform-row cap for real.
 *
 * Returns the input unchanged when there is nothing to add, so the memo it feeds keeps its identity.
 */
export function withMockInstances(tree: TreeLike | null | undefined, state: DebugState): TreeLike | null | undefined {
	if (!state.enabled || state.mockInstances <= 0) {
		return tree;
	}
	// NOT UNTIL THE REAL TREE HAS LOADED, and this is a correctness guard rather than an optimisation.
	// The canvas renders once with `tree === null` while the platform tree is still in flight. Injected
	// then, the mock host is the ONLY column, so it is laid out at column 0 — and when the real
	// instances arrive one frame later and push it to column 2, `preservePositions` does exactly its
	// job and keeps the mocks where they already were. The result is a mock column sitting on top of a
	// real one. Measured: mock-instance-1 at x=57 against host-1 at x=-4, boxes overlapping.
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
			// Online, because the offline styling greys the gate out and the point of these is to look
			// at the layout. An operator can tell them apart by the name and the host column.
			connected: true,
			status: "running",
			platforms: Array.from({ length: state.mockPlatforms }, (_, platformIndex) => ({
				platformIndex: platformIndex + 1,
				platformName: `mock-pad-${platformIndex + 1}`,
				forceName: "player",
				hasSpaceHub: true,
				// Cycled so the rows show more than one status, which is what makes the row layout's
				// narrow-status case visible (see the flex-shrink note in style.css).
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

// ── Mock ships ──────────────────────────────────────────────────────────────

/**
 * Every transfer phase at once, as ships on the canvas.
 *
 * The statuses are the ones `transfer-motion.ts` maps to a position, listed there against the line in
 * the orchestrator that sets each. Anything not in that map draws no ship, so a status invented here
 * would silently produce nothing — these have to stay in step with PHASES, and the point of drawing
 * them is that a drift becomes visible immediately.
 *
 * Kept OUT of `shipsInFlight` and its expiry bookkeeping by the canvas. Two reasons, the second
 * load-bearing: mock ships should not age out while you are looking at them, and `shipExpiryMs`
 * returns 0 for a terminal transfer never seen live — which would schedule a wake-up 50ms out,
 * every time, forever.
 *
 * Pairs are spread across the available instances so the ships do not all stack on one edge. With
 * only two instances they necessarily share, which is itself an argument for turning on mock
 * instances alongside this.
 */
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

// ── Scenarios: an arbitrary canvas, described in one object ──────────────────

/**
 * A whole canvas, written by hand.
 *
 * This is the thing the console API exists to load. Mock instances answer "what does the layout do
 * with more nodes"; a scenario answers "what does the canvas do with THIS shape" — a hub and spokes,
 * a chain, two disconnected clusters, an instance with twelve platforms and one with none, a
 * transfer mid-validation between two specific nodes. None of those are reachable by turning a
 * number up, and none of them exist on the dev cluster.
 *
 * Instances are addressed by their INDEX in the array (0-based) everywhere else in the scenario, so
 * a scenario is readable and reorderable without bookkeeping ids by hand. They become negative
 * instance ids on the way in, which is what keeps every safety invariant in this file intact: a
 * scenario cannot be saved, cannot link to a real instance, and cannot be exported or transferred.
 */
export type DebugScenario = {
	instances: Array<{
		name?: string;
		host?: string;
		online?: boolean;
		/** Platform names, or richer rows when the status/location matter. */
		platforms?: Array<string | { name?: string; location?: string; status?: string; locked?: boolean }>;
	}>;
	/** Gateway links, as `[fromIndex, toIndex]` pairs. Drawn, never saveable. */
	links?: Array<[number, number]>;
	/** Transfers to draw, as `{ from, to, status }` with instance INDEXES. */
	ships?: Array<{ from: number; to: number; status: string }>;
};

const SCENARIO_HOST = "scenario (debug)";

/** A scenario's instances as a platform tree, with the same negative-id rule as every other mock. */
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

/**
 * A scenario's links as gateway edits.
 *
 * BOTH DIRECTIONS, matching `applyConnect` — a drawn edge is a two-way portal, and a scenario that
 * produced one-way links would render arrowheads the real editor never makes.
 */
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

/** A scenario's transfers as ships. Indexes resolve to the same negative ids as the instances. */
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

// ── The safety partition ────────────────────────────────────────────────────

/**
 * Whether a staged edit key belongs to a mock instance, and so must never be saved.
 *
 * Only the SOURCE is checked, and that is sufficient rather than lazy: `isValidConnection` refuses
 * any link that crosses the mock/real boundary, so a real key can never hold a mock target. The
 * payload check below re-tests both ends at the write itself.
 */
export function isMockEditKey(key: string): boolean {
	const parsed = parseEditKey(key);
	return parsed ? isMockInstanceId(parsed.sourceInstanceId) : false;
}

/** The shape `setGatewayLink` is called with — one instance, its changed gateways, their targets. */
export type GatewaySavePayload = ReadonlyMap<number, ReadonlyArray<{
	gatewayName: string;
	targets: ReadonlyArray<{ targetInstanceId: number; targetGateway: string }>;
}>>;

/**
 * Every mock instance named by the payload that is ABOUT TO BE SENT, as readable reasons.
 *
 * THE INPUT IS THE PAYLOAD, deliberately, and not the list of pending keys. Those keys have already
 * had every mock-sourced one removed by `isMockEditKey`; re-asking that same predicate about that
 * same list is a tautology, and a backstop that cannot fail is not a backstop. The payload is built
 * from them by grouping per instance and mapping each target — steps no filter upstream has looked
 * at — so this is the first place both ends can be tested against what will actually be written.
 *
 * Returns every offender rather than the first: if this ever fires it is a bug report, and knowing
 * whether one link leaked or all of them is the difference between a slip and a broken invariant.
 */
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
