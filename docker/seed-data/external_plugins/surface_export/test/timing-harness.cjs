const { TimingClock } = require("../dist/node/lib/timing");
exports.makeTimingHarness = () => {
	const clocks = new Map();
	const clock = id => {
		if (!clocks.has(id)) clocks.set(id, new TimingClock(id, "controller", () => {}));
		return clocks.get(id);
	};
	return { clock, getObservedDuration: () => null, beginObservation: clock, captureStoredTiming: () => {}, rejectObservation: async () => {}, bindObservation(from, to) {
		const previous = clock(from); previous.bind(to); clocks.set(to, previous);
	} };
};
