/**
 * Selecting real PLANETS out of Clusterio's exported prototype metadata.
 *
 * Lives in shared/ (rather than beside its only caller in web/) purely so it is reachable from
 * dist/node and therefore testable: the web bundle is not built into dist/node, and this is a
 * contract worth pinning — see the shape note below.
 */

/** The fields of a prototype metadata entry this selection depends on. */
export type PrototypeLike = { name: string; type: string };

/**
 * Names of every entry whose OWN `type` is "planet", deduplicated and sorted.
 *
 * The subtlety this exists to capture: metadata is BUCKETED by a coarse base_type, and there is no
 * "planet" bucket. Measured against the live spritesheet metadata (2026-08-04, Space Age 2.0 pack
 * with maraxsis + PlanetsLib) the buckets are item / fluid / recipe / virtual-signal / technology /
 * space-location / quality / entity, and every planet is filed under `space-location` next to
 * things that are not planets:
 *
 *     space-location  →  space-location-unknown, solar-system-edge, shattered-planet,
 *                        surfexp_gateway_1..4          (type: "space-location")
 *                        nauvis, vulcanus, gleba, fulgora, aquilo,
 *                        maraxsis, maraxsis-trench     (type: "planet")
 *
 * So keying on the bucket yields nothing, and keying on the bucket's CONTENTS without checking each
 * entry's type yields gateways — which cannot host a created platform, because the caller feeds this
 * to Lua's `force.create_space_platform{ planet = ... }`.
 *
 * Takes buckets rather than the Map so it stays independent of the metadata container's shape, and
 * scans all of them so it keeps working if a future Clusterio does introduce a `planet` bucket.
 *
 * Sorted by name because `ExportMetadataEntry` carries no `order` field — in-game ordering simply is
 * not available here, and alphabetical is the only stable choice.
 */
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
