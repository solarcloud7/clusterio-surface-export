export const GATE_CENTRE_OFFSET_Y = -16;

export const PORTAL_DIAMETER_FRACTION = 0.6;

export const CAPTION_CLEARANCE = 45;

export const EDGE_END_GAP = 4;

export type NodeCircle = {
	x: number;
	y: number;
	radius: number;
	bounds?: { left: number; right: number; top: number; bottom: number };
};

export type EdgeEndpoints = {
	sourceX: number;
	sourceY: number;
	targetX: number;
	targetY: number;
};

export function nodeCircle(
	position: { x: number; y: number } | null | undefined,
	measured: { width?: number; height?: number } | null | undefined,
	fallbackDiameter: number,
	offsetY = 0,
): NodeCircle | null {
	if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
		return null;
	}
	const width = measured?.width || fallbackDiameter;
	const height = measured?.height || fallbackDiameter;
	return {
		x: position.x + width / 2,
		y: position.y + height / 2 + offsetY,
		radius: Math.min(width, height) / 2,
	};
}

export function nodeFootprint(
	position: { x: number; y: number } | null | undefined,
	measured: { width?: number; height?: number } | null | undefined,
	fallbackDiameter: number,
	offsetY = 0,
	captionClearance = 0,
): NodeCircle | null {
	const circle = nodeCircle(position, measured, fallbackDiameter, offsetY);
	if (!circle || !position) {
		return null;
	}
	const width = measured?.width || fallbackDiameter;
	const height = measured?.height || fallbackDiameter;
	return {
		...circle,
		bounds: {
			left: position.x,
			right: position.x + width,
			top: position.y - captionClearance - EDGE_END_GAP,
			bottom: position.y + height + EDGE_END_GAP,
		},
	};
}

function exitDistance(shape: NodeCircle, ux: number, uy: number): number {
	if (!shape.bounds) {
		return shape.radius;
	}
	const { left, right, top, bottom } = shape.bounds;
	const alongX = ux > 0 ? (right - shape.x) / ux : ux < 0 ? (left - shape.x) / ux : Infinity;
	const alongY = uy > 0 ? (bottom - shape.y) / uy : uy < 0 ? (top - shape.y) / uy : Infinity;
	return Math.max(shape.radius, Math.min(alongX, alongY));
}

export function floatingEdgeEndpoints(source: NodeCircle, target: NodeCircle): EdgeEndpoints {
	const dx = target.x - source.x;
	const dy = target.y - source.y;
	const distance = Math.hypot(dx, dy);
	if (distance === 0) {
		return { sourceX: source.x, sourceY: source.y, targetX: target.x, targetY: target.y };
	}
	const ux = dx / distance;
	const uy = dy / distance;
	const sourceDistance = exitDistance(source, ux, uy);
	const targetDistance = exitDistance(target, -ux, -uy);
	return {
		sourceX: source.x + ux * sourceDistance,
		sourceY: source.y + uy * sourceDistance,
		targetX: target.x - ux * targetDistance,
		targetY: target.y - uy * targetDistance,
	};
}

export function endpointSide(from: NodeCircle, toward: NodeCircle): "top" | "right" | "bottom" | "left" {
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? "right" : "left";
	}
	return dy >= 0 ? "bottom" : "top";
}
