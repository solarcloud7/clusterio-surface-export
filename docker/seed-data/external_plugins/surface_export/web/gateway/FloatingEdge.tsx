import {
	BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, getStraightPath, useInternalNode,
} from "@xyflow/react";
import type { EdgeProps, Position } from "@xyflow/react";

import { NODE_DIAMETER, instanceIdFromNodeId, peerPortalHandleId } from "./gateway-graph";
import { CAPTION_CLEARANCE, CAPTION_WIDTH, GATE_CENTRE_OFFSET_Y, endpointSide, floatingEdgeEndpoints, nodeFootprint } from "../../shared/edge-geometry";
import type { NodeCircle } from "../../shared/edge-geometry";
import { DEFAULT_EDGE_COLOUR } from "./gateway-colours";
import { DEFAULT_EDGE_SHAPE } from "./layout-store";
import type { EdgeShape } from "./layout-store";
import type { ShipTransfer } from "./transfer-motion";
import EdgeTransfers from "./EdgeTransfers";

type PortalNode = {
	internals?: {
		positionAbsolute?: { x: number; y: number };
		handleBounds?: { target?: Array<{ id?: string | null; x: number; y: number; width: number; height: number }> | null } | null;
	};
};

function portalCircle(node: PortalNode, handleId: string): { x: number; y: number; r: number } | null {
	const origin = node.internals?.positionAbsolute;
	const portal = node.internals?.handleBounds?.target?.find(handle => handle.id === handleId);
	if (!origin || !portal) {
		return null;
	}
	return {
		x: origin.x + portal.x + portal.width / 2,
		y: origin.y + portal.y + portal.height / 2,
		r: Math.min(portal.width, portal.height) / 2,
	};
}

export function towardRim(portal: { x: number; y: number; r: number }, from: { x: number; y: number }): { x: number; y: number } {
	const dx = from.x - portal.x;
	const dy = from.y - portal.y;
	const length = Math.hypot(dx, dy);
	if (length <= portal.r) {
		return { x: portal.x, y: portal.y };
	}
	return { x: portal.x + dx / length * portal.r, y: portal.y + dy / length * portal.r };
}

function sideTowards(from: { x: number; y: number }, to: { x: number; y: number }): Position {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return (dx >= 0 ? "right" : "left") as Position;
	}
	return (dy >= 0 ? "bottom" : "top") as Position;
}

function gatewayShape(node: { internals?: { positionAbsolute?: { x: number; y: number } }; measured?: { width?: number; height?: number } }): NodeCircle | null {
	return nodeFootprint(node.internals?.positionAbsolute, node.measured, NODE_DIAMETER, GATE_CENTRE_OFFSET_Y, CAPTION_CLEARANCE, CAPTION_WIDTH);
}

export default function FloatingEdge({
	id, source, target, markerStart, markerEnd, style, selected, data,
}: EdgeProps) {
	const sourceNode = useInternalNode(source);
	const targetNode = useInternalNode(target);

	if (!sourceNode || !targetNode) {
		return null;
	}

	const sourceCircle = gatewayShape(sourceNode);
	const targetCircle = gatewayShape(targetNode);
	if (!sourceCircle || !targetCircle) {
		return null;
	}

	const floating = floatingEdgeEndpoints(sourceCircle, targetCircle);
	let { sourceX, sourceY, targetX, targetY } = floating;
	let sourcePosition = endpointSide(sourceCircle, targetCircle) as Position;
	let targetPosition = endpointSide(targetCircle, sourceCircle) as Position;
	const sourceInstanceId = instanceIdFromNodeId(source);
	const targetInstanceId = instanceIdFromNodeId(target);
	const targetPortal = sourceInstanceId === null ? null : portalCircle(targetNode, peerPortalHandleId(sourceInstanceId));
	const sourcePortal = targetInstanceId === null ? null : portalCircle(sourceNode, peerPortalHandleId(targetInstanceId));
	const sourceAnchor = sourcePortal ?? { x: sourceX, y: sourceY };
	const targetAnchor = targetPortal ?? { x: targetX, y: targetY };
	if (targetPortal) {
		({ x: targetX, y: targetY } = towardRim(targetPortal, sourceAnchor));
	}
	if (sourcePortal) {
		({ x: sourceX, y: sourceY } = towardRim(sourcePortal, targetAnchor));
	}
	if (targetPortal || sourcePortal) {
		sourcePosition = sideTowards({ x: sourceX, y: sourceY }, { x: targetX, y: targetY });
		targetPosition = sideTowards({ x: targetX, y: targetY }, { x: sourceX, y: sourceY });
	}
	const geometry = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
	const shape = (data as { shape?: EdgeShape } | undefined)?.shape ?? DEFAULT_EDGE_SHAPE;
	const [path, labelX, labelY] = shape === "straight" ? getStraightPath({ sourceX, sourceY, targetX, targetY })
		: shape === "step" ? getSmoothStepPath({ ...geometry, borderRadius: 0 })
			: shape === "smoothstep" ? getSmoothStepPath(geometry)
				: getBezierPath(geometry);

	const edgeData = data as {
		colour?: string;
		headings?: Array<{ text: string; title: string; colour: string }>;
		transfers?: ShipTransfer[];
		sourceInstanceId?: number;
	} | undefined;
	const colour = edgeData?.colour || DEFAULT_EDGE_COLOUR;
	const anchorInstanceId = edgeData?.sourceInstanceId;
	const headings = edgeData?.headings || [];

	return (
		<>
		<BaseEdge
			id={id}
			path={path}
			markerStart={markerStart}
			markerEnd={markerEnd}
			interactionWidth={18}
			style={{
				...style,
				stroke: colour,
				strokeWidth: selected ? 3.5 : 2,
				cursor: "pointer",
			}}
			className="surface-export-edge"
		/>
		<EdgeLabelRenderer>
			<EdgeTransfers path={path} ships={edgeData?.transfers || []} anchorInstanceId={anchorInstanceId} />
			{headings.length ? (
				<div
					className="surface-export-edge-heading nodrag nopan"
					style={{ transform: `translate(-50%, -135%) translate(${labelX}px, ${labelY}px)` }}
				>
					{headings.map(heading => (
						<span key={heading.text} title={heading.title} style={{ color: heading.colour }}>{heading.text}</span>
					))}
				</div>
			) : null}
		</EdgeLabelRenderer>
		</>
	);
}
