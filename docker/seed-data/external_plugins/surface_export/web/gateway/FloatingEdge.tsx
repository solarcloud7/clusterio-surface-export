import React from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useInternalNode } from "@xyflow/react";
import type { EdgeProps, Position } from "@xyflow/react";

import { NODE_DIAMETER } from "./gateway-graph";
import { GATE_CENTRE_OFFSET_Y, endpointSide, floatingEdgeEndpoints, nodeCircle } from "./edge-geometry";
import { DEFAULT_EDGE_COLOUR, gatewayColour } from "./gateway-colours";
import { shipPhaseFor } from "./transfer-motion";
import type { ShipTransfer } from "./transfer-motion";
import TransferShip from "./TransferShip";

/**
 * An edge that attaches wherever the two nodes FACE each other, rather than to a fixed handle.
 *
 * A fixed-handle edge always leaves from the same point, so two nodes side by side get a line that
 * loops out of the top and back down; drag them around and it only gets worse. Floating keeps the
 * link reading as a link at any layout.
 *
 * The geometry is in edge-geometry.ts next door rather than inline here, so this file stays about
 * rendering and that one stays about maths.
 */
export default function FloatingEdge({
	id, source, target, markerStart, markerEnd, style, selected, data,
}: EdgeProps) {
	const sourceNode = useInternalNode(source);
	const targetNode = useInternalNode(target);

	// Both nodes must be mounted and positioned before an edge between them means anything. React
	// Flow renders edges and nodes in the same pass, so this is a real state on the first frame, not
	// a defensive nicety.
	if (!sourceNode || !targetNode) {
		return null;
	}

	// Anchored on the GATE, not the node box: the art is bottom-heavy, so a box-centred edge leaves
	// from below the portal it is supposed to come out of.
	const sourceCircle = nodeCircle(sourceNode.internals?.positionAbsolute, sourceNode.measured, NODE_DIAMETER, GATE_CENTRE_OFFSET_Y);
	const targetCircle = nodeCircle(targetNode.internals?.positionAbsolute, targetNode.measured, NODE_DIAMETER, GATE_CENTRE_OFFSET_Y);
	if (!sourceCircle || !targetCircle) {
		return null;
	}

	const { sourceX, sourceY, targetX, targetY } = floatingEdgeEndpoints(sourceCircle, targetCircle);
	const [path] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition: endpointSide(sourceCircle, targetCircle) as Position,
		targetPosition: endpointSide(targetCircle, sourceCircle) as Position,
	});

	const edgeData = data as {
		sourceGateway?: string;
		/** The transfer riding this edge right now, assigned by GatewayCanvas. */
		transfer?: ShipTransfer;
		/** True when that transfer runs against this edge's canonical orientation. */
		transferReversed?: boolean;
	} | undefined;
	const colour = gatewayColour(edgeData?.sourceGateway) || DEFAULT_EDGE_COLOUR;
	// A status with no mapped phase draws NO ship. A position we cannot justify from a measured
	// status would be worse than none — see transfer-motion.ts.
	const shipPhase = shipPhaseFor(edgeData?.transfer?.status);

	return (
		<>
		<BaseEdge
			id={id}
			path={path}
			markerStart={markerStart}
			markerEnd={markerEnd}
			// interactionWidth widens the INVISIBLE hit area without thickening the drawn line, which
			// is what makes a 2px edge clickable without demanding pixel accuracy. Clicking removes the
			// link, so it needs to be easy to hit deliberately and hard to hit by accident — 18 is the
			// library default and is already tuned for that.
			interactionWidth={18}
			style={{
				...style,
				stroke: colour,
				strokeWidth: selected ? 3.5 : 2,
				// The class carries the dash animation; see .surface-export-edge-flow in web/style.css.
				cursor: "pointer",
			}}
			className="surface-export-edge"
		/>
		{shipPhase && edgeData?.transfer ? (
			<EdgeLabelRenderer>
				{/* Keyed on the transfer so a NEW transfer gets a fresh component — and therefore a fresh
				    first-sight decision — rather than sliding in from wherever the last one ended. */}
				<TransferShip
					key={edgeData.transfer.transferId}
					path={path}
					phase={shipPhase}
					reversed={Boolean(edgeData.transferReversed)}
					summary={edgeData.transfer}
				/>
			</EdgeLabelRenderer>
		) : null}
		</>
	);
}
