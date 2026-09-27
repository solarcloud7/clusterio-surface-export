import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Empty, Select, Space, Spin, Switch, Tooltip, Typography, message as antMessage } from "antd";
import { BugOutlined, LockOutlined, ReloadOutlined, UnlockOutlined, UploadOutlined } from "@ant-design/icons";
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
import type { Connection, Edge, FinalConnectionState, FitViewOptions, Node } from "@xyflow/react";
import { useAccount } from "@clusterio/web_ui";

import "@xyflow/react/dist/style.css";

import { PERMISSIONS } from "../../messages";
import {
	ALL_HOSTS,
	CAPTION_HEIGHT,
	CAPTION_WIDTH,
	DIMMED_OPACITY,
	NODE_DIAMETER,
	buildGraph,
	gatewayFromHandleId,
	groupTraffic,
	instanceIdFromNodeId,
	instanceNodeId,
	platformIndexFromHandleId,
	preservePositions,
	sourceHandleId,
	targetHandleId,
} from "./gateway-graph";
import { portalColour } from "./gateway-colours";
import type { PlatformLike, PortalDestination, TrafficRouteModel } from "./gateway-graph";
import { NodeActionsContext, ShowPlanetsContext, platformActionKey } from "./node-actions";
import DebugPanel from "./DebugPanel";
import AutoPauseIcon, { AUTO_PAUSE_LABEL } from "./AutoPauseIcon";
import {
	GatewayDebugContext,
	DEFAULT_DEBUG_STATE,
	hasDebugInstance,
	isMockInstanceId,
	loadDebugState,
	mockShips,
	replayCandidates,
	replayShips,
	saveDebugState,
	scenarioToShips,
	scenarioToTree,
	withMockInstances,
} from "./debug-mode";
import type { DebugScenario, DebugState } from "./debug-mode";
import { installCanvasDebugApi } from "./debug-api";
import {
	EDGE_SHAPES, applySavedLayout, clearLayout, loadEdgeShape, loadLayout, loadShowPlanets, saveEdgeShape, saveLayout, saveShowPlanets,
} from "./layout-store";
import type { EdgeShape } from "./layout-store";
import { SHIP_LEGEND, noteLiveSeen, noteTerminalSeen, shipExpiryMs, shipPhaseFor, shipsInFlight, transientEdgeId } from "./transfer-motion";
import type { ShipTransfer } from "./transfer-motion";
import { ONE_GATE_NAME } from "../../shared/dto";
import { CANVAS_EDGE_TYPES, CANVAS_NODE_TYPES, GATEWAY_EDGE_TYPE } from "./node-types";
import ConnectionLine from "./ConnectionLine";
import TransferModal from "../TransferModal";
import { exportPlatformToDownload } from "../platform-actions";
import type { PlatformActionSource } from "../platform-actions";
import type { SurfaceExportPlugin, SurfaceExportState } from "../view-models";

const { Text } = Typography;

function miniMapNodeColor(node: Node) {
	return (node.data as { online?: boolean }).online ? "#1668dc" : "#5a5a5a";
}

function connectionRefusal(link: Connection | Edge): string | null {
	const sourceInstanceId = instanceIdFromNodeId(link.source);
	const targetInstanceId = instanceIdFromNodeId(link.target);
	if (sourceInstanceId == null || targetInstanceId == null) {
		return "Could not read that connection — no transfer was started.";
	}
	if (platformIndexFromHandleId(link.sourceHandle) == null) {
		return "Drag a platform onto another server's portal to transfer it.";
	}
	if (sourceInstanceId === targetInstanceId) {
		return "A platform cannot transfer to the instance it is already on.";
	}
	if (isMockInstanceId(sourceInstanceId) !== isMockInstanceId(targetInstanceId)) {
		return "A mock instance can only be dragged to another mock instance.";
	}
	if (platformIndexFromHandleId(link.targetHandle) != null) {
		return "Drop it on the other instance's PORTAL, not on one of its platforms.";
	}
	return gatewayFromHandleId(link.targetHandle) != null ? null : "Drop a platform on a gateway portal.";
}

const HEADING_NAMES_SHOWN = 2;

function headingText(route: TrafficRouteModel, destination: PortalDestination | null, targetName: string) {
	const names = route.platforms.map(platform => platform.platformName);
	const label = destination?.label || targetName;
	const shown = names.length > HEADING_NAMES_SHOWN ? `${names.length} platforms` : names.join(", ");
	return {
		text: `${shown} → ${label}`,
		title: `Heading to the portal of ${targetName}: ${names.join(", ")}`,
		colour: portalColour(destination?.colour),
	};
}

export default function GatewayCanvas({ plugin, state, onOpenImport }: {
	plugin: SurfaceExportPlugin;
	state: SurfaceExportState;
	onOpenImport: () => void;
}) {
	const account = useAccount();
	const canEdit = account.hasPermission(PERMISSIONS.TRANSFER_EXPORTS) === true;
	const [locked, setLocked] = useState(false);
	const interactive = canEdit && !locked;

	const [hostFilter, setHostFilter] = useState<string>(ALL_HOSTS);
	const [transfer, setTransfer] = useState<
		{ source: PlatformActionSource; presetTargetInstanceId: number | null } | null
	>(null);
	const [exportingKey, setExportingKey] = useState<string | null>(null);
	const debugAllowed = canEdit && hasDebugInstance(state?.tree);
	const [savedDebug, setDebugState] = useState<DebugState>(loadDebugState);
	const debug = debugAllowed ? savedDebug : DEFAULT_DEBUG_STATE;
	const setDebug = useCallback((next: DebugState) => {
		setDebugState(next);
		saveDebugState(next);
	}, []);
	const [savedScenario, setScenario] = useState<DebugScenario | null>(null);
	const scenario = debugAllowed ? savedScenario : null;
	const [showPlanets, setShowPlanets] = useState<boolean>(loadShowPlanets);
	const changeShowPlanets = useCallback((show: boolean) => {
		setShowPlanets(show);
		saveShowPlanets(show);
	}, []);
	const [edgeShape, setEdgeShape] = useState<EdgeShape>(loadEdgeShape);
	const changeEdgeShape = useCallback((shape: EdgeShape) => {
		setEdgeShape(shape);
		saveEdgeShape(shape);
	}, []);

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

	const savedLayout = useRef(loadLayout());
	const flow = useRef<{
		fitView: (options?: FitViewOptions) => void;
		setCenter?: (x: number, y: number, options?: { zoom?: number; duration?: number }) => void;
	} | null>(null);
	const [fitRequest, setFitRequest] = useState(0);

	const onNodeDragStop = useCallback(() => {
		setNodes(current => {
			saveLayout(current);
			savedLayout.current = Object.fromEntries(current.map(node => [node.id, { ...node.position }]));
			return current;
		});
	}, [setNodes]);

	const tree = state?.tree;

	const effectiveTree = useMemo(
		() => (scenario ? scenarioToTree(scenario) : withMockInstances(tree, debug)),
		[scenario, tree, debug],
	);

	const graph = useMemo(
		() => buildGraph(effectiveTree, hostFilter),
		[effectiveTree, hostFilter],
	);

	const mockCount = useMemo(
		() => graph.nodes.filter(node => isMockInstanceId(node.data.instanceId as number)).length,
		[graph],
	);

	const fitViewOptions = useMemo((): FitViewOptions => {
		const breathingRoom = 12;
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

	useEffect(() => {
		if (fitRequest) {
			flow.current?.fitView({ ...fitViewOptions, duration: 300 });
		}
	}, [fitRequest]);

	const resetLayout = useCallback(() => {
		clearLayout();
		savedLayout.current = {};
		setNodes(graph.nodes as unknown as Node[]);
		setFitRequest(request => request + 1);
	}, [graph, setNodes]);

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

	const [shipClock, setShipClock] = useState(() => Date.now());
	const realShips = useMemo(
		() => shipsInFlight(state?.transferSummaries, shipClock),
		[state?.transferSummaries, shipClock],
	);

	const ships = useMemo(() => {
		if (scenario) {
			return scenarioToShips(scenario);
		}
		if (!debug.enabled) {
			return realShips;
		}
		const linked = graph.routes.map(route => [route.sourceInstanceId, route.targetInstanceId] as const);
		const drawnIds = graph.nodes
			.map(node => instanceIdFromNodeId(node.id))
			.filter((id): id is number => id !== null);
		const pairs: Array<readonly [number, number]> = [];
		for (let a = 0; a < drawnIds.length; a += 1) {
			for (let b = a + 1; b < drawnIds.length; b += 1) { pairs.push([drawnIds[a], drawnIds[b]] as const); }
		}
		const routes = linked.length ? linked : pairs;
		const replayed = replayShips(state?.transferSummaries, debug.replayTransferIds)
			.filter(ship => !realShips.some(live => live.transferId === ship.transferId));
		return [...replayed, ...realShips, ...mockShips(routes, debug.shipPhases)];
	}, [realShips, debug.enabled, debug.shipPhases, debug.replayTransferIds, state?.transferSummaries, scenario, graph]);

	useEffect(() => {
		const now = Date.now();
		for (const ship of realShips) {
			if (shipPhaseFor(ship)?.terminal) {
				noteTerminalSeen(ship.transferId, now);
			} else {
				noteLiveSeen(ship.transferId);
			}
		}
		const expiries = realShips.map(ship => shipExpiryMs(ship, now)).filter((at): at is number => at !== null);
		if (!expiries.length) {
			return undefined;
		}
		const wakeIn = Math.max(0, Math.min(...expiries) - Date.now()) + 50;
		const timer = setTimeout(() => setShipClock(Date.now()), wakeIn);
		return () => clearTimeout(timer);
	}, [realShips]);

	useEffect(() => {
		setNodes(previous => preservePositions(
			previous,
			applySavedLayout(graph.nodes as unknown as Node[], savedLayout.current),
		));
		setEdges(() => {
			const focused = new Set(
				graph.nodes.filter(node => !node.data.dimmed).map(node => instanceIdFromNodeId(node.id)),
			);
			const byInstance = new Map(graph.nodes.map(node => [node.data.instanceId as number, node.data]));
			const destinationOf = (instanceId: number) => (byInstance.get(instanceId)?.destination ?? null) as PortalDestination | null;
			const nameOf = (instanceId: number) => String(byInstance.get(instanceId)?.instanceName || instanceId);
			const dimStyle = (a: number, b: number) => (
				focused.has(a) || focused.has(b) ? undefined : { opacity: DIMMED_OPACITY }
			);
			const anchorGateway = ONE_GATE_NAME;

			return groupTraffic<ShipTransfer>(graph.routes, ships, new Set(byInstance.keys())).map(pair => {
				const colour = portalColour(destinationOf(pair.targetInstanceId)?.colour);
				const reverseColour = portalColour(destinationOf(pair.sourceInstanceId)?.colour);
				const heading = pair.routes.length > 0;
				return {
					id: heading ? `route:${pair.key}` : transientEdgeId(pair.key),
					source: instanceNodeId(pair.sourceInstanceId),
					sourceHandle: sourceHandleId(anchorGateway),
					target: instanceNodeId(pair.targetInstanceId),
					targetHandle: targetHandleId(anchorGateway),
					type: GATEWAY_EDGE_TYPE,
					deletable: false,
					selectable: false,
					style: {
						...dimStyle(pair.sourceInstanceId, pair.targetInstanceId),
						...(heading ? {} : { strokeDasharray: "6 4" }),
					},
					markerEnd: pair.forward ? { type: MarkerType.ArrowClosed, color: colour } : undefined,
					markerStart: pair.reverse ? { type: MarkerType.ArrowClosed, color: reverseColour } : undefined,
					data: {
						transient: !heading,
						colour,
						headings: pair.routes.map(route => headingText(
							route, destinationOf(route.targetInstanceId), nameOf(route.targetInstanceId))),
						shape: edgeShape,
						sourceInstanceId: pair.sourceInstanceId,
						transfers: pair.ships,
					},
				};
			});
		});
	}, [graph, ships, edgeShape, setNodes, setEdges]);

	const nodeActions = useMemo(() => ({
		exportingKey,
		onExport: (source: PlatformActionSource) => {
			setExportingKey(platformActionKey(source.instanceId, source.platformIndex));
			void exportPlatformToDownload(plugin, source).finally(() => setExportingKey(null));
		},
		onTransfer: (source: PlatformActionSource, presetTargetInstanceId: number | null) =>
			setTransfer({ source, presetTargetInstanceId }),
	}), [exportingKey, plugin]);

	const effectiveHostFilter = graph.hosts.some(host => host.key === hostFilter) ? hostFilter : ALL_HOSTS;

	const platformOptions = useMemo(() => graph.nodes.flatMap(node => {
		const instanceName = String(node.data.instanceName || node.id);
		return ((node.data.platforms || []) as PlatformLike[]).map(platform => ({
			value: `${node.id}:${platform.platformIndex}`,
			label: `${platform.platformName || `platform ${platform.platformIndex}`} — ${instanceName}`,
		}));
	}), [graph]);

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

	const isValidConnection = useCallback(
		(link: Connection | Edge) => connectionRefusal(link) === null,
		[],
	);

	const onConnect = useCallback((connection: Connection) => {
		const dragged = platformFromHandle(connection.source, connection.sourceHandle);
		if (dragged) {
			const targetInstanceId = instanceIdFromNodeId(connection.target);
			if (targetInstanceId == null) {
				antMessage.error("Could not read the destination — no transfer was started.", 6);
				return;
			}
			setTransfer({
				source: {
					instanceId: dragged.instanceId,
					instanceName: dragged.instanceName,
					platformUid: dragged.platform.platformUid,
					platformIndex: dragged.platform.platformIndex,
					platformName: dragged.platform.platformName,
					forceName: dragged.platform.forceName || "player",
				},
				presetTargetInstanceId: targetInstanceId,
			});
			return;
		}
		antMessage.warning({ content: "Drag a platform onto another server's portal to transfer it.", key: "canvas-refusal", duration: 6 });
	}, [platformFromHandle]);

	const onConnectEnd = useCallback((_event: MouseEvent | TouchEvent, connection: FinalConnectionState) => {
		if (connection.isValid) {
			return;
		}
		const { fromNode, toNode, fromHandle, toHandle } = connection;
		if (!fromNode || !toNode || !fromHandle || !toHandle) {
			return;
		}
		const refusal = connectionRefusal({
			source: fromNode.id,
			sourceHandle: fromHandle.id ?? null,
			target: toNode.id,
			targetHandle: toHandle.id ?? null,
		});
		if (refusal) {
			antMessage.warning({ content: refusal, key: "canvas-refusal", duration: 6 });
		}
	}, []);

	const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
		antMessage.info({
			content: edge.data?.transient
				? "That is a transfer in flight — the line clears itself when it finishes."
				: "Platforms on this line are scheduled to another server's portal — the line clears itself once they leave.",
			key: "canvas-edge-click", duration: 4,
		});
	}, []);

	const liveRef = useRef({ debug, scenario, graph, summaries: state?.transferSummaries });
	liveRef.current = { debug, scenario, graph, summaries: state?.transferSummaries };
	useEffect(() => debugAllowed ? installCanvasDebugApi({
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
				trafficLines: new Set(current.routes.map(route =>
					[route.sourceInstanceId, route.targetInstanceId].sort((a, b) => a - b).join("|"))).size,
				debugMode: state.enabled,
				shipPhases: state.shipPhases,
				replaying: state.replayTransferIds.length,
				geometry: state.showGeometry,
			};
		},
	}) : undefined, [setDebug, debugAllowed]);

	if (state?.loadingTree && !nodes.length) {
		return <Spin style={{ margin: "24px auto", display: "block" }} />;
	}

	return (
		<NodeActionsContext.Provider value={nodeActions}><ShowPlanetsContext.Provider value={showPlanets}>
		<GatewayDebugContext.Provider value={{ showGeometry: debug.enabled && debug.showGeometry }}>
		<div className="surface-export-canvas">
			{!nodes.length ? (
				<Empty description="No instances available — gateways can't be shown until the platform tree loads." />
			) : (
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					onConnectEnd={onConnectEnd}
					isValidConnection={isValidConnection}
					onEdgeClick={onEdgeClick}
					onNodeDragStop={onNodeDragStop}
					onInit={instance => { flow.current = instance as unknown as typeof flow.current; }}
					nodeTypes={CANVAS_NODE_TYPES}
					edgeTypes={CANVAS_EDGE_TYPES}
					connectionLineComponent={ConnectionLine}
					connectionMode={ConnectionMode.Strict}
					nodesConnectable={interactive}
					edgesFocusable={false}
					nodesDraggable={!locked}
					elementsSelectable
					multiSelectionKeyCode={["Control", "Meta"]}
					deleteKeyCode={null}
					colorMode="dark"
					fitView
					fitViewOptions={fitViewOptions}
					minZoom={0.2}
				>
					<Background />
					<Controls showInteractive={false}>
						<ControlButton
							onClick={() => setLocked(!locked)}
							title={locked
								? "Unlock the canvas — allow dragging servers and platforms"
								: "Lock the canvas — no dragging servers or platforms"}
							aria-label={locked ? "unlock the canvas" : "lock the canvas"}
							data-testid="canvas-lock"
							data-locked={locked ? "true" : "false"}
						>
							{locked ? <LockOutlined style={{ color: "#fa8c16" }} /> : <UnlockOutlined />}
						</ControlButton>
						{debugAllowed && <ControlButton
							onClick={() => setDebug({ ...debug, enabled: !debug.enabled })}
							title={debug.enabled ? "Turn debug mode off" : "Turn debug mode on (also: surfaceExportCanvas.help())"}
							aria-label="toggle debug mode"
						>
							<BugOutlined style={debug.enabled ? { color: "#b37feb" } : undefined} />
						</ControlButton>}
					</Controls>
					<MiniMap
						pannable
						zoomable
						nodeColor={miniMapNodeColor}
						maskColor="rgba(0, 0, 0, 0.6)"
						nodeBorderRadius={20}
					/>
					<Panel position="top-left" style={{ maxWidth: "calc(100% - 260px)" }}>
						<Space size="small" wrap>
							<Select
								size="small"
								value={effectiveHostFilter}
								onChange={setHostFilter}
								popupMatchSelectWidth={false}
								style={{ minWidth: 160 }}
								options={[
									{ value: ALL_HOSTS, label: "All hosts" },
									...graph.hosts.map(host => ({ value: host.key, label: host.name })),
								]}
							/>
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
							<Select
								size="small"
								showSearch
								allowClear
								value={null}
								placeholder="Find a platform"
								style={{ minWidth: 190 }}
								popupMatchSelectWidth={false}
								filterOption={(input, option) =>
									String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())
								}
								options={platformOptions}
								onChange={value => value && focusNode(String(value).split(":").slice(0, -1).join(":"))}
							/>
							<Tooltip title="The shape traffic lines are drawn with">
								<Select
									size="small"
									value={edgeShape}
									style={{ minWidth: 110 }}
									popupMatchSelectWidth={false}
									onChange={changeEdgeShape}
									options={EDGE_SHAPES.map(shape => ({ value: shape, label: shape }))}
								/>
							</Tooltip>
							<Tooltip title="Show each server's active planets under its portal">
								<Space size={4}>
									<Switch size="small" checked={showPlanets} onChange={changeShowPlanets} aria-label="Show planets" />
									<Text type="secondary" style={{ fontSize: 12 }}>Planets</Text>
								</Space>
							</Tooltip>
							<Tooltip title="Forget the saved positions and frame every instance">
								<Button size="small" icon={<ReloadOutlined />} onClick={resetLayout}>Reset</Button>
							</Tooltip>
							<Tooltip title="Import a platform from a JSON export file">
								<Button size="small" icon={<UploadOutlined />} onClick={onOpenImport}>Import</Button>
							</Tooltip>
						</Space>
						{debug.enabled ? (
							<DebugPanel state={debug} onChange={setDebug} mockCount={mockCount} />
						) : null}
					</Panel>
					<Panel position="bottom-center" className="surface-export-legend">
						{SHIP_LEGEND.map(entry => (
							<span key={entry.tone} className="surface-export-legend-item">
								<span className={`surface-export-legend-dot surface-export-ship-${entry.tone}`} />
								{entry.label}
							</span>
						))}
						<span className="surface-export-legend-item surface-export-legend-autopause"
							title="This server stops while no players are online; transfers, imports and exports are refused">
							<AutoPauseIcon size={14} />
							{AUTO_PAUSE_LABEL}
						</span>
					</Panel>
					<Panel position="top-right">
						<Text type="secondary" style={{ fontSize: 12, display: "block", maxWidth: 220, textAlign: "right" }}>
							{canEdit
								? "every server reaches every other · drag a platform onto a portal to transfer it"
								: "every server reaches every other · read-only"}
						</Text>
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
		</ShowPlanetsContext.Provider></NodeActionsContext.Provider>
	);
}
