import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Select, Space, Spin, Tooltip, Typography, message as antMessage } from "antd";
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
import { gatewayColour } from "./gateway-colours";
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
import {
	EDGE_SHAPES, applySavedLayout, clearLayout, loadEdgeShape, loadLayout, saveEdgeShape, saveLayout,
} from "./layout-store";
import type { EdgeShape } from "./layout-store";
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

function miniMapNodeColor(node: Node) {
	return (node.data as { online?: boolean }).online ? "#1668dc" : "#5a5a5a";
}

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

function connectionRefusal(link: Connection | Edge, edits: GatewayEdits, mode: GatewayMode): string | null {
	const sourceInstanceId = instanceIdFromNodeId(link.source);
	const targetInstanceId = instanceIdFromNodeId(link.target);
	const fromPlatform = platformIndexFromHandleId(link.sourceHandle) != null;
	if (sourceInstanceId == null || targetInstanceId == null) {
		return "Could not read that connection — nothing was staged.";
	}
	if (sourceInstanceId === targetInstanceId) {
		return fromPlatform
			? "A platform cannot transfer to the instance it is already on."
			: "An instance cannot gateway to itself.";
	}
	if (isMockInstanceId(sourceInstanceId) !== isMockInstanceId(targetInstanceId)) {
		return "A mock instance can only link to another mock instance.";
	}
	if (platformIndexFromHandleId(link.targetHandle) != null) {
		return "Drop it on the other instance's PORTAL, not on one of its platforms.";
	}
	if (fromPlatform) {
		return gatewayFromHandleId(link.targetHandle) != null ? null : "Drop a platform on a gateway portal.";
	}
	if (gatewayFromHandleId(link.sourceHandle) == null || gatewayFromHandleId(link.targetHandle) == null) {
		return "Both ends of a gateway link must be gateway portals.";
	}
	if (mode === "multi") {
		const request = toConnectRequest(link);
		return request ? multiModeViolation(edits, request) : "Could not read that connection — nothing was staged.";
	}
	return null;
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

	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [edits, setEdits] = useState<GatewayEdits>({});
	const [mode, setMode] = useState<GatewayMode>(DEFAULT_GATEWAY_MODE);
	const [baseline, setBaseline] = useState<GatewayEdits>({});
	const [hostFilter, setHostFilter] = useState<string>(ALL_HOSTS);
	const [transfer, setTransfer] = useState<
		{ source: PlatformActionSource; presetTargetInstanceId: number | null } | null
	>(null);
	const [exportingKey, setExportingKey] = useState<string | null>(null);
	const [debug, setDebugState] = useState<DebugState>(loadDebugState);
	const setDebug = useCallback((next: DebugState) => {
		setDebugState(next);
		saveDebugState(next);
	}, []);
	const [scenario, setScenario] = useState<DebugScenario | null>(null);
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

	const effectiveTree = useMemo(
		() => (scenario ? scenarioToTree(scenario) : withMockInstances(tree, debug)),
		[scenario, tree, debug],
	);

	const scenarioEdits = useMemo(
		() => (scenario ? scenarioToEdits(scenario, gatewayNamesFor(mode)[0]) : null),
		[scenario, mode],
	);
	const graph = useMemo(
		() => buildGraph(effectiveTree, scenarioEdits ?? edits, mode, hostFilter),
		[effectiveTree, edits, scenarioEdits, mode, hostFilter],
	);

	const allDirty = useMemo(() => dirtyKeys(edits, baseline), [edits, baseline]);

	const pending = useMemo(() => allDirty.filter(key => !isMockEditKey(key)), [allDirty]);
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
		const routes = graph.edges.map(edge => [edge.sourceInstanceId, edge.targetInstanceId] as const);
		const replayed = replayShips(state?.transferSummaries, debug.replayTransferIds)
			.filter(ship => !realShips.some(live => live.transferId === ship.transferId));
		return [...replayed, ...realShips, ...mockShips(routes, debug.shipPhases)];
	}, [realShips, debug.enabled, debug.shipPhases, debug.replayTransferIds, state?.transferSummaries, scenario, graph]);

	useEffect(() => {
		const now = Date.now();
		for (const ship of realShips) {
			if (shipPhaseFor(ship.status)?.terminal) {
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
		setEdges(previous => {
			const selected = new Set(previous.filter(edge => edge.selected).map(edge => edge.id));
			const focused = new Set(
				graph.nodes.filter(node => !node.data.dimmed).map(node => instanceIdFromNodeId(node.id)),
			);
			const drawn = new Set(graph.nodes.map(node => node.id));
			const dimStyle = (a: number, b: number) => (
				focused.has(a) || focused.has(b) ? undefined : { opacity: DIMMED_OPACITY }
			);

			const unassigned = new Map(ships.map(ship => [ship.transferId, ship]));
			const shipsFor = (a: number, b: number) => {
				const wanted = instancePairKey(a, b);
				const taken: typeof ships = [];
				for (const [transferId, ship] of unassigned) {
					if (instancePairKey(ship.sourceInstanceId, ship.targetInstanceId) === wanted) {
						unassigned.delete(transferId);
						taken.push(ship);
					}
				}
				return taken;
			};

			const edges: Edge[] = graph.edges.map(edge => {
				const riding = shipsFor(edge.sourceInstanceId, edge.targetInstanceId);
				return {
					id: edge.id,
					source: edge.source,
					sourceHandle: edge.sourceHandle,
					target: edge.target,
					targetHandle: edge.targetHandle,
					type: GATEWAY_EDGE_TYPE,
					selected: selected.has(edge.id),
					deletable: interactive,
					style: dimStyle(edge.sourceInstanceId, edge.targetInstanceId),
					markerEnd: edge.forward
						? { type: MarkerType.ArrowClosed, color: gatewayColour(edge.sourceGateway) }
						: undefined,
					markerStart: edge.reverse
						? { type: MarkerType.ArrowClosed, color: gatewayColour(edge.sourceGateway) }
						: undefined,
					data: {
						forward: edge.forward,
						reverse: edge.reverse,
						sourceGateway: edge.sourceGateway,
						shape: edgeShape,
						sourceInstanceId: edge.sourceInstanceId,
						transfers: riding,
					},
				};
			});

			const anchorGateway = gatewayNamesFor(mode)[0];
			const byPair = new Map<string, typeof ships>();
			for (const ship of unassigned.values()) {
				const key = instancePairKey(ship.sourceInstanceId, ship.targetInstanceId);
				const group = byPair.get(key);
				if (group) {
					group.push(ship);
				} else {
					byPair.set(key, [ship]);
				}
			}
			for (const group of byPair.values()) {
				const [first] = group;
				const source = instanceNodeId(first.sourceInstanceId);
				const target = instanceNodeId(first.targetInstanceId);
				if (!drawn.has(source) || !drawn.has(target)) {
					continue;
				}
				edges.push({
					id: transientEdgeId(instancePairKey(first.sourceInstanceId, first.targetInstanceId)),
					source,
					sourceHandle: sourceHandleId(anchorGateway),
					target,
					targetHandle: targetHandleId(anchorGateway),
					type: GATEWAY_EDGE_TYPE,
					deletable: false,
					style: { ...dimStyle(first.sourceInstanceId, first.targetInstanceId), strokeDasharray: "6 4" },
					markerEnd: { type: MarkerType.ArrowClosed, color: gatewayColour(anchorGateway) },
					data: {
						transient: true,
						sourceGateway: anchorGateway,
						shape: edgeShape,
						sourceInstanceId: first.sourceInstanceId,
						transfers: group,
					},
				});
			}
			return edges;
		});
	}, [graph, ships, mode, interactive, edgeShape, setNodes, setEdges]);

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
			value: node.id,
			key: `${node.id}:${platform.platformIndex}`,
			label: `${platform.platformName || `platform ${platform.platformIndex}`} — ${instanceName}`,
		}));
	}), [graph]);

	const selectedInstanceIds = useMemo(
		() => nodes.filter(node => node.selected)
			.map(node => instanceIdFromNodeId(node.id))
			.filter((id): id is number => id !== null),
		[nodes],
	);

	const bulkLink = useCallback((connect: boolean) => {
		const gateway = gatewayNamesFor(mode)[0];
		const refused: string[] = [];
		setEdits(previous => {
			let next = previous;
			for (let a = 0; a < selectedInstanceIds.length; a += 1) {
				for (let b = a + 1; b < selectedInstanceIds.length; b += 1) {
					const request = {
						sourceInstanceId: selectedInstanceIds[a],
						sourceGateway: gateway,
						targetInstanceId: selectedInstanceIds[b],
						targetGateway: gateway,
					};
					if (connect) {
						const violation = mode === "multi" ? multiModeViolation(next, request) : null;
						if (violation) {
							refused.push(violation);
							continue;
						}
						next = applyConnect(next, request);
					} else {
						next = applyDisconnect(next, request);
					}
				}
			}
			return next;
		});
		if (refused.length) {
			antMessage.warning({
				content: `${refused.length} pair(s) refused: ${[...new Set(refused)].join(" ")}`,
				key: "canvas-bulk", duration: 8,
			});
		}
	}, [mode, selectedInstanceIds]);

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
		(link: Connection | Edge) => connectionRefusal(link, edits, mode) === null,
		[edits, mode],
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
		setEdits(previous => applyConnect(previous, request));
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
		}, edits, mode);
		if (refusal) {
			antMessage.warning({ content: refusal, key: "canvas-refusal", duration: 6 });
		}
	}, [edits, mode]);

	const onEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
		if (edge.data?.transient) {
			antMessage.info({
				content: "That is a transfer in flight, not a configured link — it clears itself.",
				key: "canvas-edge-click", duration: 4,
			});
			return;
		}
		if (!canEdit) {
			return;
		}
		if (locked) {
			antMessage.info({
				content: "The canvas is locked. Use the padlock in the controls to unlock it.",
				key: "canvas-edge-click", duration: 4,
			});
			return;
		}
		const request = toConnectRequest(edge);
		if (!request) {
			antMessage.error("Could not read that edge — nothing was removed.", 6);
			return;
		}
		setEdits(previous => applyDisconnect(previous, request));
	}, [canEdit, locked]);

	const onEdgesDelete = useCallback((deleted: Edge[]) => {
		if (!interactive) {
			return;
		}
		setEdits(previous => deleted.filter(edge => !edge.data?.transient).reduce((acc, edge) => {
			const request = toConnectRequest(edge);
			return request ? applyDisconnect(acc, request) : acc;
		}, previous));
	}, [interactive]);

	const save = useCallback(async () => {
		setSaving(true);
		const failures: string[] = [];
		const warnings: string[] = [];
		try {
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
						warnings.push(reason);
					}
				} catch (err: unknown) {
					failures.push(`${label}: ${getErrorMessage(err, "save failed")}`);
				}
			}

			if (failures.length) {
				antMessage.error(`${failures.length} of ${pending.length} failed — ${failures.join("; ")}`, 12);
				return;
			}
			setBaseline(Object.fromEntries(
				Object.entries(edits).filter(([key]) => !isMockEditKey(key)),
			));
			if (warnings.length) {
				antMessage.warning(warnings.join("; "), 15);
				return;
			}
			antMessage.success(`Saved ${pending.length} gateway${pending.length === 1 ? "" : "s"}.`, 4);
		} finally {
			setSaving(false);
		}
	}, [edits, pending, plugin]);

	const revert = useCallback(() => setEdits(baseline), [baseline]);

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
					onConnectEnd={onConnectEnd}
					isValidConnection={isValidConnection}
					onEdgesDelete={onEdgesDelete}
					onEdgeClick={onEdgeClick}
					onNodeDragStop={onNodeDragStop}
					onInit={instance => { flow.current = instance as unknown as typeof flow.current; }}
					nodeTypes={CANVAS_NODE_TYPES}
					edgeTypes={CANVAS_EDGE_TYPES}
					connectionLineComponent={ConnectionLine}
					connectionMode={ConnectionMode.Loose}
					nodesConnectable={interactive}
					edgesFocusable={interactive}
					nodesDraggable={!locked}
					elementsSelectable
					multiSelectionKeyCode={["Control", "Meta"]}
					deleteKeyCode={interactive ? ["Backspace", "Delete"] : null}
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
								? "Unlock the canvas — allow connecting, deleting and dragging"
								: "Lock the canvas — no connecting, no edge deletion, no dragging"}
							aria-label={locked ? "unlock the canvas" : "lock the canvas"}
							data-testid="canvas-lock"
							data-locked={locked ? "true" : "false"}
						>
							{locked ? <LockOutlined style={{ color: "#fa8c16" }} /> : <UnlockOutlined />}
						</ControlButton>
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
								onChange={value => value && focusNode(String(value))}
							/>
							<Tooltip title="The shape every gateway link is drawn with">
								<Select
									size="small"
									value={edgeShape}
									style={{ minWidth: 110 }}
									popupMatchSelectWidth={false}
									onChange={changeEdgeShape}
									options={EDGE_SHAPES.map(shape => ({ value: shape, label: shape }))}
								/>
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
					</Panel>
					<Panel position="top-right">
						<Space direction="vertical" size={4} align="end">
							{canEdit ? (
								<Text type="secondary" style={{ fontSize: 12 }}>
									{pending.length
										? `${pending.length} unsaved change${pending.length === 1 ? "" : "s"}`
										: "drag between gateways to link"}
								</Text>
							) : (
								<Text type="secondary" style={{ fontSize: 12 }}>read-only</Text>
							)}
							{interactive && selectedInstanceIds.length >= 2 ? (
								<Text className="surface-export-select-hint">
									{selectedInstanceIds.length} selected · Ctrl+click to select more
								</Text>
							) : null}
							{interactive && selectedInstanceIds.length === 1 ? (
								<Text className="surface-export-select-hint">Ctrl+click another instance to link them</Text>
							) : null}
							{canEdit || (interactive && selectedInstanceIds.length >= 2) ? (
								<Space size="small">
									{interactive && selectedInstanceIds.length >= 2 ? (
										<>
											<Tooltip title="Link every selected instance to every other one">
												<Button size="small" onClick={() => bulkLink(true)}>Link selected</Button>
											</Tooltip>
											<Tooltip title="Remove the links between the selected instances">
												<Button size="small" onClick={() => bulkLink(false)}>Unlink selected</Button>
											</Tooltip>
										</>
									) : null}
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
