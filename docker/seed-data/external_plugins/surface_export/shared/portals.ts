export const PORTAL_COLOURS = ["blue", "green", "orange", "purple"] as const;

export type PortalColour = typeof PORTAL_COLOURS[number];

export const PORTAL_SLOT_COUNT = PORTAL_COLOURS.length;

export interface PortalAssignment {
	slot: number;
	colour: PortalColour;
	label: string;
}

export function portalGatewayName(slot: number): string {
	return `surfexp_gateway_${slot}`;
}

export function portalSlotOf(name: string | null | undefined): number | null {
	const match = /^surfexp_gateway_([1-9])$/.exec(name ?? "");
	const slot = match ? Number(match[1]) : 0;
	return slot >= 1 && slot <= PORTAL_SLOT_COUNT ? slot : null;
}

export function portalColour(slot: number): PortalColour {
	return PORTAL_COLOURS[slot - 1];
}
