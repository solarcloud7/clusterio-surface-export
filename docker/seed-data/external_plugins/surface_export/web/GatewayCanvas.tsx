import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Empty, Spin, message as antMessage } from "antd";
import {
	Background,
	Controls,
	MarkerType,
	MiniMap,
	ReactFlow,
	useEdgesState,
	useNodesState,
} from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";

// React Flow ships its own stylesheet. `dist/style.css` = the required base styles PLUS the default
// theme; `dist/base.css` would be base only. We take the full sheet and override the parts that
// clash with Clusterio's dark UI in web/style.css, rather than re-implementing node/edge/handle
// geometry ourselves. Loaded by the existing `{ test: /\.css$/ }` webpack rule, which has no
// include/exclude and so already covers node_modules.
import "@xyflow/react/dist/style.css";

import {
	buildGraph,
	editsFromLinks,
	preservePositions,
} from "../shared/gateway-graph";
import type { GatewayEdits } from "../shared/gateway-graph";
import { CANVAS_NODE_TYPES } from "./canvas-nodes";
import { getErrorMessage, getProp } from "./utils";
import type { JsonObject, SurfaceExportPlugin, SurfaceExportState } from "./view-models";

/** A MiniMap dot per instance; host boxes stay neutral so the instances read as the content. */
function miniMapNodeColor(node: Node) {
	if (node.type !== "instance") {
		return "#2a2a2a";
	}
	return (node.data as { online?: boolean }).online ? "#1668dc" : "#5a5a5a";
}

/**
 * Gateway links, as the graph they actually are.
 *
 * Read-only for now: this renders the controller's config and nothing more. Editing (drawing an
 * edge stages both directions; a Save button flushes the dirty keys) lands next. Everything with a
 * decision in it lives in shared/gateway-graph.ts, which is unit-tested — this file is the wiring.
 */
export default function GatewayCanvas({ plugin, state }: {
	plugin: SurfaceExportPlugin;
	state: SurfaceExportState;
}) {
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	// `edits` is the model; the graph is a projection of it. Kept as the controller's own key shape so
	// a save is one setGatewayLink per changed key with no translation.
	const [edits, setEdits] = useState<GatewayEdits>({});

	const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
	const [edges, setEdges] = useEdgesState<Edge>([]);

	const tree = state?.tree;

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const response = (await plugin.getGateways()) as JsonObject;
			setEdits(editsFromLinks(getProp(response, "links", []) as never));
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

	const graph = useMemo(() => buildGraph(tree, edits), [tree, edits]);

	useEffect(() => {
		// preservePositions keeps the user's drags and selection across this rebuild. The tree is
		// re-pushed on every platform status change, so without it a node would snap back to its
		// layout position roughly once a second.
		setNodes(previous => preservePositions(previous, graph.nodes as unknown as Node[]));
		setEdges(graph.edges.map(edge => ({
			id: edge.id,
			source: edge.source,
			sourceHandle: edge.sourceHandle,
			target: edge.target,
			targetHandle: edge.targetHandle,
			// Direction is drawn, not implied. A config link may be one-way, and an edge that could
			// only say "connected" would render that as a two-way portal.
			markerEnd: edge.forward ? { type: MarkerType.ArrowClosed } : undefined,
			markerStart: edge.reverse ? { type: MarkerType.ArrowClosed } : undefined,
			data: { forward: edge.forward, reverse: edge.reverse },
		})));
	}, [graph, setNodes, setEdges]);

	if (loading && !nodes.length) {
		return <Spin style={{ margin: "24px auto", display: "block" }} />;
	}

	return (
		<div className="surface-export-canvas">
			{loadError ? <Alert type="error" showIcon message={loadError} style={{ marginBottom: 8 }} /> : null}
			{!loading && !nodes.length ? (
				<Empty description="No instances available — gateways can't be shown until the platform tree loads." />
			) : (
				<ReactFlow
					nodes={nodes}
					edges={edges}
					onNodesChange={onNodesChange}
					nodeTypes={CANVAS_NODE_TYPES}
					// Editing arrives in the next step; until then the canvas is a viewer, and saying so
					// with the real flags beats rendering handles that accept a drag going nowhere.
					nodesConnectable={false}
					edgesFocusable={false}
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
				</ReactFlow>
			)}
		</div>
	);
}
