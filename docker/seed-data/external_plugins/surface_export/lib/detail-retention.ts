import type { PersistedTransactionLog } from "../messages";

/**
 * Which fat detail entries the transaction-log store keeps.
 *
 * Retention only became possible once the audit ledger existed. Before it, trimming this store meant
 * erasing the only evidence a transfer ever happened; now every transfer keeps a slim ledger row for
 * good and this file is a WINDOW of expensive detail — events, phase timings, validation count maps —
 * over the transfers where that detail is still worth its size.
 *
 * The cap is on ENTRY COUNT rather than bytes. Entry size varies (measured median 9.3 KB, max 19.3 KB
 * on a real store), so a count cap gives a predictable ceiling that an operator can reason about
 * without knowing anything about payload shapes: cap x max-entry is the worst case, and at the
 * default that is ~1.9 MB compact against the 4.72 MB unbounded store this replaced.
 */

/**
 * Successes are guaranteed this many slots. Without a floor, a burst of failures would evict every
 * example of a healthy transfer — and comparing a reported failure against a known-good run of the
 * same platform is the first thing anyone does when debugging one.
 */
export const RESERVED_SUCCESS_SLOTS = 25;

const FAILURE_STATUSES = new Set(["failed", "cleanup_failed", "error"]);

export type RetentionOptions = {
	cap: number;
	/**
	 * Whether this entry's export payload is still downloadable. Such entries are PINNED: the
	 * Transaction Logs tab offers a download for them, and dropping the detail while the payload is
	 * still there would revoke a button that was working a moment ago. Bounded in practice by
	 * `max_storage_size` (default 20), so this can never crowd out the whole window.
	 */
	isPinned: (entry: PersistedTransactionLog) => boolean;
	reservedSuccessSlots?: number;
};

function savedAtOf(entry: PersistedTransactionLog): number {
	return entry.savedAt || entry.transferInfo?.startedAt || 0;
}

function isFailure(entry: PersistedTransactionLog): boolean {
	return FAILURE_STATUSES.has(String(entry.transferInfo?.status || ""));
}

/**
 * Pick the entries to keep, newest-first within each class.
 *
 * Order of claim on the budget:
 *   1. PINNED — payload still downloadable, so the detail must not disappear from under it.
 *   2. SUCCESSES up to the reserved floor — so a failure burst cannot erase every healthy example.
 *   3. FAILURES, newest first — the debug-and-report workflow.
 *   4. whatever is left, newest first regardless of class.
 *
 * Returns entries in their ORIGINAL order, not selection order: the file is an array that other
 * readers index into, and reordering it would be a gratuitous diff for every consumer.
 */
export function selectRetainedDetail(
	entries: PersistedTransactionLog[],
	options: RetentionOptions,
): PersistedTransactionLog[] {
	const cap = Number.isFinite(options.cap) && options.cap > 0 ? Math.floor(options.cap) : 0;
	if (!cap) {
		// A cap of zero or nonsense means "no retention configured" — keep everything rather than
		// silently emptying the store. Deleting on a misread config would be the worst reading.
		return entries;
	}
	if (entries.length <= cap) {
		return entries;
	}

	const reserved = options.reservedSuccessSlots ?? RESERVED_SUCCESS_SLOTS;
	const newestFirst = [...entries].sort((a, b) => savedAtOf(b) - savedAtOf(a));

	const keep = new Set<PersistedTransactionLog>();
	const claim = (candidates: PersistedTransactionLog[], slots: number) => {
		for (const entry of candidates) {
			if (keep.size >= cap || slots <= 0) {
				return;
			}
			if (!keep.has(entry)) {
				keep.add(entry);
				slots -= 1;
			}
		}
	};

	const pinned = newestFirst.filter(options.isPinned);
	const successes = newestFirst.filter(entry => !options.isPinned(entry) && !isFailure(entry));
	const failures = newestFirst.filter(entry => !options.isPinned(entry) && isFailure(entry));

	claim(pinned, cap);
	claim(successes, Math.min(reserved, Math.max(0, cap - keep.size)));
	claim(failures, Math.max(0, cap - keep.size));
	claim(newestFirst, Math.max(0, cap - keep.size));

	return entries.filter(entry => keep.has(entry));
}
