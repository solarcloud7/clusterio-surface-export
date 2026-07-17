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

export function buildBeltPilot() {
	const sourceOrigin = { x: -16.5, y: -25.5 };
	const targetOrigin = { x: 4.5, y: -25.5 };
	return {
		id: "belt-5x5-125-unstacked",
		sourceSurface: "nauvis",
		sourceBelts: buildFiveByFiveLoop(sourceOrigin),
		targetBelts: buildFiveByFiveLoop(targetOrigin),
		sourceLineQuantities: [67, 58],
		expected: { sourceQuantity: 125, sourceLineQuantities: [67, 58], targetQuantity: 0, maximumStack: 1 },
	};
}

export function buildSpecializedReachabilityFixture() {
	return {
		id: "specialized-fluid-reachability",
		revision: 1,
		platformName: "lab-specialized-fluid-r1",
		drillName: "electric-mining-drill",
		expected: {
			pressure: 0,
			gravity: 0,
			miningTarget: null,
			liveFluidboxCount: 0,
			readOk: false,
			writeOk: false,
		},
	};
}
