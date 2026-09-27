const GATEWAY_COLOURS: Record<string, string> = {
	surfexp_gateway_hub: "#b37feb",
};

export const DEFAULT_EDGE_COLOUR = "#1668dc";

export function gatewayColour(gatewayName: string | null | undefined): string {
	return (gatewayName && GATEWAY_COLOURS[gatewayName]) || DEFAULT_EDGE_COLOUR;
}
