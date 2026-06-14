/**
 * Factorio icon helpers for the Surface Export web UI.
 *
 * Clusterio alpha.24 removed the `useItemMetadata`/`usePlanetMetadata`/`useEntityMetadata` hooks
 * and the framework-injected `.item-<name>` / `.planet-<name>` / `.entity-<name>` CSS classes.
 * Icons are now rendered with the `FactorioIcon` component, fed a prototype entry looked up from
 * `useExportPrototypeMetadata(modPack)`. Rendering an icon also injects the spritesheet CSS for the
 * mod pack (handled inside the hook), so no separate injection step is needed.
 *
 * We use the controller's default mod pack: this UI spans many instances/platforms with no single
 * "current" instance in scope, and the planets/items/entities it shows are covered by the default
 * (Space Age) pack's spritesheet.
 */
import React from "react";
import { FactorioIcon, useDefaultModPack, useExportPrototypeMetadata } from "@clusterio/web_ui";
import type { PrototypeMetadataEntry } from "@clusterio/web_ui";

type Metadata = Map<string, Map<string, PrototypeMetadataEntry>> | undefined;

/**
 * Look up a prototype entry by name. Metadata is keyed by Factorio base_type (e.g. "item", "fluid",
 * "planet", "assembling-machine", ...), which varies per prototype — so we check preferred types
 * first, then fall back to scanning every type map. Returns undefined when not found (FactorioIcon
 * then renders an "unknown" placeholder).
 */
function findEntry(metadata: Metadata, name: string, preferTypes?: string[]): PrototypeMetadataEntry | undefined {
	if (!metadata) {
		return undefined;
	}
	if (preferTypes) {
		for (const type of preferTypes) {
			const entry = metadata.get(type)?.get(name);
			if (entry) {
				return entry;
			}
		}
	}
	for (const typeMap of metadata.values()) {
		const entry = typeMap.get(name);
		if (entry) {
			return entry;
		}
	}
	return undefined;
}

function useProtoLookup() {
	const modPack = useDefaultModPack();
	const metadata = useExportPrototypeMetadata(modPack);
	return { modPackId: modPack?.id, metadata };
}

type ProtoIconProps = { name: string; size?: number; title?: string; preferTypes?: string[] };

export function ProtoIcon({ name, size = 32, title, preferTypes }: ProtoIconProps) {
	const { modPackId, metadata } = useProtoLookup();
	const prototype = findEntry(metadata, name, preferTypes);
	return (
		<span
			title={title ?? name}
			style={{ display: "inline-block", width: size, height: size, verticalAlign: "middle", flexShrink: 0 }}
		>
			<FactorioIcon modPackId={modPackId} prototype={prototype} />
		</span>
	);
}

type IconProps = { name: string; size?: number; title?: string };

export const PlanetIcon = (props: IconProps) => <ProtoIcon preferTypes={["planet", "space-location"]} {...props} />;
export const ItemIcon = (props: IconProps) => <ProtoIcon preferTypes={["item"]} {...props} />;
export const FluidIcon = (props: IconProps) => <ProtoIcon preferTypes={["fluid"]} {...props} />;
// Entity base_types vary (assembling-machine, furnace, mining-drill, ...); rely on the name scan.
export const EntityIcon = (props: IconProps) => <ProtoIcon {...props} />;
