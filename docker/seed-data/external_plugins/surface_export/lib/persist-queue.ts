import { safeOutputFile } from "@clusterio/lib";

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

export type OutputFileWriter = (file: string, data: string) => Promise<void>;

let outputFileWriter: OutputFileWriter = safeOutputFile;

export function writeOutputFile(file: string, data: string): Promise<void> {
	return outputFileWriter(file, data);
}

export function setOutputFileWriterForTest(writer: OutputFileWriter | null) {
	outputFileWriter = writer ?? safeOutputFile;
}
