export type ShipTone = "active" | "holding" | "success" | "failure";

export interface ShipPhase {
	distance: number;
	holding: boolean;
	opening: boolean;
	terminal: boolean;
	tone: ShipTone;
	label: string;
}

const PHASES: Record<string, ShipPhase> = {
	transporting: {
		distance: 0.5, holding: false, opening: true, terminal: false,
		tone: "active", label: "in transit",
	},
	awaiting_validation: {
		distance: 0.5, holding: true, opening: false, terminal: false,
		tone: "holding", label: "validating",
	},
	completed: {
		distance: 1, holding: false, opening: false, terminal: true,
		tone: "success", label: "arrived",
	},
	failed: {
		distance: 0, holding: false, opening: false, terminal: true,
		tone: "failure", label: "failed — returned",
	},
	error: {
		distance: 0, holding: false, opening: false, terminal: true,
		tone: "failure", label: "timed out — returned",
	},
	cleanup_failed: {
		distance: 1, holding: false, opening: false, terminal: true,
		tone: "failure", label: "arrived — cleanup failed",
	},
};

export function shipPhaseFor(status: string | null | undefined): ShipPhase | null {
	return (status && PHASES[status]) || null;
}

export interface PositionedTransfer {
	status?: string;
	platformName?: string;
}

export interface EdgeStatusMarker {
	key: string;
	tone: ShipTone;
	distance: number;
	count: number;
	label: string;
	platformNames: string[];
}

export interface EdgeShipGroups<T> {
	transit: T[];
	markers: EdgeStatusMarker[];
}

export function groupEdgeShips<T extends PositionedTransfer>(
	ships: readonly T[],
	isReversed: (ship: T) => boolean,
): EdgeShipGroups<T> {
	const transit: T[] = [];
	const byPosition = new Map<string, EdgeStatusMarker>();
	for (const ship of ships) {
		const phase = shipPhaseFor(ship.status);
		if (!phase) {
			continue;
		}
		if (!phase.terminal && !phase.holding) {
			transit.push(ship);
			continue;
		}
		const distance = isReversed(ship) ? 1 - phase.distance : phase.distance;
		const key = `${ship.status}@${distance}`;
		const marker = byPosition.get(key);
		if (marker) {
			marker.count += 1;
			marker.platformNames.push(ship.platformName || "platform");
		} else {
			byPosition.set(key, {
				key,
				tone: phase.tone,
				distance,
				count: 1,
				label: phase.label,
				platformNames: [ship.platformName || "platform"],
			});
		}
	}
	return { transit, markers: [...byPosition.values()] };
}
