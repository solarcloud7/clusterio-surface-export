import React from "react";
import { BaseEdge, getBezierPath, useInternalNode } from "@xyflow/react";
import type { EdgeProps, Position } from "@xyflow/react";

import { NODE_DIAMETER } from "./gateway-graph";
import { endpointSide, floatingEdgeEndpoints, nodeCircle } from "./edge-geometry";
import { DEFAULT_EDGE_COLOUR, gatewayColour } from "./gateway-colours";

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

	const sourceCircle = nodeCircle(sourceNode.internals?.positionAbsolute, sourceNode.measured, NODE_DIAMETER);
	const targetCircle = nodeCircle(targetNode.internals?.positionAbsolute, targetNode.measured, NODE_DIAMETER);
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

	const colour = gatewayColour((data as { sourceGateway?: string } | undefined)?.sourceGateway) || DEFAULT_EDGE_COLOUR;

	return (
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
	);
}
