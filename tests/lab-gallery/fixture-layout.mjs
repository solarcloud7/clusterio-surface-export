function belt(x, y, direction, corner = false) {
	return { name: "turbo-transport-belt", position: { x, y }, direction, corner };
}

export function buildFiveByFiveLoop(origin) {
	const x = origin.x;
	const y = origin.y;
	return [
		belt(x, y, "east", true),
		belt(x + 1, y, "east"), belt(x + 2, y, "east"), belt(x + 3, y, "east"),
		belt(x + 4, y, "south", true),
		belt(x + 4, y + 1, "south"), belt(x + 4, y + 2, "south"), belt(x + 4, y + 3, "south"),
		belt(x + 4, y + 4, "west", true),
		belt(x + 3, y + 4, "west"), belt(x + 2, y + 4, "west"), belt(x + 1, y + 4, "west"),
		belt(x, y + 4, "north", true),
		belt(x, y + 3, "north"), belt(x, y + 2, "north"), belt(x, y + 1, "north"),
	];
}

// Layout locators only. The expected fingerprint values (quantities, reachability controls) are
// sourced from the manifest fingerprints by build-save, never duplicated here — the manifest is the
// single source of truth for what is asserted.
export function buildBeltPilot() {
	const sourceOrigin = { x: -16.5, y: -25.5 };
	const targetOrigin = { x: 4.5, y: -25.5 };
	return {
		id: "belt-5x5-125-unstacked",
		sourceSurface: "nauvis",
		sourceBelts: buildFiveByFiveLoop(sourceOrigin),
		targetBelts: buildFiveByFiveLoop(targetOrigin),
	};
}

export function buildSpecializedReachabilityFixture() {
	return {
		id: "specialized-fluid-reachability",
		platformName: "lab-specialized-fluid-r1",
		drillName: "electric-mining-drill",
	};
}
