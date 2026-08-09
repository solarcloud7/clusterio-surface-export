export function formatMs(ms: number | null | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms)) {
		return "";
	}
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function getErrorMessage(err: unknown, fallback = "Unknown error"): string {
	if (err instanceof Error) {
		return err.message || fallback;
	}
	if (typeof err === "string") {
		return err || fallback;
	}
	if (err && typeof err === "object" && "message" in err) {
		const message = (err as { message?: unknown }).message;
		if (typeof message === "string" && message) {
			return message;
		}
	}
	return fallback;
}

export function generateOperationId(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeCanonicalTransferId(sourceInstanceId: number, sourceJobId: string): string {
	if (!Number.isInteger(sourceInstanceId) || sourceInstanceId <= 0) {
		throw new Error(`Invalid source instance id: ${String(sourceInstanceId)}`);
	}
	const jobId = String(sourceJobId || "");
	if (!jobId) {
		throw new Error("sourceJobId is required");
	}
	return `${sourceInstanceId}:${jobId}`;
}

export function parseCanonicalTransferId(id: string | null | undefined): { sourceInstanceId: number; sourceJobId: string } | null {
	if (typeof id !== "string") {
		return null;
	}
	const idx = id.indexOf(":");
	if (idx <= 0) {
		return null;
	}
	const sourceInstanceId = Number(id.slice(0, idx));
	const sourceJobId = id.slice(idx + 1);
	if (!Number.isInteger(sourceInstanceId) || sourceInstanceId <= 0 || !sourceJobId) {
		return null;
	}
	return { sourceInstanceId, sourceJobId };
}
