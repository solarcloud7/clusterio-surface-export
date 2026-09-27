export const SERVER_DESTINATIONS_SETTING = "surfexp-gateway-instances";

export const PORTAL_COLOURS = ["blue", "green", "orange", "purple"] as const;

export type PortalColour = typeof PORTAL_COLOURS[number];

export interface ServerDestination {
	instanceId: number;
	label: string;
	colour: PortalColour;
}

const INSTANCE_ID = /^[1-9]\d*$/;

export function parseServerDestinations(value: unknown): ServerDestination[] {
	if (typeof value !== "string") {
		return [];
	}
	const destinations: ServerDestination[] = [];
	const seen = new Set<string>();
	for (const raw of value.split(",")) {
		const entry = raw.trim();
		if (!entry) {
			continue;
		}
		const split = entry.indexOf("=");
		const id = (split === -1 ? entry : entry.slice(0, split)).trim();
		const label = split === -1 ? "" : entry.slice(split + 1).trim();
		if (!INSTANCE_ID.test(id) || !Number.isSafeInteger(Number(id)) || seen.has(id)) {
			continue;
		}
		seen.add(id);
		destinations.push({
			instanceId: Number(id),
			label: label || `Server ${id}`,
			colour: PORTAL_COLOURS[destinations.length % PORTAL_COLOURS.length],
		});
	}
	return destinations;
}

export function serverDestinationFor(value: unknown, instanceId: number): { label: string; colour: PortalColour } | null {
	const destination = parseServerDestinations(value).find(entry => entry.instanceId === instanceId);
	return destination ? { label: destination.label, colour: destination.colour } : null;
}
