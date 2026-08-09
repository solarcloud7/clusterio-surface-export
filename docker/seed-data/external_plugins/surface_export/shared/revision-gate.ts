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

/** What to do with a fetched snapshot: whether to show it, and what watermark it establishes. */
export type SnapshotDecision = {
	apply: boolean;
	/** The revision the snapshot establishes, or null when it carries none to establish. */
	watermark: number | null;
};

/**
 * Whether a fetched snapshot should replace what the page is showing.
 *
 * A push is one step of a stream and must be ordered to be meaningful. A snapshot is the whole
 * state, fetched on demand, so it is refused only when a push has already delivered something
 * strictly newer. One that carries no orderable revision is still shown: refusing it would blank
 * the page to protect an ordering that cannot be computed either way.
 */
export function decideSnapshot(revision: unknown, watermark: number): SnapshotDecision {
	// Only a finite number orders anything. Coercing first would read null and "" as revision zero,
	// which every watermark outranks — the exact reading that blanked the tree.
	if (typeof revision !== "number" || !Number.isFinite(revision)) {
		return { apply: true, watermark: null };
	}
	return revision > watermark ? { apply: true, watermark: revision } : { apply: false, watermark: null };
}
