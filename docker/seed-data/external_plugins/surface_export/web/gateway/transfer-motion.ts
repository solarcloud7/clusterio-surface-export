/**
 * Where a transfer's ship sits on its edge — and why the position is a PHASE, never a clock.
 *
 * THE CONSTRAINT THIS FILE EXISTS TO HOLD: we do not measure continuous progress. The controller
 * emits many updates during a transfer, but a transfer only passes through two distinct in-flight
 * statuses (see PHASES below, each cited to where it is set). Animating at a constant speed across
 * the edge would therefore be inventing progress: the ship would arrive while the destination gate
 * was still running, or sit frozen for forty seconds on a large payload — the transfer is
 * RCON-throughput-bound, so its duration is not knowable in advance.
 *
 * So each status is a CHECKPOINT. The ship moves only when a real event moves it, and holds
 * (pulsing) in between. Its position is then always something we measured.
 *
 * Pure — no React, no @xyflow — so the rule is readable without the rendering around it.
 */

import type { TransferSummary } from "../view-models";

export type ShipTone = "active" | "holding" | "success" | "failure";

export interface ShipPhase {
	/** 0 = source end of the journey, 1 = destination end. NOT the edge's own orientation. */
	distance: number;
	/** True where we are not measuring progress: the ship holds here and pulses. */
	holding: boolean;
	/** True only for the status a transfer is CREATED with — see `opening` in the doc below. */
	opening: boolean;
	/** No further movement is coming; used to time the ship off the canvas. */
	terminal: boolean;
	tone: ShipTone;
	/** Shown on the ship and in its tooltip. Plain words, not the raw status token. */
	label: string;
}

/**
 * Every status a TRANSFER can hold, mapped to a position.
 *
 * Enumerated at the emitter rather than from one observed run: `TransferStatus` (messages.ts) lists
 * nine values, but four of them belong to other operations —`awaiting_completion` is the
 * upload-import path (controller.ts, handleImportUploadedExportRequest), `in_progress` is the
 * default for export/import operation records (lib/operation-record.ts), and `unknown` is a
 * fallback. What is left is what a transfer actually passes through:
 *
 *   transporting        lib/transfer-orchestrator.ts, at creation in transferPlatform
 *   awaiting_validation lib/transfer-orchestrator.ts, enterAwaitingValidation
 *   completed           lib/transfer-orchestrator.ts, handleValidationSuccess
 *   failed              lib/transfer-orchestrator.ts, handleImportFailure
 *   error               lib/transfer-orchestrator.ts, validation timeout
 *   cleanup_failed      lib/transfer-orchestrator.ts, handleTransferValidation / handleValidationSuccess
 *
 * A status NOT in this map draws no ship at all, which is the right failure mode: a position we
 * cannot justify is worse than no position.
 */
const PHASES: Record<string, ShipPhase> = {
	// The payload is genuinely in transit — export, RCON transmission, import submission.
	transporting: {
		distance: 0.5, holding: false, opening: true, terminal: false,
		tone: "active", label: "in transit",
	},
	// It has LANDED on the destination and the frozen-world gate is running. Nothing is moving, so
	// neither is the ship: it holds at the midpoint and pulses.
	awaiting_validation: {
		distance: 0.5, holding: true, opening: false, terminal: false,
		tone: "holding", label: "validating",
	},
	completed: {
		distance: 1, holding: false, opening: false, terminal: true,
		tone: "success", label: "arrived",
	},
	// BACK TO THE SOURCE, and this is not decoration: the two-phase commit preserves the source on
	// failure, so the platform really is still where it started. A ship stranded mid-edge would
	// describe a state the system does not have.
	failed: {
		distance: 0, holding: false, opening: false, terminal: true,
		tone: "failure", label: "failed — returned",
	},
	error: {
		distance: 0, holding: false, opening: false, terminal: true,
		tone: "failure", label: "timed out — returned",
	},
	// The verdict PASSED and the platform is on the destination; only the cleanup did not finish.
	// So it arrives — marked, not returned.
	cleanup_failed: {
		distance: 1, holding: false, opening: false, terminal: true,
		tone: "failure", label: "arrived — cleanup failed",
	},
};

export function shipPhaseFor(status: string | null | undefined): ShipPhase | null {
	return (status && PHASES[status]) || null;
}

/**
 * How long a finished ship stays on the canvas.
 *
 * Long enough to watch it arrive (or come back) after the status that moved it, short enough that
 * the canvas is not littered with the day's history. The travel itself is SHIP_TRAVEL_MS, so this
 * has to comfortably exceed it.
 */
export const TERMINAL_LINGER_MS = 6000;

/** Duration of one leg. Mirrored by the CSS transition on `offset-distance` — keep them equal. */
export const SHIP_TRAVEL_MS = 900;

/**
 * What we remember about a transfer BEYOND what its summary says.
 *
 * Both fields are about WHEN WE SAW THINGS, which the wire cannot tell us:
 *
 * `seenLive` — we watched it in flight. Only such a transfer earns an arrival animation.
 * `terminalSeenAt` — when we first saw it finish, which is not any timestamp on the wire.
 *
 * There is deliberately no "last position" here. An earlier version carried one, to let a ship
 * remounted mid-journey resume from where the old element was — but the remounting turned out to be
 * self-inflicted (a conditional in FloatingEdge), and once the element simply stays mounted the
 * position lives where it belongs: in the DOM node the CSS transition is running on. Keeping the
 * memory as a fallback would have been a second, quietly diverging answer to "where is the ship".
 *
 * Bounded rather than cleaned up: entries are a number and a flag, a canvas holds a handful of live
 * transfers, and eviction by insertion order cannot strand anything that is still being drawn.
 */
const SHIP_MEMORY_CAP = 32;
const shipMemory = new Map<string, { terminalSeenAt?: number; seenLive?: boolean }>();

function shipMemoryFor(transferId: string) {
	let entry = shipMemory.get(transferId);
	if (!entry) {
		entry = {};
		shipMemory.set(transferId, entry);
		if (shipMemory.size > SHIP_MEMORY_CAP) {
			// Map iteration is insertion-ordered, so this drops the least recently ADDED transfer.
			const oldest = shipMemory.keys().next();
			if (!oldest.done) {
				shipMemory.delete(oldest.value);
			}
		}
	}
	return entry;
}

/**
 * Record that this transfer was seen IN FLIGHT. Only such a transfer earns an arrival animation.
 *
 * This is what separates "a transfer finished while you were watching" from "the transaction log
 * contains a thousand finished transfers". Without it, the rule below (an unseen terminal is dated
 * to now) treats every row of history as if it had just landed — measured, on a fresh page load
 * that put 51 EDGES on a two-instance canvas.
 */
export function noteLiveSeen(transferId: string): void {
	shipMemoryFor(transferId).seenLive = true;
}

/**
 * Record that this transfer has been SEEN finished. Idempotent — the first sighting is the one that
 * counts, so a re-render can never push the deadline out.
 *
 * Called from an effect rather than during render, which keeps `shipExpiryMs` a pure read.
 */
export function noteTerminalSeen(transferId: string, nowMs: number): void {
	const entry = shipMemoryFor(transferId);
	if (entry.terminalSeenAt === undefined) {
		entry.terminalSeenAt = nowMs;
	}
}

/**
 * When a terminal transfer should stop being drawn, or null while it is still in flight.
 *
 * A terminal transfer we never saw in flight is HISTORY, not an arrival: it expired before we
 * existed, so it is never drawn. Everything else is dated from when we first saw it finish, never
 * from a wire timestamp — a summary rebuilt from a trimmed log can be missing `completedAt`
 * entirely, and the original fallback chain ended at `startedAt`, which for any transfer slower
 * than the linger window is a deadline already in the past. Measured: an 18 s transfer went from
 * holding at 50% straight to gone, never showing its arrival.
 */
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

/**
 * A transfer that is safe to draw as a journey.
 *
 * `TransferSummary` is `Partial<TransferSummaryModel>`, so both endpoint ids are optional on the
 * wire type — a summary rebuilt from a trimmed persisted log can genuinely lack them. Narrowing
 * here, ONCE, at the filter that already has to check them, is what keeps every consumer from
 * either casting or re-checking; a ship without two endpoints has no line to ride.
 */
export type ShipTransfer = TransferSummary & { sourceInstanceId: number; targetInstanceId: number };

/**
 * Which transfers to draw right now.
 *
 * Only `transfer` operations: an export has no destination to travel to, and an import has no
 * source — drawing either as a journey between two instances would be a picture of something that
 * did not happen.
 */
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

/**
 * Unordered instance-pair key, for matching a transfer to the edge it should ride.
 *
 * Unordered because an edge is one line for both directions; the travel direction comes from the
 * transfer's own source/target, not from this.
 */
export function instancePairKey(a: number, b: number): string {
	return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * The id for the edge drawn only because a transfer is using it.
 *
 * A SEPARATE NAMESPACE ON PURPOSE. Config edge ids are built by `edgeId()` from
 * `instance/gateway` endpoint keys and deduped through a Map — a transient edge that happened to
 * collide with a config edge would silently replace it, and the link would vanish from the canvas
 * for the length of a transfer. Prefixing with the transfer id makes a collision impossible.
 */
export function transientEdgeId(transferId: string): string {
	return `xfer:${transferId}`;
}
