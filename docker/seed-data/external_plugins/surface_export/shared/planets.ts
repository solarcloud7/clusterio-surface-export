export type PrototypeLike = { name: string; type: string };

export function selectPlanetNames(buckets: Iterable<Iterable<PrototypeLike>>): string[] {
	const names = new Set<string>();
	for (const bucket of buckets) {
		for (const entry of bucket) {
			if (entry && entry.type === "planet") {
				names.add(entry.name);
			}
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}

export type SpaceConnectionLike = { from?: unknown; to?: unknown };

export function selectNavigableLocationNames(connections: Iterable<SpaceConnectionLike>): string[] {
	const names = new Set<string>();
	for (const connection of connections) {
		for (const end of [connection?.from, connection?.to]) {
			if (typeof end === "string" && end) {
				names.add(end);
			}
		}
	}
	return [...names].sort((a, b) => a.localeCompare(b));
}
