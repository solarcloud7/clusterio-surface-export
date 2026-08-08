/**
 * Where a floating edge meets a node.
 *
 * A FIXED-handle edge always leaves from the same point no matter where the other node is, so two
 * nodes side by side get an edge that loops out of the top and back down. A floating edge instead
 * attaches wherever the node's boundary faces its partner, which is what makes a free-form graph
 * read correctly however the operator drags things around.
 *
 * React Flow's own floating-edge example intersects a RECTANGLE, because its nodes are boxes. Ours
 * are circles — an instance node is a round gateway — so the intersection is just
 * `centre + unit-vector * radius`, with none of the four-edge case analysis. Simpler, and correct
 * for the shape we actually draw.
 */

/**
 * How far the portal sits above the middle of its node box, in node pixels.
 *
 * The art is a portal standing on a pedestal, so the glowing disc — the thing a person points at
 * when they say “the middle of the portal” — is well above the box centre. MEASURED on
 * gateway-hub-128.png: the luminance-weighted centroid of the bright, blue-dominant, saturated
 * pixels (3854 of 16384) sits at y=50.1 of 128 against a box centre of 63.5, which is 15.7px scaled
 * to the 150px node. Rounded to 16.
 *
 * Isolating the GLOW matters: the alpha centroid of every visible pixel lands +4.4px the other way
 * and the opaque bounding box is dead centre, both dragged down by the pedestal, and both would
 * anchor the gateway on its base instead of its portal.
 *
 * NEGATIVE is up, matching screen coordinates. Used for BOTH the portal hit-zone and the point an
 * edge attaches to, so a link leaves from where it looks like it should.
 */
export const GATE_CENTRE_OFFSET_Y = -16;

/**
 * Diameter of the portal, as a fraction of the node.
 *
 * From the same measurement: 90% of the glow lies within radius 38.1 of 128, i.e. 44.7px on a 150px
 * node — so a disc of 60% covers the glow and stops before the stone rim around it.
 */
export const PORTAL_DIAMETER_FRACTION = 0.6;

/** A node reduced to what the geometry needs: its centre and how far its edge sits from it. */
export type NodeCircle = {
	x: number;
	y: number;
	radius: number;
};

export type EdgeEndpoints = {
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
};

/** Centre and inscribed radius of a node, from React Flow's absolute position and measured size. */
export function nodeCircle(
	position: { x: number; y: number } | null | undefined,
	measured: { width?: number; height?: number } | null | undefined,
	fallbackDiameter: number,
	offsetY = 0,
): NodeCircle | null {
	if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
		return null;
	}
	// A node that has not been measured yet reports undefined rather than 0; falling back to the
	// known layout diameter keeps the first frame from collapsing every edge onto node centres.
	const width = measured?.width || fallbackDiameter;
	const height = measured?.height || fallbackDiameter;
	return {
		x: position.x + width / 2,
		y: position.y + height / 2 + offsetY,
		// Inscribed, not circumscribed: the drawn circle fits INSIDE the square node box, so half the
		// smaller side is where the visible edge actually is.
		radius: Math.min(width, height) / 2,
	};
}

/**
 * The two points where the straight line between two node centres crosses their boundaries.
 *
 * Concentric nodes (a node connected to itself, or two nodes dragged exactly on top of each other)
 * have no meaningful direction, so both points collapse to the centres rather than producing NaN
 * from a divide-by-zero — an edge that vanishes is recoverable, an edge full of NaN takes the whole
 * SVG path with it.
 */
export function floatingEdgeEndpoints(source: NodeCircle, target: NodeCircle): EdgeEndpoints {
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	const distance = Math.hypot(dx, dy);
	if (distance === 0) {
		return { sourceX: source.x, sourceY: source.y, targetX: target.x, targetY: target.y };
	}
	const ux = dx / distance;
	const uy = dy / distance;
	return {
		sourceX: source.x + ux * source.radius,
		sourceY: source.y + uy * source.radius,
		targetX: target.x - ux * target.radius,
		targetY: target.y - uy * target.radius,
	};
}

/**
 * Which side of the node each endpoint sits on, as React Flow's Position strings.
 *
 * Only used to pick a sensible bezier curvature — the path's control points lean along the reported
 * side. Chosen by the DOMINANT axis so a mostly-horizontal edge curves horizontally.
 */
export function endpointSide(from: NodeCircle, toward: NodeCircle): "top" | "right" | "bottom" | "left" {
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? "right" : "left";
	}
	return dy >= 0 ? "bottom" : "top";
}
