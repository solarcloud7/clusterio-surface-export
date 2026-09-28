import { GATEWAY_PREFIX } from "./dto";

export const PORTAL_COLOURS = ["blue", "green", "orange", "purple"] as const;

export type PortalColour = typeof PORTAL_COLOURS[number];

export const PORTAL_SLOT_COUNT = PORTAL_COLOURS.length;

export interface PortalAssignment {
	slot: number;
	colour: PortalColour;
	label: string;
}

export function portalGatewayName(slot: number): string {
	return `${GATEWAY_PREFIX}${slot}`;
}

export function portalSlotOf(name: string | null | undefined): number | null {
	const suffix = name?.startsWith(GATEWAY_PREFIX) ? name.slice(GATEWAY_PREFIX.length) : "";
	const slot = /^[1-9]$/.test(suffix) ? Number(suffix) : 0;
	return slot >= 1 && slot <= PORTAL_SLOT_COUNT ? slot : null;
}

export function portalColour(slot: number): PortalColour {
	return PORTAL_COLOURS[slot - 1];
}

export function portalColourName(colour: PortalColour): string {
	return colour.charAt(0).toUpperCase() + colour.slice(1);
}
