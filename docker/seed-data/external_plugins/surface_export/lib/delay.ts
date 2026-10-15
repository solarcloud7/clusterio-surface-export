import { wait } from "@clusterio/lib";

export type Delay = (durationMs: number) => Promise<void>;

let currentDelay: Delay = wait;

export function delay(durationMs: number): Promise<void> {
	return currentDelay(durationMs);
}

export function setDelayForTest(replacement: Delay | null) {
	currentDelay = replacement ?? wait;
}
