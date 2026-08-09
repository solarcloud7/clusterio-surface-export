/**
 * Ordering rule for the web UI's live-update channels (tree, transfers, logs).
 *
 * Each update carries a revision, and the page applies one only when it is newer than what it has
 * already applied. A watermark is meaningful only against the counter that issued it, so it belongs
 * to a single controller session: reconnecting starts a new session and clears the watermarks.
 */

/** Highest revision applied on each live channel, within the current controller session. */
export type RevisionWatermarks = {
	lastTreeRevision: number;
	lastTransferRevision: number;
	lastLogRevision: number;
};

/** Watermarks for a session that has just (re)connected — nothing has been applied yet. */
export function freshRevisionWatermarks(): RevisionWatermarks {
	return {
		lastTreeRevision: 0,
		lastTransferRevision: 0,
		lastLogRevision: 0,
	};
}

/**
 * True when an update carrying `revision` is newer than the highest already applied on its channel.
 * A revision that is not a finite number carries no order, so it is refused rather than applied.
 */
export function isFreshRevision(revision: unknown, watermark: number): boolean {
	const value = Number(revision);
	return Number.isFinite(value) && value > watermark;
}
