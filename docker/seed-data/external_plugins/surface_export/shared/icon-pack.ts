export type IconPackLike = {
	id: number;
	name?: string;
	updatedAtMs?: number;
	isDeleted?: boolean;
	exportManifest?: { assets?: Record<string, string> };
};

export function hasIconExport(pack: IconPackLike | undefined): boolean {
	return Boolean(pack && !pack.isDeleted && pack.exportManifest?.assets?.metadata);
}

export function selectIconPack<T extends IconPackLike>(
	scopedId: number | null | undefined,
	defaultPack: T | undefined,
	packs: Iterable<T>,
): T | undefined {
	const all = [...packs];
	const scoped = typeof scopedId === "number" ? all.find(pack => pack.id === scopedId) : undefined;
	if (hasIconExport(scoped)) {
		return scoped;
	}
	if (hasIconExport(defaultPack)) {
		return defaultPack;
	}
	const exported = all.filter(hasIconExport)
		.sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0) || b.id - a.id);
	return exported[0] ?? scoped ?? defaultPack;
}
