export type ShipTone = "queued" | "active" | "holding" | "success" | "failure";

export interface ShipPhase {
	distance: number;
	holding: boolean;
	opening: boolean;
	terminal: boolean;
	tone: ShipTone;
	label: string;
}

const PHASES: Record<string, ShipPhase> = {
	queued: {
		distance: 0, holding: true, opening: false, terminal: false,
		tone: "queued", label: "queued",
	},
	preparing: {
		distance: 0, holding: true, opening: false, terminal: false,
		tone: "active", label: "preparing export",
	},
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
		distance: 0.5, holding: false, opening: false, terminal: true,
		tone: "failure", label: "transfer failed",
	},
	error: {
		distance: 0.5, holding: false, opening: false, terminal: true,
		tone: "failure", label: "transfer error",
	},
	cleanup_failed: {
		distance: 0.5, holding: true, opening: false, terminal: false,
		tone: "failure", label: "cleanup needs attention",
	},
};

/** Presentation only: midpoint means unresolved location, never ownership authority. */
export function shipPhaseFor(transfer: string | PositionedTransfer | null | undefined): ShipPhase | null {
	const status = typeof transfer === "object" ? transfer?.status : transfer;
	if (transfer && typeof transfer === "object") {
		if (transfer.timingPendingRecovery) return {
			distance: 0.5, holding: true, opening: false, terminal: false,
			tone: "failure", label: "recovery needs attention",
		};
		if (transfer.sourceRestored && (status === "failed" || status === "error")) return {
			distance: 0, holding: false, opening: false, terminal: true,
			tone: "failure", label: "failed — returned",
		};
	}
	return (status && PHASES[status]) || null;
}

export interface PositionedTransfer {
	timingPendingRecovery?: boolean;
	sourceRestored?: boolean;
	jobObservation?: import("./job-status").JobObservation;
	status?: string;
	platformName?: string;
}

export interface EdgeStatusMarker {
	key: string;
	terminal: boolean;
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
	isSettled: (ship: T) => boolean = () => true,
): EdgeShipGroups<T> {
	const transit: T[] = [];
	const byPosition = new Map<string, EdgeStatusMarker>();
	for (const ship of ships) {
		const phase = shipPhaseFor(ship);
		if (!phase) {
			continue;
		}
		if ((!phase.terminal && !phase.holding) || !isSettled(ship)) {
			transit.push(ship);
			continue;
		}
		const distance = isReversed(ship) ? 1 - phase.distance : phase.distance;
		const label = !ship.timingPendingRecovery && !phase.terminal && ship.status !== "cleanup_failed" && ship.jobObservation
			? `${ship.jobObservation.message}${ship.jobObservation.phase ? ` · ${ship.jobObservation.phase}` : ""}` : phase.label;
		const key = `${ship.status}@${distance}@${label}`;
		const marker = byPosition.get(key);
		if (marker) {
			marker.count += 1;
			marker.platformNames.push(ship.platformName || "platform");
		} else {
			byPosition.set(key, {
				key,
				terminal: phase.terminal,
				tone: phase.tone,
				distance,
				count: 1,
				label,
				platformNames: [ship.platformName || "platform"],
			});
		}
	}
	return { transit, markers: [...byPosition.values()] };
}
