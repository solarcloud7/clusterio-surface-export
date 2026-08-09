import React from "react";
import { FactorioIcon, useDefaultModPack, useExportPrototypeMetadata } from "@clusterio/web_ui";
import type { PrototypeMetadataEntry } from "@clusterio/web_ui";
import { selectNavigableLocationNames, selectPlanetNames } from "../shared/planets";
import type { SpaceConnectionLike } from "../shared/planets";

type Metadata = Map<string, Map<string, PrototypeMetadataEntry>> | undefined;

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
	return { modPack, modPackId: modPack?.id, metadata };
}

function useNavigableLocationNames(): string[] | null {
	const { modPack } = useProtoLookup();
	const [names, setNames] = React.useState<string[] | null>(null);

	const asset = (modPack as { exportManifest?: { assets?: Record<string, string> } } | undefined)
		?.exportManifest?.assets?.prototypes;

	React.useEffect(() => {
		if (!asset) {
			setNames(null);
			return undefined;
		}
		let live = true;
		void (async () => {
			try {
				const response = await fetch(`/static/${asset}`);
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				const prototypes = await response.json() as Record<string, Record<string, SpaceConnectionLike>>;
				const connections = prototypes["space-connection"];
				if (!connections) {
					throw new Error("the export has no space-connection prototypes");
				}
				if (live) {
					setNames(selectNavigableLocationNames(Object.values(connections)));
				}
			} catch (err: unknown) {
				console.warn(
					"surface_export: could not read the space-connection graph; "
					+ "falling back to listing planets, which offers unreachable surfaces and omits gateways",
					err,
				);
				if (live) {
					setNames(null);
				}
			}
		})();
		return () => { live = false; };
	}, [asset]);

	return names;
}

const FACTORIO_ICON_NATURAL_PX = 32;

type ProtoIconProps = { name: string; size?: number; title?: string; preferTypes?: string[] };

export function ProtoIcon({ name, size = FACTORIO_ICON_NATURAL_PX, title, preferTypes }: ProtoIconProps) {
	const { modPackId, metadata } = useProtoLookup();
	const prototype = findEntry(metadata, name, preferTypes);
	const scale = size / FACTORIO_ICON_NATURAL_PX;
	return (
		<span
			title={title ?? name}
			style={{
				display: "inline-block",
				width: size,
				height: size,
				overflow: "hidden",
				verticalAlign: "middle",
				flexShrink: 0,
			}}
		>
			<span
				style={{
					display: "block",
					width: FACTORIO_ICON_NATURAL_PX,
					height: FACTORIO_ICON_NATURAL_PX,
					transform: `scale(${scale})`,
					transformOrigin: "top left",
				}}
			>
				<FactorioIcon modPackId={modPackId} prototype={prototype} />
			</span>
		</span>
	);
}

type IconProps = { name: string; size?: number; title?: string };

export const PlanetIcon = (props: IconProps) => <ProtoIcon preferTypes={["planet", "space-location"]} {...props} />;
export const ItemIcon = (props: IconProps) => <ProtoIcon preferTypes={["item"]} {...props} />;
export const FluidIcon = (props: IconProps) => <ProtoIcon preferTypes={["fluid"]} {...props} />;
export const EntityIcon = (props: IconProps) => <ProtoIcon {...props} />;

export function usePlanetOptions() {
	const { metadata } = useProtoLookup();
	const navigable = useNavigableLocationNames();
	return React.useMemo(() => {
		const buckets = [...(metadata?.values() ?? [])].map(typeMap => typeMap.values());
		return (navigable ?? selectPlanetNames(buckets))
			.map(name => ({
				value: name,
				label: (
					<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
						<PlanetIcon name={name} size={20} />
						<span>{name}</span>
					</span>
				),
			}));
	}, [metadata, navigable]);
}
