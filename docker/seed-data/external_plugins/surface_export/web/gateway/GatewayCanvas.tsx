import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, Select, Space, Spin, Tooltip, Typography, message as antMessage } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import {
	Background,
	Controls,
	MarkerType,
	MiniMap,
	Panel,
	ConnectionMode,
	ReactFlow,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import type { Connection, Edge, Node } from "@xyflow/react";
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
	DIMMED_OPACITY,
	applyConnect,
	applyDisconnect,
	buildGraph,
	dirtyKeys,
	editsFromLinks,
	gatewayFromHandleId,
	instanceIdFromNodeId,
	instanceNodeId,
	parseEditKey,
	preservePositions,
	sourceHandleId,
	targetHandleId,
} from "./gateway-graph";
import type { ConnectRequest, GatewayEdits } from "./gateway-graph";
import { NodeActionsContext, platformActionKey } from "./node-actions";
import { instancePairKey, noteLiveSeen, noteTerminalSeen, shipExpiryMs, shipPhaseFor, shipsInFlight, transientEdgeId } from "./transfer-motion";
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
	const [transferSource, setTransferSource] = useState<PlatformActionSource | null>(null);
	const [exportingKey, setExportingKey] = useState<string | null>(null);

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
	const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

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

	const graph = useMemo(() => buildGraph(tree, edits, mode, hostFilter), [tree, edits, mode, hostFilter]);
	const pending = useMemo(() => dirtyKeys(edits, baseline), [edits, baseline]);

	/**
	 * The transfers currently worth drawing a ship for.
	 *
	 * `shipClock` exists because a FINISHED transfer has to leave the canvas on a timer rather than on
	 * an event — nothing else is coming for it. It is bumped by a single timeout scheduled for the
	 * next expiry, NOT by a polling interval: an interval would re-render every node forever to
	 * service a case that is usually empty.
	 */
	const [shipClock, setShipClock] = useState(() => Date.now());
	const ships = useMemo(
		() => shipsInFlight(state?.transferSummaries, shipClock),
		[state?.transferSummaries, shipClock],
	);

	useEffect(() => {
		// Stamp "we have now seen this one finish" BEFORE reading the deadlines, so a transfer that
		// went terminal this render gets its full linger window rather than one derived from a wire
		// timestamp that may be missing. Writing it here, not in the filter, keeps render pure.
		const now = Date.now();
		for (const ship of ships) {
			if (shipPhaseFor(ship.status)?.terminal) {
				noteTerminalSeen(ship.transferId, now);
			} else {
				// Seen in flight — this is what earns it an arrival animation later, and what keeps the
				// transaction log's history off the canvas.
				noteLiveSeen(ship.transferId);
			}
		}
		const expiries = ships.map(ship => shipExpiryMs(ship, now)).filter((at): at is number => at !== null);
		if (!expiries.length) {
			return undefined;
		}
		// +50ms so the wake-up lands after the expiry rather than exactly on it, where a re-run would
		// compute the same deadline again and schedule a zero-length timeout.
		const wakeIn = Math.max(0, Math.min(...expiries) - Date.now()) + 50;
		const timer = setTimeout(() => setShipClock(Date.now()), wakeIn);
		return () => clearTimeout(timer);
	}, [ships]);

	useEffect(() => {
		// preservePositions keeps the user's drags and selection across this rebuild. The tree is
		// re-pushed on every platform status change, so without it a node would snap back to its
		// layout position roughly once a second.
		setNodes(previous => preservePositions(previous, graph.nodes as unknown as Node[]));
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
		onTransfer: (source: PlatformActionSource) => setTransferSource(source),
	}), [exportingKey, plugin]);

	// A host that has left the tree since it was picked must not leave the filter stuck on a value
	// nothing matches. buildGraph already dims nothing in that case; this keeps the control agreeing
	// with what is drawn instead of showing a selection that has no effect.
	const effectiveHostFilter = graph.hosts.some(host => host.key === hostFilter) ? hostFilter : ALL_HOSTS;

	const onConnect = useCallback((connection: Connection) => {
		const request = toConnectRequest(connection);
		if (!request) {
			antMessage.error("Could not read that connection — nothing was staged.", 6);
			return;
		}
		if (request.sourceInstanceId === request.targetInstanceId) {
			antMessage.warning("An instance cannot gateway to itself.", 4);
			return;
		}
		setEdits(previous => {
			if (mode === "multi") {
				// Multi Cluster's rules, checked on BOTH ends. The controller enforces them too — it has
				// to, since the canvas is only one caller — but refusing here means the operator sees why
				// the moment they draw, instead of watching an edge appear and then vanish on save.
				//
				// The reverse end is checked as well because a drawn edge writes both directions: a link
				// that is legal outbound can still be illegal inbound, and staging half of it would leave
				// a pending change that can never save.
				for (const end of [
					{ instanceId: request.sourceInstanceId, gateway: request.sourceGateway,
						link: { targetInstanceId: request.targetInstanceId, targetGateway: request.targetGateway } },
					{ instanceId: request.targetInstanceId, gateway: request.targetGateway,
						link: { targetInstanceId: request.sourceInstanceId, targetGateway: request.sourceGateway } },
				]) {
					const others = new Map<string, Array<{ targetInstanceId: number; targetGateway: string }>>();
					for (const [key, targets] of Object.entries(previous)) {
						const parsed = parseEditKey(key);
						if (parsed && parsed.sourceInstanceId === end.instanceId && parsed.gatewayName !== end.gateway && targets.length) {
							others.set(parsed.gatewayName, targets);
						}
					}
					const existing = previous[`${end.instanceId}:${end.gateway}`] || [];
					const violation = checkMultiModeLink(end.gateway, [...existing, end.link], others);
					if (violation) {
						antMessage.warning(violation, 6);
						return previous;
					}
				}
			}
			// Stages BOTH directions: a drawn edge is a two-way portal (owner ruling). Nothing is sent
			// until Save, so the two writes are reviewable as a pending count first.
			return applyConnect(previous, request);
		});
	}, [mode]);

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
		try {
			// One call per dirty key, each carrying that gateway's WHOLE target list — which is the
			// contract setGatewayLink already has. Sequential rather than parallel so a partial failure
			// leaves a comprehensible trail in the controller log.
			for (const key of pending) {
				const parsed = parseEditKey(key);
				if (!parsed) {
					failures.push(`${key}: unreadable key`);
					continue;
				}
				try {
					const response = (await plugin.setGatewayLink({
						sourceInstanceId: parsed.sourceInstanceId,
						gatewayName: parsed.gatewayName,
						targets: (edits[key] || []).map(target => ({
							targetInstanceId: Number(target.targetInstanceId),
							targetGateway: target.targetGateway || parsed.gatewayName,
						})),
					})) as JsonObject;
					if (!getProp(response, "success", false)) {
						failures.push(`${parsed.gatewayName}: ${String(getProp(response, "error", "save failed"))}`);
					}
				} catch (err: unknown) {
					failures.push(`${parsed.gatewayName}: ${getErrorMessage(err, "save failed")}`);
				}
			}

			if (failures.length) {
				// Deliberately NOT re-baselining on partial failure: the canvas must keep showing the
				// edits that did not land, or the operator sees a clean board and believes it saved.
				antMessage.error(`${failures.length} of ${pending.length} failed — ${failures.join("; ")}`, 12);
				return;
			}
			setBaseline(edits);
			antMessage.success(`Saved ${pending.length} gateway${pending.length === 1 ? "" : "s"}.`, 4);
		} finally {
			setSaving(false);
		}
	}, [edits, pending, plugin]);

	const revert = useCallback(() => setEdits(baseline), [baseline]);

	if (loading && !nodes.length) {
		return <Spin style={{ margin: "24px auto", display: "block" }} />;
	}

	return (
		<NodeActionsContext.Provider value={nodeActions}>
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
					onEdgesDelete={onEdgesDelete}
					onEdgeClick={onEdgeClick}
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
					deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
					// Unconditional, not "system": Clusterio hardcodes antd's darkAlgorithm
					// (@clusterio/web_ui/src/components/App.tsx) and ships no light mode, so following the
					// OS preference would render a light canvas inside a permanently dark page.
					colorMode="dark"
					fitView
					minZoom={0.2}
				>
					<Background />
					<Controls />
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
							<Tooltip title="Import a platform from a JSON export file">
								<Button size="small" icon={<UploadOutlined />} onClick={onOpenImport}>Import</Button>
							</Tooltip>
						</Space>
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
							{canEdit && pending.length ? (
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
				source={transferSource}
				onClose={() => setTransferSource(null)}
				plugin={plugin}
				state={state}
			/>
		</div>
		</NodeActionsContext.Provider>
	);
}
