import React from "react";
import {
	BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, getStraightPath, useInternalNode,
} from "@xyflow/react";
import type { EdgeProps, Position } from "@xyflow/react";

import { NODE_DIAMETER } from "./gateway-graph";
import { GATE_CENTRE_OFFSET_Y, endpointSide, floatingEdgeEndpoints, nodeCircle } from "./edge-geometry";
import { DEFAULT_EDGE_COLOUR, gatewayColour } from "./gateway-colours";
import { DEFAULT_EDGE_SHAPE } from "./layout-store";
import type { EdgeShape } from "./layout-store";
import { groupEdgeShips, shipPhaseFor } from "./transfer-motion";
import type { ShipTransfer } from "./transfer-motion";
import TransferShip from "./TransferShip";
import EdgeStatusMarker from "./EdgeStatusMarker";

export default function FloatingEdge({
	id, source, target, markerStart, markerEnd, style, selected, data,
}: EdgeProps) {
	const sourceNode = useInternalNode(source);
	const targetNode = useInternalNode(target);

	if (!sourceNode || !targetNode) {
		return null;
	}

	const sourceCircle = nodeCircle(sourceNode.internals?.positionAbsolute, sourceNode.measured, NODE_DIAMETER, GATE_CENTRE_OFFSET_Y);
	const targetCircle = nodeCircle(targetNode.internals?.positionAbsolute, targetNode.measured, NODE_DIAMETER, GATE_CENTRE_OFFSET_Y);
	if (!sourceCircle || !targetCircle) {
		return null;
	}

	const { sourceX, sourceY, targetX, targetY } = floatingEdgeEndpoints(sourceCircle, targetCircle);
	const geometry = {
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition: endpointSide(sourceCircle, targetCircle) as Position,
		targetPosition: endpointSide(targetCircle, sourceCircle) as Position,
	};
	const shape = (data as { shape?: EdgeShape } | undefined)?.shape ?? DEFAULT_EDGE_SHAPE;
	const [path] = shape === "straight" ? getStraightPath({ sourceX, sourceY, targetX, targetY })
		: shape === "step" ? getSmoothStepPath({ ...geometry, borderRadius: 0 })
			: shape === "smoothstep" ? getSmoothStepPath(geometry)
				: getBezierPath(geometry);

	const edgeData = data as {
		sourceGateway?: string;
		transfers?: ShipTransfer[];
		sourceInstanceId?: number;
	} | undefined;
	const colour = gatewayColour(edgeData?.sourceGateway) || DEFAULT_EDGE_COLOUR;
	const anchorInstanceId = edgeData?.sourceInstanceId;
	const { transit, markers } = groupEdgeShips<ShipTransfer>(
		edgeData?.transfers || [],
		ship => anchorInstanceId !== undefined && ship.sourceInstanceId !== anchorInstanceId,
	);

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
		{}
		<EdgeLabelRenderer>
			{transit.length ? transit.map(ship => (
				<TransferShip
					key={ship.transferId}
					path={path}
					phase={shipPhaseFor(ship.status)}
					reversed={anchorInstanceId !== undefined && ship.sourceInstanceId !== anchorInstanceId}
					summary={ship}
				/>
			)) : <TransferShip key="idle" path={path} phase={null} reversed={false} />}
			{markers.map(marker => (
				<EdgeStatusMarker key={marker.key} path={path} marker={marker} />
			))}
		</EdgeLabelRenderer>
		</>
	);
}
