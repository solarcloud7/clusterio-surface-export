import type { PersistedTransactionLog } from "../messages";


export const RESERVED_SUCCESS_SLOTS = 25;

export const MIN_DETAIL_ENTRIES = 10;
export const MAX_DETAIL_ENTRIES = 5000;

function successFloorFor(budget: number, availableSuccesses: number, reserved: number): number {
	return Math.max(0, Math.min(reserved, availableSuccesses, Math.floor(budget / 2)));
}

const FAILURE_STATUSES = new Set(["failed", "cleanup_failed", "error"]);

export type RetentionOptions = {
	cap: number;
	isPinned: (entry: PersistedTransactionLog) => boolean;
	reservedSuccessSlots?: number;
};

function savedAtOf(entry: PersistedTransactionLog): number {
	return entry.savedAt || entry.transferInfo?.startedAt || 0;
}

function isFailure(entry: PersistedTransactionLog): boolean {
	return FAILURE_STATUSES.has(String(entry.transferInfo?.status || ""));
}

export function selectRetainedDetail(
	entries: PersistedTransactionLog[],
	options: RetentionOptions,
): PersistedTransactionLog[] {
	const cap = Number.isFinite(options.cap) && options.cap > 0 ? Math.floor(options.cap) : 0;
	if (!cap) {
		return entries;
	}
	if (entries.length <= cap) {
		return entries;
	}

	const reserved = options.reservedSuccessSlots ?? RESERVED_SUCCESS_SLOTS;

	const failures: PersistedTransactionLog[] = [];
	const successes: PersistedTransactionLog[] = [];
	const pinnedSet = new Set<PersistedTransactionLog>();
	for (const entry of entries) {
		if (options.isPinned(entry)) {
			pinnedSet.add(entry);
		}
		(isFailure(entry) ? failures : successes).push(entry);
	}

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

	const successFloor = successFloorFor(cap, successes.length, reserved);
	claim(failures, cap - successFloor);
	claim(successes, Math.max(0, cap - keep.size));
	claim([...failures, ...successes].sort(preferPinnedThenNewest), Math.max(0, cap - keep.size));

	return entries.filter(entry => keep.has(entry));
}
