import type { PortalColour } from "../../shared/server-destinations";

export const PORTAL_HEX: Record<PortalColour, string> = {
	blue: "#0d5cde",
	green: "#63b048",
	orange: "#dd7b12",
	purple: "#7d45e5",
};

export const DEFAULT_EDGE_COLOUR = "#1668dc";
export const PORTAL_LINK_COLOUR = "#8c8c8c";

export function portalColour(colour: PortalColour | null | undefined): string {
	return (colour && PORTAL_HEX[colour]) || PORTAL_LINK_COLOUR;
}
