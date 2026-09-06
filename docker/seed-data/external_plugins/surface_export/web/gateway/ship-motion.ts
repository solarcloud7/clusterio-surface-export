// Visual interpolation only: server status determines the endpoint, never elapsed time.
export const SHIP_TRAVEL_MS = 900;

export function shipTravelDuration(from: number, to: number): number {
	return Math.abs(to - from) * 2 * SHIP_TRAVEL_MS;
}

export function shipPosition(from: number, to: number, elapsedMs: number, durationMs: number): number {
	if (durationMs <= 0) return to;
	const t = Math.max(0, Math.min(1, elapsedMs / durationMs));
	const eased = t * t * (3 - 2 * t);
	return from + (to - from) * eased;
}
