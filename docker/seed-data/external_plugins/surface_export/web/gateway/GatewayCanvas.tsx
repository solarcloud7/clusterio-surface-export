import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Select, Space, Spin, Tooltip, Typography, message as antMessage } from "antd";
import { BugOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import {
	Background,
	ControlButton,
	Controls,
	MarkerType,
	MiniMap,
	Panel,
	ConnectionMode,
	ReactFlow,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import type { Connection, Edge, FitViewOptions, Node } from "@xyflow/react";
import { useAccount } from "@clusterio/web_ui";

// React Flow ships its own stylesheet. `dist/style.css` = the required base styles PLUS the default
// theme; `dist/base.css` would be base only. We take the full sheet and override the parts that
// clash with Clusterio's dark UI in web/style.css, rather than re-implementing node/edge/handle
// geometry ourselves. Loaded by the existing `{ test: /\.css$/ }` webpack rule, which has no
// include/exclude and so already covers node_modules.
import "@xyflow/react/dist/style.css";

import { PERMISSIONS } from "../../messages";
import {
	ALL_HOSTS,
	CAPTION_HEIGHT,
	CAPTION_WIDTH,
	DIMMED_OPACITY,
	NODE_DIAMETER,
	applyConnect,
	applyDisconnect,
	buildGraph,
	dirtyKeys,
	editsFromLinks,
	gatewayFromHandleId,
	instanceIdFromNodeId,
	instanceNodeId,
	parseEditKey,
	platformIndexFromHandleId,
	preservePositions,
	sourceHandleId,
	targetHandleId,
} from "./gateway-graph";
import type { ConnectRequest, GatewayEdits, PlatformLike } from "./gateway-graph";
import { NodeActionsContext, platformActionKey } from "./node-actions";
import DebugPanel from "./DebugPanel";
import {
	GatewayDebugContext,
	isMockEditKey,
	isMockInstanceId,
	loadDebugState,
	mockLeaksInPayload,
	mockShips,
	replayCandidates,
	replayShips,
	saveDebugState,
	scenarioToEdits,
	scenarioToShips,
	scenarioToTree,
	withMockInstances,
} from "./debug-mode";
import type { DebugScenario, DebugState } from "./debug-mode";
import { installCanvasDebugApi } from "./debug-api";
import { applySavedLayout, clearLayout, loadLayout, saveLayout } from "./layout-store";
import { SHIP_LEGEND, instancePairKey, noteLiveSeen, noteTerminalSeen, shipExpiryMs, shipPhaseFor, shipsInFlight, transientEdgeId } from "./transfer-motion";
import { DEFAULT_GATEWAY_MODE, checkMultiModeLink, gatewayNamesFor } from "../../shared/dto";
import type { GatewayMode } from "../../shared/dto";
import { CANVAS_EDGE_TYPES, CANVAS_NODE_TYPES, GATEWAY_EDGE_TYPE } from "./node-types";
import ConnectionLine from "./ConnectionLine";
import TransferModal from "../TransferModal";
import { exportPlatformToDownload } from "../platform-actions";
import type { PlatformActionSource } from "../platform-actions";
import { getErrorMessage, getProp } from "../utils";
import type { JsonObject, SurfaceExportPlugin, SurfaceExportState } from "../view-models";

const { Text } = Typography;

/** A MiniMap dot per instance — every node is one, since the host boxes are gone. */
function miniMapNodeColor(node: Node) {
	return (node.data as { online?: boolean }).online ? "#1668dc" : "#5a5a5a";
}

/**
 * Decode a React Flow connection (or an existing edge) back into instance ids and gateway names.
 *
 * Returns null rather than a half-filled request when any part fails to parse: every id here was
 * built by gateway-graph.ts next door, so a miss means something changed shape, and staging a link with a
 * NaN instance id would send the controller a write we cannot describe.
 */
function toConnectRequest(link: Connection | Edge): ConnectRequest | null {
	const sourceInstanceId = instanceIdFromNodeId(link.source);
	const targetInstanceId = instanceIdFromNodeId(link.target);
	const sourceGateway = gatewayFromHandleId(link.sourceHandle);
	const targetGateway = gatewayFromHandleId(link.targetHandle);
	if (sourceInstanceId == null || targetInstanceId == null || !sourceGateway || !targetGateway) {
		return null;
	}
	return { sourceInstanceId, sourceGateway, targetInstanceId, targetGateway };
}

/**
 * Multi Cluster's two rules, checked against the state a connection would PRODUCE.
 *
 * Pulled out of the `setEdits` updater it used to live inside. An updater must be pure — React
 * StrictMode runs it twice in development — and this one raised an antd message from in there, so a
 * refusal could be announced twice for one gesture. Returning the reason instead lets the caller
 * decide once, before it touches state at all.
 *
 * BOTH ENDS are checked because a drawn edge writes both directions: a link that is legal outbound
 * can still be illegal inbound, and staging half of it would leave a pending change that can never
 * save.
 */
function multiModeViolation(edits: GatewayEdits, request: ConnectRequest): string | null {
	for (const end of [
		{ instanceId: request.sourceInstanceId, gateway: request.sourceGateway,
			link: { targetInstanceId: request.targetInstanceId, targetGateway: request.targetGateway } },
		{ instanceId: request.targetInstanceId, gateway: request.targetGateway,
			link: { targetInstanceId: request.sourceInstanceId, targetGateway: request.sourceGateway } },
	]) {
		const others = new Map<string, Array<{ targetInstanceId: number; targetGateway: string }>>();
		for (const [key, targets] of Object.entries(edits)) {
			const parsed = parseEditKey(key);
			if (parsed && parsed.sourceInstanceId === end.instanceId && parsed.gatewayName !== end.gateway && targets.length) {
				others.set(parsed.gatewayName, targets);
			}
		}
		const existing = edits[`${end.instanceId}:${end.gateway}`] || [];
		const violation = checkMultiModeLink(end.gateway, [...existing, end.link], others);
		if (violation) {
			return violation;
		}
	}
	return null;
}

/**
 * Gateway links, as the graph they actually are.
 *
 * Edits stage locally and flush on Save, matching what the form tab did. The model is the edits map
 * (keyed as the controller keys its config); nodes and edges are a projection of it, so there is no
 * second source of truth to reconcile. Everything with a decision in it lives in
 * gateway-graph.ts next door; this file is the wiring.
 */
export default function GatewayCanvas({ plugin, state, onOpenImport }: {
	plugin: SurfaceExportPlugin;
	state: SurfaceExportState;
	/** Opens the page's ONE ImportModal. Mounting a second copy here would leave two live modals. */
	onOpenImport: () => void;
}) {
	const account = useAccount();
	// Reads need UI_VIEW; every mutation needs TRANSFER_EXPORTS. The web UI never checked this before,
	// so a view-only user got buttons that failed server-side — on a canvas that would be an edge that
	// silently snapped back on save. One flag covers it because all four mutations share a permission.
	//
	// `=== true` rather than a truthiness coercion because hasPermission is typed `boolean | null`:
	// null means the answer is not known yet, and an unknown permission must read as "cannot edit".
	// Offering the handles first and finding out on save is exactly the failure this closes.
	const canEdit = account.hasPermission(PERMISSIONS.TRANSFER_EXPORTS) === true;

	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [edits, setEdits] = useState<GatewayEdits>({});
	// The controller owns the mode; the canvas is told which one is active on load rather than
	// reading a setting it cannot see.
	const [mode, setMode] = useState<GatewayMode>(DEFAULT_GATEWAY_MODE);
	// What the controller last told us. Every dirty check is against this, so a reload after a save
	// is not required to clear the pending count.
	const [baseline, setBaseline] = useState<GatewayEdits>({});
	// Which host to FOCUS. Dims the rest rather than hiding them — see buildGraph.
	const [hostFilter, setHostFilter] = useState<string>(ALL_HOSTS);
	// The platform to transfer AND the destination the gesture already named, held together so the
	// dialog's "forget the last platform's choices" reset cannot clear one without the other.
	// `presetTargetInstanceId` is null when the request came from a row's button, which chose no
	// destination, and set when it came from a drag onto another instance's portal, which did.
	const [transfer, setTransfer] = useState<
		{ source: PlatformActionSource; presetTargetInstanceId: number | null } | null
	>(null);
	const [exportingKey, setExportingKey] = useState<string | null>(null);
	// Read once at mount (the URL parameter is only meaningful on the way in), then owned by the panel.
	const [debug, setDebugState] = useState<DebugState>(loadDebugState);
	const setDebug = useCallback((next: DebugState) => {
		setDebugState(next);
		saveDebugState(next);
	}, []);
	// A loaded scenario REPLACES the live cluster on this canvas. Deliberately not persisted: a
	// scenario is something you are looking at right now, and a reload silently restoring a synthetic
	// cluster would be indistinguishable from the real one having gone strange.
	const [scenario, setScenario] = useState<DebugScenario | null>(null);

	/**
	 * A LOADED SCENARIO DOES NOT RE-FRAME THE VIEW — press Reset, or the fit control, to frame it.
	 *
	 * Not an oversight; an attempt was measured and removed. Bumping the fit request when a scenario
	 * loads DOES fire a fitView — the viewport translates — but it keeps zoom at 1 and so leaves a
	 * tall scenario hanging off the pane, because React Flow needs the new nodes MEASURED before it
	 * can compute a zoom, and they are not measured yet at that point. Measured: viewport went
	 * `scale(1) translate(392)` -> `scale(1) translate(532)` on load, and `scale(0.543)` when the fit
	 * control was pressed two seconds later.
	 *
	 * A half-working re-fit that moves the view without framing it is worse than none, so the canvas
	 * does nothing and `canvas-shot.mjs` fits explicitly once everything has settled. Doing it in-app
	 * needs to wait for measurement rather than for paint — the same timing family as the handle
	 * bounds that broke the platform drag.
	 */

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

	// Read ONCE, into a ref: the saved layout is a starting position, not a live input. Re-reading it
	// on every rebuild would let a stale copy fight `preservePositions` for a node being dragged.
	const savedLayout = useRef(loadLayout());
	// Captured from onInit because this component RENDERS <ReactFlow> rather than sitting inside it,
	// so `useReactFlow()` has no provider to read here.
	const flow = useRef<{
		// `padding` matches React Flow's own `Padding`: a bare number is a fraction of the viewport, a
		// `<n>px` string is screen pixels, and the per-side object mixes them. We pass the object form,
		// because the thing being cleared (the caption above, the platform list below and to the sides)
		// is a different size on every side.
		fitView: (options?: FitViewOptions) => void;
		setCenter?: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
	} | null>(null);
	const [fitRequest, setFitRequest] = useState(0);


	/**
	 * Node positions save THEMSELVES, on drop.
	 *
	 * Deliberately not routed through the Save button. That button exists for changes that alter what
	 * the cluster can DO — a gateway link lets a platform fly somewhere it previously could not — and
	 * it earns its pending count and its Revert. Where a node sits alters nothing but the picture, so
	 * asking for confirmation would be ceremony, and counting it as an "unsaved change" would make
	 * that number mean two incomparable things at once.
	 *
	 * On drop rather than during the drag: one write per gesture instead of one per frame.
	 */

	const onNodeDragStop = useCallback(() => {
		setNodes(current => {
			saveLayout(current);
			savedLayout.current = Object.fromEntries(current.map(node => [node.id, { ...node.position }]));
			return current;
		});
	}, [setNodes]);

	const tree = state?.tree;

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const response = (await plugin.getGateways()) as JsonObject;
			const loaded = editsFromLinks(getProp(response, "links", []) as never);
			setEdits(loaded);
			setBaseline(loaded);
			setMode(getProp(response, "gatewayMode", DEFAULT_GATEWAY_MODE) as GatewayMode);
			setLoadError(null);
		} catch (err: unknown) {
			const messageText = getErrorMessage(err, "Failed to load gateways");
			setLoadError(messageText);
			antMessage.error(messageText, 8);
		} finally {
			setLoading(false);
		}
	}, [plugin]);

	useEffect(() => { void load(); }, [load]);

	// A scenario REPLACES the tree; mock instances APPEND to it. Both are injected upstream of
	// buildGraph so they go through exactly the same projection, layout and rendering a real instance
	// does — a mock that took a shortcut would be exercising the shortcut.
	const effectiveTree = useMemo(
		() => (scenario ? scenarioToTree(scenario) : withMockInstances(tree, debug)),
		[scenario, tree, debug],
	);

	/**
	 * A scenario's links, kept OUT of `edits` entirely.
	 *
	 * They are merged only here, at the projection, so they are drawn without ever being staged. The
	 * mock-id filter would have caught them at the save anyway, but that would have made them show up
	 * as changes to revert — and a scenario is a picture, not an edit someone made.
	 */
	const scenarioEdits = useMemo(
		() => (scenario ? scenarioToEdits(scenario, gatewayNamesFor(mode)[0]) : null),
		[scenario, mode],
	);
	// A scenario's links REPLACE the cluster's, they do not merge with them. Merging left the real
	// cluster's links in the graph with their nodes gone — React Flow silently dropped the edges, so
	// nothing looked wrong, but every count derived from the graph was one too high. "Replace" has to
	// be total or it is just a confusing overlay.
	const graph = useMemo(
		() => buildGraph(effectiveTree, scenarioEdits ?? edits, mode, hostFilter),
		[effectiveTree, edits, scenarioEdits, mode, hostFilter],
	);

	/**
	 * EVERY staged change, mock or not. This is what Revert acts on.
	 *
	 * Kept separate from `pending` because the two answer different questions. Revert asks "is there
	 * anything to undo", and a mock link IS something to undo — an operator who drew one between two
	 * mock instances must be able to clear it. Gating Revert on `pending` left mock edits with no way
	 * out at all.
	 */
	const allDirty = useMemo(() => dirtyKeys(edits, baseline), [edits, baseline]);

	// MOCK EDITS ARE NOT PENDING CHANGES. Dropping them here means they are never counted, never
	// enable Save, and never reach the write — the whole partition rests on `isValidConnection`
	// refusing mock<->real links, so a surviving key is wholly-real. `save` re-checks anyway.
	const pending = useMemo(() => allDirty.filter(key => !isMockEditKey(key)), [allDirty]);
	const mockCount = useMemo(
		() => graph.nodes.filter(node => isMockInstanceId(node.data.instanceId as number)).length,
		[graph],
	);

	/**
	 * Framing that accounts for what hangs OUTSIDE the node boxes.
	 *
	 * `fitView` frames `position + measured`, and measured is deliberately just the 150px circle — the
	 * caption is absolutely positioned so it cannot drag the node's centre around (see
	 * PlatformRows.tsx for the same trick and why it matters). The cost is that fitView cannot see the
	 * caption either, and it framed the circles with the overhanging parts off the pane. Measured on
	 * this cluster at 59px, at the zoom fitView chose.
	 *
	 * PADDING IS IN SCREEN PIXELS but the overhang is in FLOW pixels, and those two only agree at
	 * zoom 1 — which is why the zoom is pinned rather than the padding merely being made generous. A
	 * proportional padding would have to be sized for the worst zoom and would waste the viewport at
	 * every other one.
	 *
	 * SIZED FOR THE CAPTION ONLY. The platform list overhangs further, but it opens on click and hides
	 * itself again — framing every load around a strip that is almost never drawn zoomed the whole
	 * canvas out permanently. An open list near the pane edge can sit partly off-screen; it is
	 * transient, and panning or moving the node fixes it.
	 */
	const fitViewOptions = useMemo((): FitViewOptions => {
		const breathingRoom = 12;
		// The return annotation is what holds these to React Flow's `${number}px` literal type instead
		// of letting them widen to plain `string`, which the option does not accept.
		const px = (value: number): `${number}px` => `${Math.round(value)}px`;
		return {
			maxZoom: 1,
			padding: {
				x: px((CAPTION_WIDTH - NODE_DIAMETER) / 2 + breathingRoom),
				top: px(CAPTION_HEIGHT + breathingRoom),
				bottom: px(breathingRoom),
			},
		};
	}, []);

	// Deps are `fitRequest` ALONE, deliberately: this fires when something ASKS to be re-framed, not
	// whenever the framing options change — the graph is rebuilt on every platform status push, and
	// listing the options here would yank the viewport back roughly once a second. It still reads the
	// current options, because React invokes the callback from the render whose deps changed.
	useEffect(() => {
		if (fitRequest) {
			// The SAME options the initial fit uses. Reset means "frame everything", and framing it
			// differently from how the canvas opens would be two answers to one question.
			flow.current?.fitView({ ...fitViewOptions, duration: 300 });
		}
	}, [fitRequest]);

	/**
	 * Put every node back on the computed layout and frame them all.
	 *
	 * Both halves are needed and neither is enough alone: forgetting the saved positions without
	 * re-fitting leaves the viewport wherever it was, and fitting without forgetting re-frames the
	 * same scattered arrangement. `setNodes([])` forces the graph effect to rebuild from scratch —
	 * `preservePositions` would otherwise keep the very positions we are discarding.
	 */
	const resetLayout = useCallback(() => {
		clearLayout();
		savedLayout.current = {};
		// Straight to the computed layout rather than clearing and waiting for the next tree push,
		// which would blank the canvas for up to a second.
		setNodes(graph.nodes as unknown as Node[]);
		// The frame has to happen AFTER those positions commit, so it is requested here and performed
		// in an effect rather than called inline against stale node state.
		setFitRequest(request => request + 1);
	}, [graph, setNodes]);

	/**
	 * Centre the view on one instance and select it.
	 *
	 * Selecting rather than only panning, because selection is what opens that node's platform
	 * toolbar — so finding an instance and acting on it are the same gesture rather than two.
	 */
	const focusNode = useCallback((nodeId: string) => {
		setNodes(current => current.map(node => ({ ...node, selected: node.id === nodeId })));
		const target = nodes.find(node => node.id === nodeId);
		if (target) {
			flow.current?.setCenter?.(
				target.position.x + NODE_DIAMETER / 2,
				target.position.y + NODE_DIAMETER / 2,
				{ zoom: 1.2, duration: 400 },
			);
		}
	}, [nodes, setNodes]);

	/**
	 * The transfers currently worth drawing a ship for.
	 *
	 * `shipClock` exists because a FINISHED transfer has to leave the canvas on a timer rather than on
	 * an event — nothing else is coming for it. It is bumped by a single timeout scheduled for the
	 * next expiry, NOT by a polling interval: an interval would re-render every node forever to
	 * service a case that is usually empty.
	 */
	const [shipClock, setShipClock] = useState(() => Date.now());
	const realShips = useMemo(
		() => shipsInFlight(state?.transferSummaries, shipClock),
		[state?.transferSummaries, shipClock],
	);

	/**
	 * Real ships plus, in debug mode, one fake per phase.
	 *
	 * The fakes join AFTER `shipsInFlight`, never through it, and that is not tidiness. Every fake is
	 * a TERMINAL status that was never seen live, and `shipExpiryMs` returns 0 for exactly that case —
	 * so a fake inside the expiry bookkeeping below would compute a deadline already past, schedule a
	 * wake-up 50ms out, and do it again on every re-render, forever.
	 */
	const ships = useMemo(() => {
		// A scenario names its own transfers and REPLACES the live ones — the whole point of writing one
		// is to say exactly which journeys are in flight, and a real transfer riding in alongside would
		// be a journey between instances the scenario says do not exist.
		if (scenario) {
			return scenarioToShips(scenario);
		}
		if (!debug.enabled) {
			return realShips;
		}
		const instanceIds = graph.nodes
			.map(node => instanceIdFromNodeId(node.id))
			.filter((id): id is number => id !== null);
		// REPLAYED transfers are real summaries, passed through untouched — the endpoints, the status
		// and the id are the controller's. They are listed BEFORE the synthetic ones so that when both
		// are on, a real transfer wins the per-edge claim in the assignment below: the whole point of
		// replay is to look at the real thing, and a fake sitting on the edge you came to inspect
		// would defeat it. Deduped against `realShips` so a transfer that is BOTH live and named for
		// replay is not drawn twice.
		const replayed = replayShips(state?.transferSummaries, debug.replayTransferIds)
			.filter(ship => !realShips.some(live => live.transferId === ship.transferId));
		return [...replayed, ...realShips, ...mockShips(instanceIds, debug.shipPhases)];
	}, [realShips, debug.enabled, debug.shipPhases, debug.replayTransferIds, state?.transferSummaries, scenario, graph]);

	useEffect(() => {
		// REAL ships only — see the memo above for why a fake must not be timed, and note that letting
		// one into `shipMemory` would also evict a real entry from a 32-slot cache.
		const now = Date.now();
		for (const ship of realShips) {
			if (shipPhaseFor(ship.status)?.terminal) {
				// Stamp "we have now seen this one finish" BEFORE reading the deadlines, so a transfer
				// that went terminal this render gets its full linger window rather than one derived from
				// a wire timestamp that may be missing. Writing it here, not in the filter, keeps render
				// pure.
				noteTerminalSeen(ship.transferId, now);
			} else {
				// Seen in flight — this is what earns it an arrival animation later, and what keeps the
				// transaction log's history off the canvas.
				noteLiveSeen(ship.transferId);
			}
		}
		const expiries = realShips.map(ship => shipExpiryMs(ship, now)).filter((at): at is number => at !== null);
		if (!expiries.length) {
			return undefined;
		}
		// +50ms so the wake-up lands after the expiry rather than exactly on it, where a re-run would
		// compute the same deadline again and schedule a zero-length timeout.
		const wakeIn = Math.max(0, Math.min(...expiries) - Date.now()) + 50;
		const timer = setTimeout(() => setShipClock(Date.now()), wakeIn);
		return () => clearTimeout(timer);
	}, [realShips]);

	useEffect(() => {
		// preservePositions keeps the user's drags and selection across this rebuild. The tree is
		// re-pushed on every platform status change, so without it a node would snap back to its
		// layout position roughly once a second. The saved layout is applied UNDER it: a node moved
		// this session keeps its live position, and one appearing for the first time starts where it
		// was last left.
		setNodes(previous => preservePositions(
			previous,
			applySavedLayout(graph.nodes as unknown as Node[], savedLayout.current),
		));
		setEdges(previous => {
			const selected = new Set(previous.filter(edge => edge.selected).map(edge => edge.id));
			// Which instances the host filter is focused on, taken from the SAME `dimmed` boolean
			// buildGraph used for the node styles. Deriving it from the rendered opacity instead would
			// be a second representation of one fact — and a falsy opacity would read as "focused".
			const focused = new Set(
				graph.nodes.filter(node => !node.data.dimmed).map(node => instanceIdFromNodeId(node.id)),
			);
			const drawn = new Set(graph.nodes.map(node => node.id));
			const dimStyle = (a: number, b: number) => (
				// Dimmed only when NEITHER end is in focus. A link that leaves the focused host is part of
				// what the operator asked to look at, even though it lands somewhere faded.
				focused.has(a) || focused.has(b) ? undefined : { opacity: DIMMED_OPACITY }
			);

			// Each ship rides EXACTLY ONE edge. Multi mode can legitimately hold two gateway links
			// between the same pair of instances, and a transfer names instances rather than a gateway —
			// so without claiming one edge per ship, one transfer would be drawn as two. Edges arrive
			// sorted by id, which makes "the first match" a stable choice rather than an arbitrary one.
			const unassigned = new Map(ships.map(ship => [ship.transferId, ship]));
			const shipFor = (a: number, b: number) => {
				const wanted = instancePairKey(a, b);
				for (const [transferId, ship] of unassigned) {
					if (instancePairKey(ship.sourceInstanceId, ship.targetInstanceId) === wanted) {
						unassigned.delete(transferId);
						return ship;
					}
				}
				return null;
			};

			const edges: Edge[] = graph.edges.map(edge => {
				const ship = shipFor(edge.sourceInstanceId, edge.targetInstanceId);
				return {
					id: edge.id,
					source: edge.source,
					sourceHandle: edge.sourceHandle,
					target: edge.target,
					targetHandle: edge.targetHandle,
					type: GATEWAY_EDGE_TYPE,
					selected: selected.has(edge.id),
					style: dimStyle(edge.sourceInstanceId, edge.targetInstanceId),
					// Direction is drawn, not implied. A config link may be one-way, and an edge that could
					// only say "connected" would render that as a two-way portal.
					markerEnd: edge.forward ? { type: MarkerType.ArrowClosed } : undefined,
					markerStart: edge.reverse ? { type: MarkerType.ArrowClosed } : undefined,
					data: {
						forward: edge.forward,
						reverse: edge.reverse,
						sourceGateway: edge.sourceGateway,
						transfer: ship || undefined,
						// The edge is drawn in ONE canonical orientation, which has nothing to do with which
						// way this transfer runs.
						transferReversed: Boolean(ship && ship.sourceInstanceId !== edge.sourceInstanceId),
					},
				};
			});

			// A transfer between two instances with NO gateway link still has to be visible — the node
			// toolbar's Transfer button can target any instance. Its edge exists only while it is in
			// flight, is dashed so it never reads as configuration, and lives in its own id namespace so
			// it can never collide with (and silently replace) a real link.
			// Every handle on these nodes carries an explicit id, so there is no null-id handle for React
			// Flow to fall back to — an edge that names none cannot be resolved to an endpoint and is
			// DROPPED, silently, with no error anywhere. Measured: the transient edge produced zero
			// `.react-flow__edge` elements through a whole live transfer whose data was correct at every
			// other step. A transfer names no gateway, so the anchor is the active mode's first one; it
			// is presentation only, since FloatingEdge takes its geometry from the node circles.
			const anchorGateway = gatewayNamesFor(mode)[0];
			for (const ship of unassigned.values()) {
				const source = instanceNodeId(ship.sourceInstanceId);
				const target = instanceNodeId(ship.targetInstanceId);
				if (!drawn.has(source) || !drawn.has(target)) {
					continue;
				}
				edges.push({
					id: transientEdgeId(ship.transferId),
					source,
					sourceHandle: sourceHandleId(anchorGateway),
					target,
					targetHandle: targetHandleId(anchorGateway),
					type: GATEWAY_EDGE_TYPE,
					style: { ...dimStyle(ship.sourceInstanceId, ship.targetInstanceId), strokeDasharray: "6 4" },
					markerEnd: { type: MarkerType.ArrowClosed },
					data: { transient: true, transfer: ship, transferReversed: false },
				});
			}
			return edges;
		});
	}, [graph, ships, mode, setNodes, setEdges]);

	/**
	 * Export and Transfer, offered per platform from a selected node's toolbar.
	 *
	 * The export flow itself lives in web/platform-actions.ts, shared with the Manual Transfer table:
	 * two implementations of "export a platform" would be two filename conventions and two error
	 * messages waiting to drift. All this owns is the button's spinner.
	 */
	const nodeActions = useMemo(() => ({
		exportingKey,
		onExport: (source: PlatformActionSource) => {
			setExportingKey(platformActionKey(source.instanceId, source.platformIndex));
			void exportPlatformToDownload(plugin, source).finally(() => setExportingKey(null));
		},
		onTransfer: (source: PlatformActionSource, presetTargetInstanceId: number | null) =>
			setTransfer({ source, presetTargetInstanceId }),
	}), [exportingKey, plugin]);

	// A host that has left the tree since it was picked must not leave the filter stuck on a value
	// nothing matches. buildGraph already dims nothing in that case; this keeps the control agreeing
	// with what is drawn instead of showing a selection that has no effect.
	const effectiveHostFilter = graph.hosts.some(host => host.key === hostFilter) ? hostFilter : ALL_HOSTS;

	/**
	 * Which platform a `p:` handle refers to, from the node it lives on.
	 *
	 * Read out of the graph rather than out of the handle id: the id carries only an index, because a
	 * handle id has to be stable and a platform's NAME is not — it is user-editable and can collide
	 * across a force. The index identifies it; everything else comes from the node that owns it.
	 */
	const platformFromHandle = useCallback((nodeId: string | null | undefined, handleId: string | null | undefined) => {
		const platformIndex = platformIndexFromHandleId(handleId);
		const instanceId = instanceIdFromNodeId(nodeId);
		if (platformIndex == null || instanceId == null) {
			return null;
		}
		const node = graph.nodes.find(candidate => candidate.id === nodeId);
		if (!node) {
			return null;
		}
		const platforms = (node.data.platforms || []) as PlatformLike[];
		const platform = platforms.find(candidate => candidate.platformIndex === platformIndex);
		return platform ? { platform, instanceId, instanceName: String(node.data.instanceName || "") } : null;
	}, [graph]);

	/**
	 * Refuse illegal drags DURING the drag, rather than explaining them afterwards.
	 *
	 * This is also the only reliable place to reason about which end is which. `ConnectionMode.Loose`
	 * lets React Flow swap `source` and `target` when a drag starts from a target-type handle, so a
	 * rule written as "refuse gateway→platform" inside `onConnect` may fire on a combination the
	 * operator never performed — or never fire at all. Deciding here means `onConnect` only ever sees
	 * pairings that have already been sanctioned, and the operator gets the red/green cursor while
	 * they are still holding the mouse down.
	 */
	const isValidConnection = useCallback((link: Connection | Edge) => {
		const sourceInstanceId = instanceIdFromNodeId(link.source);
		const targetInstanceId = instanceIdFromNodeId(link.target);
		if (sourceInstanceId == null || targetInstanceId == null || sourceInstanceId === targetInstanceId) {
			// Self-links are meaningless in both directions: an instance cannot gateway to itself, and a
			// platform cannot transfer to the instance it is already on.
			return false;
		}
		// MOCK AND REAL MAY NEVER LINK, and this is the invariant the whole debug-mode safety story
		// rests on. It makes every staged edit wholly-mock or wholly-real, so dropping the mock ones is
		// a clean partition — without it, a real->mock link would leave a REAL key holding a mock
		// target, which is a save that writes a negative instance id into the cluster's gateway config.
		// Mocks still link freely to each other, which is all a layout needs to be exercised.
		if (isMockInstanceId(sourceInstanceId) !== isMockInstanceId(targetInstanceId)) {
			return false;
		}
		const sourceIsPlatform = platformIndexFromHandleId(link.sourceHandle) != null;
		const targetIsPlatform = platformIndexFromHandleId(link.targetHandle) != null;
		if (targetIsPlatform) {
			// A platform is a thing you SEND, never a place you send something to — neither a gateway
			// link nor another platform may land on one.
			return false;
		}
		if (sourceIsPlatform) {
			// Platform -> another instance's gateway: a transfer. Legal as long as the far end really is
			// a gateway handle.
			return gatewayFromHandleId(link.targetHandle) != null;
		}
		return gatewayFromHandleId(link.sourceHandle) != null && gatewayFromHandleId(link.targetHandle) != null;
	}, []);

	const onConnect = useCallback((connection: Connection) => {
		// A DRAG FROM A PLATFORM ROW IS A TRANSFER, not a link. It opens the same dialog the row's
		// button opens, with the instance it was dropped on already chosen — the gesture named a
		// destination, so asking for one again would throw away what it said. Nothing is started here:
		// the dialog still has to be confirmed, because a transfer is not undoable the way a staged
		// link is.
		const dragged = platformFromHandle(connection.source, connection.sourceHandle);
		if (dragged) {
			const targetInstanceId = instanceIdFromNodeId(connection.target);
			if (targetInstanceId == null) {
				antMessage.error("Could not read the destination — no transfer was started.", 6);
				return;
			}
			// THE TARGET HANDLE IS CHECKED HERE TOO, not only in isValidConnection. A drag that landed
			// on another PLATFORM row names an instance perfectly well, so without this the dialog would
			// open offering a real, sendable transfer for a gesture that meant nothing of the kind —
			// the destination is a platform, and platforms do not receive platforms. Defending at the
			// point that acts rather than only at the point that previews, because `isValidConnection`
			// is React Flow's to call and Loose mode decides which end is "source" after the fact.
			if (platformIndexFromHandleId(connection.targetHandle) != null) {
				antMessage.warning("Drop a platform on another instance's PORTAL, not on one of its platforms.", 5);
				return;
			}
			if (dragged.instanceId === targetInstanceId) {
				antMessage.warning("A platform cannot transfer to the instance it is already on.", 4);
				return;
			}
			setTransfer({
				source: {
					instanceId: dragged.instanceId,
					instanceName: dragged.instanceName,
					platformIndex: dragged.platform.platformIndex,
					platformName: dragged.platform.platformName,
					forceName: dragged.platform.forceName || "player",
				},
				presetTargetInstanceId: targetInstanceId,
			});
			return;
		}

		const request = toConnectRequest(connection);
		if (!request) {
			antMessage.error("Could not read that connection — nothing was staged.", 6);
			return;
		}
		if (request.sourceInstanceId === request.targetInstanceId) {
			antMessage.warning("An instance cannot gateway to itself.", 4);
			return;
		}
		// Multi Cluster's rules. The controller enforces them too — it has to, since the canvas is only
		// one caller — but refusing here means the operator sees why the moment they draw, instead of
		// watching an edge appear and then vanish on save. Checked BEFORE `setEdits` so the refusal is
		// announced once: an updater runs twice under StrictMode, and this used to raise its message
		// from inside one.
		if (mode === "multi") {
			const violation = multiModeViolation(edits, request);
			if (violation) {
				antMessage.warning(violation, 6);
				return;
			}
		}
		// Stages BOTH directions: a drawn edge is a two-way portal (owner ruling). Nothing is sent
		// until Save, so the two writes are reviewable as a pending count first.
		setEdits(previous => applyConnect(previous, request));
	}, [edits, mode, platformFromHandle]);

	/**
	 * Clicking an edge REMOVES the link, in both directions.
	 *
	 * Safe to make a single click because nothing is sent until Save: a mis-click costs a Revert,
	 * not a gateway. Select-then-Delete still works too — this is the discoverable path, not the
	 * only one.
	 */
	const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
		if (!canEdit) {
			return;
		}
		// A transient edge is a transfer in flight, not a link — there is nothing to unlink, and
		// falling through would report "could not read that edge" for an edge that is behaving
		// exactly as designed.
		if (edge.data?.transient) {
			return;
		}
		const request = toConnectRequest(edge);
		if (!request) {
			antMessage.error("Could not read that edge — nothing was removed.", 6);
			return;
		}
		setEdits(previous => applyDisconnect(previous, request));
	}, [canEdit]);

	const onEdgesDelete = useCallback((deleted: Edge[]) => {
		setEdits(previous => deleted.filter(edge => !edge.data?.transient).reduce((acc, edge) => {
			const request = toConnectRequest(edge);
			return request ? applyDisconnect(acc, request) : acc;
		}, previous));
	}, []);

	const save = useCallback(async () => {
		setSaving(true);
		const failures: string[] = [];
		/** Saved, but the running instance did not take it — see where this is pushed. */
		const warnings: string[] = [];
		try {
			// ONE CALL PER INSTANCE, carrying every changed gateway on it. Not one call per gateway:
			// Multi mode's "no two gates at the same destination" rule is about an instance's whole
			// layout, so splitting the save let the controller judge half-applied states — a swap was
			// refused on both halves forever, and a move from one gate to another deleted the link.
			// Grouping here makes the unit of saving the same as the unit of validation.
			//
			// Sequential across instances so a partial failure leaves a comprehensible trail.
			const byInstance = new Map<number, Array<{ gatewayName: string; targets: Array<{ targetInstanceId: number; targetGateway: string }> }>>();
			for (const key of pending) {
				const parsed = parseEditKey(key);
				if (!parsed) {
					failures.push(`${key}: unreadable key`);
					continue;
				}
				const group = byInstance.get(parsed.sourceInstanceId) || [];
				group.push({
					gatewayName: parsed.gatewayName,
					targets: (edits[key] || []).map(target => ({
						targetInstanceId: Number(target.targetInstanceId),
						targetGateway: target.targetGateway || parsed.gatewayName,
					})),
				});
				byInstance.set(parsed.sourceInstanceId, group);
			}

			// THE LAST CHECK, on the PAYLOAD about to go on the wire — see mockLeaksInPayload for why
			// the payload and not the key list. Refuses the whole save rather than stripping the
			// offender: a save that quietly wrote less than it was asked to is how a gateway becomes
			// disabled with nobody seeing it.
			const leaks = mockLeaksInPayload(byInstance);
			if (leaks.length) {
				antMessage.error(
					`Refusing to save: ${leaks.join("; ")} names a mock instance. `
					+ "This is a bug — no gateway config was written.",
					15,
				);
				return;
			}

			for (const [sourceInstanceId, gateways] of byInstance) {
				const label = gateways.map(entry => entry.gatewayName).join(", ");
				try {
					const response = (await plugin.setGatewayLink({ sourceInstanceId, gateways })) as JsonObject;
					const reason = String(getProp(response, "error", "") || "");
					if (!getProp(response, "success", false)) {
						failures.push(`${label}: ${reason || "save failed"}`);
					} else if (reason) {
						// SUCCESS CAN STILL CARRY A WARNING, and reading `error` only on failure threw
						// away the one case the controller added it for: the config is persisted but the
						// running instance REJECTED it (an oversized /sc, an RCON failure), so it is still
						// serving the previous gateway layout. That is `{ success: true, error: "Saved,
						// but instance N is still running the previous gateway config" }`. Treating a
						// truthy `error` as absent turned that into a green "Saved 1 gateway." while a
						// platform parked at that gate would still fly to the old destination.
						warnings.push(reason);
					}
				} catch (err: unknown) {
					failures.push(`${label}: ${getErrorMessage(err, "save failed")}`);
				}
			}

			if (failures.length) {
				// Deliberately NOT re-baselining on partial failure: the canvas must keep showing the
				// edits that did not land, or the operator sees a clean board and believes it saved.
				antMessage.error(`${failures.length} of ${pending.length} failed — ${failures.join("; ")}`, 12);
				return;
			}
			// MOCK KEYS ARE LEFT OUT OF THE NEW BASELINE. A save says "the controller now holds this",
			// which is true of every real key and of no mock one — adopting them would make a mock link
			// permanently clean, and since it is also permanently unsaveable, there would be nothing
			// left that could clear it: Revert compares against the baseline, and the baseline would
			// already agree. Keeping them out leaves them dirty, so Revert stays available.
			setBaseline(Object.fromEntries(
				Object.entries(edits).filter(([key]) => !isMockEditKey(key)),
			));
			if (warnings.length) {
				// Re-baselined deliberately: the config IS saved, so the board is genuinely clean and a
				// retry would change nothing. What is not true is that the cluster is running it, and
				// that is what this says — held on screen far longer than the success toast, because it
				// is the one an operator must not miss.
				antMessage.warning(warnings.join("; "), 15);
				return;
			}
			antMessage.success(`Saved ${pending.length} gateway${pending.length === 1 ? "" : "s"}.`, 4);
		} finally {
			setSaving(false);
		}
	}, [edits, pending, plugin]);

	const revert = useCallback(() => setEdits(baseline), [baseline]);

	/**
	 * `window.surfaceExportCanvas`, live for as long as this tab is mounted.
	 *
	 * The refs are what keep the API honest: it is installed once, but every command reads the CURRENT
	 * state through them. Installing it with the state captured would give a console that reports
	 * whatever was true when the page loaded and silently overwrites anything changed since.
	 */
	const liveRef = useRef({ debug, scenario, graph, mode, summaries: state?.transferSummaries });
	liveRef.current = { debug, scenario, graph, mode, summaries: state?.transferSummaries };
	useEffect(() => installCanvasDebugApi({
		getState: () => liveRef.current.debug,
		setState: setDebug,
		getScenario: () => liveRef.current.scenario,
		setScenario,
		getReplayCandidates: () => replayCandidates(liveRef.current.summaries),
		describe: () => {
			const { debug: state, scenario: loaded, graph: current } = liveRef.current;
			return {
				source: loaded ? "scenario" : "live cluster",
				instances: current.nodes.length,
				mockInstances: current.nodes.filter(n => isMockInstanceId(n.data.instanceId as number)).length,
				platforms: current.nodes.reduce((n, node) => n + ((node.data.platforms as unknown[]) || []).length, 0),
				links: current.edges.length,
				debugMode: state.enabled,
				shipPhases: state.shipPhases,
				replaying: state.replayTransferIds.length,
				geometry: state.showGeometry,
			};
		},
	}), [setDebug]);

	if (loading && !nodes.length) {
		return <Spin style={{ margin: "24px auto", display: "block" }} />;
	}

	return (
		<NodeActionsContext.Provider value={nodeActions}>
		<GatewayDebugContext.Provider value={{ showGeometry: debug.enabled && debug.showGeometry }}>
		<div className="surface-export-canvas">
			{loadError ? <Alert type="error" showIcon message={loadError} style={{ marginBottom: 8 }} /> : null}
			{!loading && !nodes.length ? (
				<Empty description="No instances available — gateways can't be shown until the platform tree loads." />
			) : (
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					isValidConnection={isValidConnection}
					onEdgesDelete={onEdgesDelete}
					onEdgeClick={onEdgeClick}
					onNodeDragStop={onNodeDragStop}
					// This component renders <ReactFlow>, so it is outside the provider `useReactFlow()`
					// needs; onInit is the supported way to get the instance from here.
					onInit={instance => { flow.current = instance as unknown as typeof flow.current; }}
					nodeTypes={CANVAS_NODE_TYPES}
					edgeTypes={CANVAS_EDGE_TYPES}
					connectionLineComponent={ConnectionLine}
					// Loose lets a drag END on a source-type handle. Each gateway stacks a source and a
					// target handle at one point, and Strict would refuse the drop whenever the pointer
					// landed on the source of the pair — a coin flip the operator cannot see or aim around.
					connectionMode={ConnectionMode.Loose}
					nodesConnectable={canEdit}
					edgesFocusable={canEdit}
					elementsSelectable
					// A NODE IS AN INSTANCE. The canvas has no business deleting one, and letting React
					// Flow try was a link-destroying trap: selecting a node and pressing Backspace
					// cascaded into `onEdgesDelete` for every edge touching it, which staged
					// applyDisconnect on each. MEASURED on the live canvas — one keystroke on a selected
					// node took the drawn edges from 1 to 0 and the pending count to "2 unsaved changes",
					// while the node itself reappeared from the next platform-tree push. So the board
					// looked untouched with two link deletions queued behind it, and the next Save — even
					// one meant for an unrelated edit — would have destroyed the gateway link.
					//
					// `deleteKeyCode` still arms Backspace/Delete, because deleting an EDGE is the
					// intended unlink gesture; only nodes are made undeletable, per-node in buildGraph
					// (`deletable: false`) — React Flow 12 has no canvas-wide `nodesDeletable` prop.
					deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
					// Unconditional, not "system": Clusterio hardcodes antd's darkAlgorithm
					// (@clusterio/web_ui/src/components/App.tsx) and ships no light mode, so following the
					// OS preference would render a light canvas inside a permanently dark page.
					colorMode="dark"
					fitView
					fitViewOptions={fitViewOptions}
					minZoom={0.2}
				>
					<Background />
					{/* The debug toggle lives WITH the other view controls — zoom, fit, lock — because that
					    is what it is: a way of changing what you are shown, not something that acts on the
					    cluster. `?debug=1` still works and is still what a fresh session uses; this is the
					    handle for someone already looking at the canvas. */}
					<Controls>
						<ControlButton
							onClick={() => setDebug({ ...debug, enabled: !debug.enabled })}
							title={debug.enabled ? "Turn debug mode off" : "Turn debug mode on (also: surfaceExportCanvas.help())"}
							aria-label="toggle debug mode"
						>
							<BugOutlined style={debug.enabled ? { color: "#b37feb" } : undefined} />
						</ControlButton>
					</Controls>
					<MiniMap
						pannable
						zoomable
						nodeColor={miniMapNodeColor}
						// The default mask is rgba(240,240,240,0.6) — a light haze designed for a light
						// canvas, which reads as fog over this one.
						maskColor="rgba(0, 0, 0, 0.6)"
						nodeBorderRadius={20}
					/>
					{/* Canvas toolbar. Top-LEFT is the only free corner: Controls sit bottom-left, the
					    MiniMap bottom-right, and the save state top-right. */}
					<Panel position="top-left">
						<Space size="small">
							<Select
								size="small"
								value={effectiveHostFilter}
								onChange={setHostFilter}
								// Wider than the trigger so long host names are readable in the list without
								// stretching the toolbar across the canvas.
								popupMatchSelectWidth={false}
								style={{ minWidth: 160 }}
								options={[
									{ value: ALL_HOSTS, label: "All hosts" },
									...graph.hosts.map(host => ({ value: host.key, label: host.name })),
								]}
							/>
							{/* Jump to an instance by name. On two nodes this is redundant; on a real cluster
							    the whole point of a canvas — that everything has a place — is what makes
							    finding one thing hard. Selecting also opens that node's platform toolbar,
							    so "find it" and "act on it" are one gesture. */}
							<Select
								size="small"
								showSearch
								allowClear
								value={null}
								placeholder="Find an instance"
								style={{ minWidth: 190 }}
								popupMatchSelectWidth={false}
								filterOption={(input, option) =>
									String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())
								}
								options={graph.nodes.map(node => ({
									value: node.id,
									label: String(node.data.instanceName || node.id),
								}))}
								onChange={value => value && focusNode(String(value))}
							/>
							<Tooltip title="Forget the saved positions and frame every instance">
								<Button size="small" icon={<ReloadOutlined />} onClick={resetLayout}>Reset</Button>
							</Tooltip>
							<Tooltip title="Import a platform from a JSON export file">
								<Button size="small" icon={<UploadOutlined />} onClick={onOpenImport}>Import</Button>
							</Tooltip>
						</Space>
						{/* Debug mode has NO button to turn it on — it is asked for with ?debug=1 and then
						    remembered (see loadDebugState). A normal operator never sees a way in, which is
						    the point: everything behind it draws something that is not true of the cluster. */}
						{debug.enabled ? (
							<DebugPanel state={debug} onChange={setDebug} mockCount={mockCount} />
						) : null}
					</Panel>
					{/* The colour key for the transfer ships. Bottom-CENTRE is the only edge left free —
					    Controls sit bottom-left, the MiniMap bottom-right, the toolbar top-left and the
					    save state top-right. Always on rather than only while a transfer is running: a
					    key you consult must be there before you need it, and a legend that appears and
					    vanishes is a distraction in its own right. Derived from the phase model, so it
					    cannot describe a colour the canvas no longer draws. */}
					<Panel position="bottom-center" className="surface-export-legend">
						{SHIP_LEGEND.map(entry => (
							<span key={entry.tone} className="surface-export-legend-item">
								<span className={`surface-export-legend-dot surface-export-ship-${entry.tone}`} />
								{entry.label}
							</span>
						))}
					</Panel>
					<Panel position="top-right">
						<Space>
							{canEdit ? (
								<Text type="secondary" style={{ fontSize: 12 }}>
									{pending.length
										? `${pending.length} unsaved change${pending.length === 1 ? "" : "s"}`
										: "drag between gateways to link"}
								</Text>
							) : (
								<Text type="secondary" style={{ fontSize: 12 }}>read-only</Text>
							)}
							{/* Gated on allDirty, not pending: a mock link is unsaveable but still UNDOABLE,
							    and Revert is the only thing that can clear one. Gating on `pending` left an
							    operator who drew a mock link with no way to remove it. */}
							{canEdit && allDirty.length ? (
								<Button size="small" onClick={revert} disabled={saving}>Revert</Button>
							) : null}
							{canEdit ? (
								<Button
									type="primary"
									size="small"
									loading={saving}
									disabled={!pending.length}
									onClick={() => void save()}
								>
									Save
								</Button>
							) : null}
						</Space>
					</Panel>
				</ReactFlow>
			)}
			<TransferModal
				source={transfer?.source ?? null}
				presetTargetInstanceId={transfer?.presetTargetInstanceId ?? null}
				onClose={() => setTransfer(null)}
				plugin={plugin}
				state={state}
			/>
		</div>
		</GatewayDebugContext.Provider>
		</NodeActionsContext.Provider>
	);
}
