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
