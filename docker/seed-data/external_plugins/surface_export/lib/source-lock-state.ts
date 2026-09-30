import { SOURCE_TRANSFER_LOCK_STATES, type SourceTransferLockState, type SourceTransferLockStateResponse } from "../messages";

export { SOURCE_TRANSFER_LOCK_STATES };

function isSourceTransferLockState(value: unknown): value is SourceTransferLockState {
	return typeof value === "string" && (SOURCE_TRANSFER_LOCK_STATES as readonly string[]).includes(value);
}

export function normalizeSourceTransferLockState(value: unknown): SourceTransferLockStateResponse {
	if (!value || typeof value !== "object") {
		return { state: "unknown/offline", transferId: null, error: "missing source lock state" };
	}
	const raw = value as { state?: unknown; transferId?: unknown; error?: unknown };
	const state = isSourceTransferLockState(raw.state) ? raw.state : "unknown/offline";
	return {
		state,
		transferId: typeof raw.transferId === "string" ? raw.transferId : null,
		error: typeof raw.error === "string" ? raw.error : null,
	};
}

export function parseSourceTransferLockStateJson(text: string): SourceTransferLockStateResponse {
	try {
		if (!text || !text.trim()) {
			return { state: "unknown/offline", transferId: null, error: "empty source lock state response" };
		}
		return normalizeSourceTransferLockState(JSON.parse(text));
	} catch (err: unknown) {
		return { state: "unknown/offline", transferId: null, error: err instanceof Error ? err.message : String(err) };
	}
}