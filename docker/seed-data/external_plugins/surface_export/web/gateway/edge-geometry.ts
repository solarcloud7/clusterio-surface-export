export const GATE_CENTRE_OFFSET_Y = -16;

export const PORTAL_DIAMETER_FRACTION = 0.6;

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

export function endpointSide(from: NodeCircle, toward: NodeCircle): "top" | "right" | "bottom" | "left" {
	const dx = toward.x - from.x;
	const dy = toward.y - from.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? "right" : "left";
	}
	return dy >= 0 ? "bottom" : "top";
}
