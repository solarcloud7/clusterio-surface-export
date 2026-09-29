const UNITS: ReadonlyArray<readonly [string, string, number]> = [
	["day", "days", 86_400_000],
	["hour", "hours", 3_600_000],
	["min", "min", 60_000],
	["sec", "sec", 1_000],
];

export function formatUptime(ms: number | null | undefined): string {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
	const parts: string[] = [];
	let rest = Math.floor(ms);
	for (const [singular, plural, size] of UNITS) {
		const count = Math.floor(rest / size);
		rest -= count * size;
		if (count > 0) parts.push(`${count} ${count === 1 ? singular : plural}`);
		if (parts.length === 2) break;
	}
	return parts.join(" ") || "0 sec";
}

export function uptimeMs(startedAtMs: number | null | undefined, nowMs: number): number | null {
	if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs) || startedAtMs <= 0 || nowMs < startedAtMs) return null;
	return nowMs - startedAtMs;
}
