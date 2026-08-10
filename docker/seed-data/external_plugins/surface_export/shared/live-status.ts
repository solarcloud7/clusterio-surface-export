export type LiveStatus = "live" | "reconnecting" | "offline" | "degraded";

export type ConnectionEvent = "connect" | "drop" | "resume" | "close";

export type SyncOutcome = "subscribed" | "unsubscribed" | "skipped" | "failed";

export type LiveStatusInput = {
	previous: LiveStatus;
	connected: boolean;
	lastEvent: ConnectionEvent | null;
	outcome: SyncOutcome | null;
};

export function nextLiveStatus(input: LiveStatusInput): LiveStatus {
	if (!input.connected) {
		return input.lastEvent === "close" ? "offline" : "reconnecting";
	}
	switch (input.outcome) {
		case "failed":
			return "degraded";
		case "subscribed":
			return "live";
		case "skipped":
			return "reconnecting";
		case "unsubscribed":
		case null:
		default:
			return input.previous;
	}
}

export function shouldRetryResubscribe(status: LiveStatus, connected: boolean): boolean {
	return connected && status === "degraded";
}

export const RESUBSCRIBE_BASE_DELAY_MS = 1000;
export const RESUBSCRIBE_MAX_DELAY_MS = 30000;

export function resubscribeDelayMs(attempt: number): number {
	const bounded = Math.max(0, attempt);
	return Math.min(RESUBSCRIBE_MAX_DELAY_MS, RESUBSCRIBE_BASE_DELAY_MS * 2 ** bounded);
}
