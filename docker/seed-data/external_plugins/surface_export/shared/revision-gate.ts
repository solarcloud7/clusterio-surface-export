export type RevisionWatermarks = {
	lastTreeRevision: number;
	lastTransferRevision: number;
	lastLogRevision: number;
};

export function freshRevisionWatermarks(): RevisionWatermarks {
	return {
		lastTreeRevision: 0,
		lastTransferRevision: 0,
		lastLogRevision: 0,
	};
}

export function isFreshRevision(revision: unknown, watermark: number): boolean {
	const value = Number(revision);
	return Number.isFinite(value) && value > watermark;
}

export type SnapshotDecision = {
	apply: boolean;
	watermark: number | null;
};

export function decideSnapshot(revision: unknown, watermark: number): SnapshotDecision {
	if (typeof revision !== "number" || !Number.isFinite(revision)) {
		return { apply: true, watermark: null };
	}
	return revision > watermark ? { apply: true, watermark: revision } : { apply: false, watermark: null };
}

export function entriesChangedSince<T extends { transferId: string }>(
	before: Map<string, T>,
	current: readonly T[],
): T[] {
	return current.filter(entry => before.get(entry.transferId) !== entry);
}
