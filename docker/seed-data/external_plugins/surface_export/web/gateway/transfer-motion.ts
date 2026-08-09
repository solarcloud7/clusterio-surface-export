import type { TransferSummary } from "../view-models";

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

const LEGEND_LABELS: Record<ShipTone, string> = {
	active: "in transit",
	holding: "validating",
	success: "arrived",
	failure: "failed",
};

export const SHIP_LEGEND: Array<{ tone: ShipTone; label: string }> =
	(Object.keys(LEGEND_LABELS) as ShipTone[]).map(tone => ({ tone, label: LEGEND_LABELS[tone] }));

export const TERMINAL_LINGER_MS = 6000;

export const SHIP_TRAVEL_MS = 900;

const SHIP_MEMORY_CAP = 32;
const shipMemory = new Map<string, { terminalSeenAt?: number; seenLive?: boolean }>();

function shipMemoryFor(transferId: string) {
	let entry = shipMemory.get(transferId);
	if (!entry) {
		entry = {};
		shipMemory.set(transferId, entry);
		if (shipMemory.size > SHIP_MEMORY_CAP) {
			const oldest = shipMemory.keys().next();
			if (!oldest.done) {
				shipMemory.delete(oldest.value);
			}
		}
	}
	return entry;
}

export function noteLiveSeen(transferId: string): void {
	shipMemoryFor(transferId).seenLive = true;
}

export function noteTerminalSeen(transferId: string, nowMs: number): void {
	const entry = shipMemoryFor(transferId);
	if (entry.terminalSeenAt === undefined) {
		entry.terminalSeenAt = nowMs;
	}
}

export function shipExpiryMs(summary: TransferSummary, nowMs: number): number | null {
	const phase = shipPhaseFor(summary.status);
	if (!phase || !phase.terminal) {
		return null;
	}
	const entry = shipMemory.get(summary.transferId);
	if (!entry?.seenLive) {
		return 0;
	}
	return (entry.terminalSeenAt ?? nowMs) + TERMINAL_LINGER_MS;
}

export type ShipTransfer = TransferSummary & { sourceInstanceId: number; targetInstanceId: number };

export function shipsInFlight(summaries: readonly TransferSummary[] | null | undefined, nowMs: number): ShipTransfer[] {
	return (summaries || []).filter((summary): summary is ShipTransfer => {
		if (summary.operationType !== "transfer") {
			return false;
		}
		if (!Number.isFinite(summary.sourceInstanceId) || !Number.isFinite(summary.targetInstanceId)) {
			return false;
		}
		if (!shipPhaseFor(summary.status)) {
			return false;
		}
		const expiry = shipExpiryMs(summary, nowMs);
		return expiry === null || expiry > nowMs;
	});
}

export function instancePairKey(a: number, b: number): string {
	return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

export function transientEdgeId(transferId: string): string {
	return `xfer:${transferId}`;
}
