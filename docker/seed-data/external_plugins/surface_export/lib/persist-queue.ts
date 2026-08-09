const writeChains = new Map<string, Promise<unknown>>();

export function enqueueWrite<T>(path: string, produce: () => Promise<T>): Promise<T> {
	const previous = writeChains.get(path) ?? Promise.resolve();
	const run = Promise.allSettled([previous]).then(() => produce());
	writeChains.set(path, run);
	return run;
}

export function resetWriteQueuesForTest() {
	writeChains.clear();
}
