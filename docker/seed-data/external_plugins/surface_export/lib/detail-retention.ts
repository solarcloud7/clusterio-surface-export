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
 * Successes are guaranteed up to this many slots. Without a floor, a burst of failures would evict
 * every example of a healthy transfer — and comparing a reported failure against a known-good run of
 * the same platform is the first thing anyone does when debugging one.
 *
 * It is a CEILING on the guarantee, not a first claim on the window: see `successFloorFor`.
 */
export const RESERVED_SUCCESS_SLOTS = 25;

/**
 * Bounds for the configured cap. A present-but-out-of-range value is clamped rather than
 * reinterpreted — notably 0, which an operator would reasonably type meaning "keep no detail" and
 * which used to be indistinguishable from "no cap configured", i.e. unbounded growth.
 */
export const MIN_DETAIL_ENTRIES = 10;
export const MAX_DETAIL_ENTRIES = 5000;

/**
 * How many slots successes are guaranteed, given the window size.
 *
 * The `budget / 2` term is what makes this a floor rather than a first claim, and it is load-bearing.
 * Claiming `RESERVED_SUCCESS_SLOTS` off the top inverts the documented priority whenever the cap is
 * at or below 25: at cap 20 with 40 successes and 5 failures, successes took all 20 and every
 * failure's detail was deleted — the exact class the window exists to preserve, destroyed by the
 * rule meant to protect the other class. The config description invites operators to lower this cap,
 * so that is a reachable setting, not a pathological one.
 */
function successFloorFor(budget: number, availableSuccesses: number, reserved: number): number {
	return Math.max(0, Math.min(reserved, availableSuccesses, Math.floor(budget / 2)));
}

const FAILURE_STATUSES = new Set(["failed", "cleanup_failed", "error"]);

export type RetentionOptions = {
	cap: number;
	/**
	 * Whether this entry's export payload is still downloadable. Used as a PREFERENCE within each
	 * class (a downloadable transfer's timeline is the more useful one to keep), never as a class of
	 * its own — see the tiebreak note in `selectRetainedDetail`. The name is kept for the call sites.
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
 * Pick the entries to keep.
 *
 * Two classes share the window:
 *   FAILURES  take `cap - successFloor` — the debug-and-report workflow has priority.
 *   SUCCESSES take at least `successFloor`, then fill whatever failures did not use.
 * Within each class, entries whose payload is still downloadable come first, then newest first.
 * Any remaining slack goes to whoever is newest, regardless of class.
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

	// ONE pass to partition and one isPinned call per entry. It used to be three filter passes each
	// calling isPinned — three platformStorage lookups per entry, ~1359 of them per persist on a
	// 453-entry store, on the critical path of every transfer's terminal resolution.
	const failures: PersistedTransactionLog[] = [];
	const successes: PersistedTransactionLog[] = [];
	const pinnedSet = new Set<PersistedTransactionLog>();
	for (const entry of entries) {
		if (options.isPinned(entry)) {
			pinnedSet.add(entry);
		}
		(isFailure(entry) ? failures : successes).push(entry);
	}

	// Being pinned is a TIEBREAK INSIDE a class, not a class of its own.
	//
	// It used to be its own class claiming the window first, justified by "bounded in practice by
	// max_storage_size (default 20)" — a safety property resting on the DEFAULT of a different,
	// operator-tunable field whose own description invites raising it. At max_storage_size=200 with
	// this cap at 100, pinned entries took every slot and no failure detail survived at all.
	//
	// Demoting it is safe because the download does NOT depend on the detail entry: `downloadable` is
	// derived from platformStorage (transaction-logger.ts), and the download handler reads the payload
	// from there. Losing a detail entry costs a timeline, never a button.
	const preferPinnedThenNewest = (a: PersistedTransactionLog, b: PersistedTransactionLog) =>
		(Number(pinnedSet.has(b)) - Number(pinnedSet.has(a))) || (savedAtOf(b) - savedAtOf(a));
	failures.sort(preferPinnedThenNewest);
	successes.sort(preferPinnedThenNewest);

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

	// Failures take the window MINUS the successes' floor, so they keep their documented priority
	// without being able to erase every healthy example; successes then take at least that floor.
	const successFloor = successFloorFor(cap, successes.length, reserved);
	claim(failures, cap - successFloor);
	claim(successes, Math.max(0, cap - keep.size));
	// Slack (e.g. fewer failures than their share) goes to whoever is newest, regardless of class.
	claim([...failures, ...successes].sort(preferPinnedThenNewest), Math.max(0, cap - keep.size));

	return entries.filter(entry => keep.has(entry));
}
