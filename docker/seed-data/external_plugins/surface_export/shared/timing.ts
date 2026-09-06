export type TimingStatus = "running" | "completed" | "failed" | "interrupted" | "skipped";
export type TimingOwner = "controller" | "instance" | "source-lua" | "destination-lua" | "recovery-lua";

export interface TimingRecord {
	v: 1;
	id: string;
	clockId: string;
	jobId: string;
	operationId?: string;
	exportId?: string;
	instanceId?: number;
	owner: TimingOwner;
	stage: string;
	parent?: string;
	kind: "execution" | "wait" | "inclusive" | "round-trip";
	status: TimingStatus;
	revision: number;
	startMs: number | null;
	endMs: number | null;
	executionMs: number | null;
	startTick?: number;
	endTick?: number;
	ticksElapsed?: number;
	batchCount?: number;
	workTicks?: number;
	batch?: number;
	truncated?: boolean;
	raw?: string;
	error?: string;
}

export interface OperationTiming { v: 1; records: TimingRecord[] }

export interface TimingClockContract {
	jobId: string;
	operationId?: string;
	exportId?: string;
	clockId: string;
	offset(): number;
	bind(operationId: string): void;
	start(stage: string, kind?: TimingRecord["kind"], parent?: string): TimingRecord;
	stop(record: TimingRecord, status?: TimingStatus): void;
	measure<T>(stage: string, kind: TimingRecord["kind"], fn: () => T | Promise<T>): Promise<T>;
}

export function mergeTiming(records: readonly TimingRecord[], incoming: TimingRecord): TimingRecord[] {
	const index = records.findIndex(record => record.id === incoming.id && record.clockId === incoming.clockId);
	if (index < 0) return [...records, incoming];
	if (records[index].revision >= incoming.revision) return [...records];
	return records.map((record, i) => i === index ? incoming : record);
}

export function elapsed(record: TimingRecord): number | null {
	return typeof record.startMs === "number" && Number.isFinite(record.startMs) && record.startMs >= 0
		&& typeof record.endMs === "number" && Number.isFinite(record.endMs) && record.endMs >= record.startMs
		? record.endMs - record.startMs : null;
}

export function clockGroups(records: readonly TimingRecord[]): Array<{ clockId: string; owner: TimingOwner; records: TimingRecord[]; totalMs: number }> {
	const groups = new Map<string, TimingRecord[]>();
	for (const record of records) {
		const group = groups.get(record.clockId) ?? [];
		group.push(record);
		groups.set(record.clockId, group);
	}
	const order: Record<TimingOwner, number> = { controller: 0, instance: 1, "source-lua": 2, "destination-lua": 3, "recovery-lua": 4 };
	return [...groups].map(([clockId, group]) => ({ clockId, owner: group[0].owner,
		records: group.sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity) || a.id.localeCompare(b.id)),
		totalMs: Math.max(0, ...group.map(record => record.endMs ?? record.startMs ?? 0)),
	})).sort((a, b) => order[a.owner] - order[b.owner]);
}
