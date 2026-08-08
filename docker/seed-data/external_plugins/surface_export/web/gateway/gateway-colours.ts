/**
 * The portal colour each gateway is drawn in.
 *
 * Lives HERE and not in shared/ because it is presentation and nothing else — no other entrypoint
 * has an opinion about what colour a gateway is. (The geometry next door stays in shared/ for the
 * documented reason shared/planets.ts states: tsconfig.node.json excludes web/**, so shared/ is the
 * only place in this plugin a unit test can reach. Maths earns that exemption; a palette does not.)
 *
 * Mirrors `GATEWAY_COLOURS` in mods-src/surfexp_gateways/data.lua, which is POSITIONAL — gateway N
 * takes colour N. An unknown name gets the neutral accent rather than a wrong colour.
 *
 * These MUST be real CSS colours. React Flow's own floating-edge example writes
 * `stroke={fromHandle.id}` because its handle ids happen to be colour strings; ours are
 * `s:surfexp_gateway_hub`, so passing an id through as a stroke would silently paint every edge
 * black. That trap is the reason this lookup exists at all.
 */

const GATEWAY_COLOURS: Record<string, string> = {
	surfexp_gateway_1: "#4a9eff",
	surfexp_gateway_2: "#52c41a",
	surfexp_gateway_3: "#fa8c16",
	surfexp_gateway_4: "#b37feb",
	surfexp_gateway_hub: "#b37feb",
};

export const DEFAULT_EDGE_COLOUR = "#1668dc";

export function gatewayColour(gatewayName: string | null | undefined): string {
	return (gatewayName && GATEWAY_COLOURS[gatewayName]) || DEFAULT_EDGE_COLOUR;
}
