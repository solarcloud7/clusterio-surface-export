function object(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function newRestoreRequestId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
	const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Shape detection only. Factorio still validates schema, compatibility and cargo.
export function importableSnapshot(value: unknown): { payload: Record<string, unknown>; fromBlackBox: boolean } {
	if (!object(value)) throw new Error("An importable platform snapshot must be a JSON object");
	const fromBlackBox = Object.hasOwn(value, "replay_payload");
	const payload = fromBlackBox ? value.replay_payload : value;
	if (!object(payload)) throw new Error("This diagnostic file has no importable replay payload");
	const compressed = payload.compressed === true && typeof payload.payload === "string" && payload.payload.length > 0;
	const sectioned = payload.section_codec != null && Array.isArray(payload.sections) && payload.sections.length > 0;
	const plain = object(payload.platform) && Array.isArray(payload.entities);
	if (!compressed && !sectioned && !plain) throw new Error("This file contains diagnostics, not an importable platform snapshot");
	return { payload, fromBlackBox };
}

export function snapshotAvailability(value: unknown): { restorable: boolean; restoreUnavailableReason: string | null } {
	if (!value) return {restorable: false, restoreUnavailableReason: "The stored snapshot is missing or has expired."};
	try {
		importableSnapshot(value);
		return {restorable: true, restoreUnavailableReason: null};
	} catch (error) {
		return {restorable: false, restoreUnavailableReason: error instanceof Error ? error.message : "No importable snapshot is available."};
	}
}
