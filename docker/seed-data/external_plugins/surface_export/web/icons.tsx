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
import { selectNavigableLocationNames, selectPlanetNames } from "../shared/planets";
import type { SpaceConnectionLike } from "../shared/planets";

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
	return { modPack, modPackId: modPack?.id, metadata };
}

/**
 * Every place a platform can be flown to, read from the space-connection graph.
 *
 * WHY A SECOND FETCH. `useExportPrototypeMetadata` serves the SPRITESHEET metadata, which is
 * bucketed for icon lookup and carries only name/type/icon across eight buckets — measured: item,
 * fluid, recipe, virtual-signal, technology, space-location, quality, entity, and NO
 * space-connection. The routes exist only in the pack's raw `prototypes` asset, served from the same
 * /static directory and named by the pack's own export manifest.
 *
 * FALLS BACK TO PLANETS, loudly. If the manifest, the asset or the bucket is missing — an older
 * controller, an export that predates this asset — this returns null and the caller keeps today's
 * planet list. Degrading to a list that is merely too broad beats degrading to an empty one, and the
 * reason is logged rather than swallowed so "the gates disappeared from the dropdown" is diagnosable.
 */
function useNavigableLocationNames(): string[] | null {
	const { modPack } = useProtoLookup();
	const [names, setNames] = React.useState<string[] | null>(null);

	// The export manifest's asset map is the only thing that knows the content-hashed filename, and
	// the shape is read defensively because it belongs to Clusterio, not to us.
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

/**
 * The intrinsic size `FactorioIcon` renders at. It emits a bare `<span class="factorio-icon">` and
 * the spritesheet CSS injected by `useExportPrototypeMetadata` sizes it — MEASURED at 32x32 with
 * `background-size: auto` on the live UI (getComputedStyle, 2026-08-04, alpha.27 web_ui).
 *
 * This matters because the size cannot be set by giving the element a smaller width/height: the
 * sprite is a BACKGROUND at a fixed offset into a sheet, so shrinking the box crops rather than
 * scales. Transform is the only lever that actually resizes it, and a transform needs to know the
 * size it is scaling FROM — hence this constant rather than a CSS-only fix.
 *
 * If a future web_ui changes the intrinsic size, icons render at the wrong scale (cosmetic, not
 * broken). Re-measure with:
 *   getComputedStyle(document.querySelector(".factorio-icon")).width
 */
const FACTORIO_ICON_NATURAL_PX = 32;

type ProtoIconProps = { name: string; size?: number; title?: string; preferTypes?: string[] };

export function ProtoIcon({ name, size = FACTORIO_ICON_NATURAL_PX, title, preferTypes }: ProtoIconProps) {
	const { modPackId, metadata } = useProtoLookup();
	const prototype = findEntry(metadata, name, preferTypes);
	const scale = size / FACTORIO_ICON_NATURAL_PX;
	return (
		// Outer box occupies exactly `size` in layout and CLIPS: without overflow:hidden a sprite
		// larger than its box silently spills over neighbouring content instead of being contained,
		// which is how a 32px icon in a 20px box read as "the icons are too big".
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
// Entity base_types vary (assembling-machine, furnace, mining-drill, ...); rely on the name scan.
export const EntityIcon = (props: IconProps) => <ProtoIcon {...props} />;

/**
 * Every planet the mod pack actually defines, as antd Select options with an icon.
 *
 * Read from prototype metadata rather than a hand-kept list: a literal array silently omits modded
 * planets (this cluster runs maraxsis and PlanetsLib, which contribute `maraxsis` and
 * `maraxsis-trench` — neither appeared in the five-planet array this replaced), and cannot drift
 * back into correctness on its own.
 *
 * Which entries count as planets is decided by `selectPlanetNames` — the rule is subtler than it
 * looks (there is no "planet" bucket; gateways share one with the planets), so it lives in
 * shared/planets.ts with the measured metadata shape and a test, rather than being restated here.
 */
export function usePlanetOptions() {
	const { metadata } = useProtoLookup();
	const navigable = useNavigableLocationNames();
	return React.useMemo(() => {
		const buckets = [...(metadata?.values() ?? [])].map(typeMap => typeMap.values());
		// Where a platform can actually FLY, when the route graph is readable; the old
		// every-planet list otherwise. See useNavigableLocationNames for why the fallback exists and
		// selectNavigableLocationNames for the measurement behind the rule.
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
