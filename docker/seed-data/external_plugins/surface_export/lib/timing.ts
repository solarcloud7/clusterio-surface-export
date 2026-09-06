import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TimingRecord, TimingOwner, TimingClockContract } from "../shared/timing";

const processId = randomUUID();
export const TIMING_MARKER = "[SE_TIMING_V1]";
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function parseProfiler(value: string): number | null {
	const match = /^\s*(?:Duration:\s*)?(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(ms|s|us|µs|ns)\s*$/i.exec(value);
	if (!match) return null;
	const result = Number(match[1]) * ({ ms: 1, s: 1000, us: .001, "µs": .001, ns: .000001 }[match[2].toLowerCase()] ?? NaN);
	return number(result) ? result : null;
}

export const timingContext = new AsyncLocalStorage<TimingClockContract>();
const parentContext = new AsyncLocalStorage<string>();
export function timed<T>(stage: string, kind: TimingRecord["kind"], fn: () => T | Promise<T>): Promise<T> {
	const clock = timingContext.getStore();
	return clock ? clock.measure(stage, kind, fn) : Promise.resolve().then(fn);
}
export function timedSync<T>(stage: string, fn: () => T): T {
	const clock = timingContext.getStore();
	if (!clock) return fn();
	const span = clock.start(stage, "execution");
	try { const result = fn(); clock.stop(span); return result; }
	catch (error) { clock.stop(span, "failed"); throw error; }
}

export function parseLuaTiming(line: string, instanceId: number, epoch: string): TimingRecord | null {
	const index = line.indexOf(TIMING_MARKER);
	if (index < 0) return null;
	const parts = line.slice(index + TIMING_MARKER.length).split("\t");
	let meta: Record<string, unknown>;
	try { meta = JSON.parse(parts[0]); } catch (error) { console.warn("Invalid profiling metadata:", error); return null; }
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
	if (meta.v !== 1 || typeof meta.jobId !== "string" || typeof meta.stage !== "string"
		|| typeof meta.id !== "string" || !number(meta.revision)
		|| !Number.isSafeInteger(meta.revision) || meta.revision < 1
		|| !["execution", "inclusive", "wait", "round-trip"].includes(String(meta.kind))
		|| [meta.jobId, meta.stage, meta.id].some(value => !value || String(value).length > 500)
		|| !["source-lua", "destination-lua", "recovery-lua"].includes(String(meta.owner))
		|| !["running", "completed", "failed", "interrupted", "skipped"].includes(String(meta.status))) return null;
	const parse = (i: number) => parts[i] === "-" ? null : parseProfiler(parts[i] ?? "");
	const record = { ...meta, instanceId, clockId: `${instanceId}:${epoch}:${meta.jobId}`,
		startMs: parse(1), endMs: parse(2), executionMs: parse(3), raw: line.slice(index),
	} as unknown as TimingRecord;
	for (const key of ["operationId", "exportId", "parent"] as const) {
		if (typeof record[key] !== "string") delete record[key];
	}
	if (parts.length !== 4 || parts.slice(1).some(value => value !== "-" && parseProfiler(value) === null)) {
		record.error = "Profiler output could not be parsed";
		record.startMs = record.endMs = record.executionMs = null;
	}
	for (const key of ["startTick", "endTick", "ticksElapsed", "batchCount", "workTicks", "batch"] as const) {
		if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || record[key]! < 0)) delete record[key];
	}
	if (record.startMs !== null && record.endMs !== null && record.endMs < record.startMs) {
		record.error = "Profiler boundaries are reversed";
		record.endMs = null;
	}
	return record;
}

export class TimingClock {
	readonly clockId: string;
	exportId?: string;
	operationId?: string;
	private records = new Map<string, TimingRecord>();
	private origin: number;
	private sequence = 0;
	constructor(readonly jobId: string, readonly owner: TimingOwner,
		private emit: (record: TimingRecord) => void, private now: () => number = () => performance.now()) {
		this.origin = now();
		this.clockId = `${owner}:${processId}:${jobId}:${randomUUID()}`;
	}
	offset() { return Math.max(0, this.now() - this.origin); }
	private publish(record: TimingRecord) {
		const value = { ...record, operationId: this.operationId ?? record.operationId, exportId: this.exportId ?? record.exportId };
		this.records.set(record.id, value);
		try { this.emit(value); } catch (error) { console.warn("Profiling sink failed:", error); }
	}
	bind(operationId: string) {
		this.operationId = operationId;
		for (const record of this.records.values()) this.publish({ ...record, revision: record.revision + 1 });
	}
	start(stage: string, kind: TimingRecord["kind"] = "inclusive", parent?: string): TimingRecord {
		const record: TimingRecord = { v: 1, id: `${stage}:${++this.sequence}`, clockId: this.clockId,
			jobId: this.jobId, operationId: this.jobId, owner: this.owner, stage, kind, parent: parent ?? parentContext.getStore(),
			status: "running", revision: 1, startMs: this.offset(), endMs: null, executionMs: null };
		this.publish(record);
		return record;
	}
	stop(record: TimingRecord, status: TimingRecord["status"] = "completed") {
		if (record.status !== "running") return;
		record.endMs = this.offset(); record.status = status; record.revision++;
		if (record.kind === "execution") record.executionMs = record.endMs - record.startMs!;
		record.revision = Math.max(record.revision, (this.records.get(record.id)?.revision ?? 0) + 1);
		this.publish(record);
	}
	async measure<T>(stage: string, kind: TimingRecord["kind"], fn: () => T | Promise<T>): Promise<T> {
		const record = this.start(stage, kind);
		try { const result = await parentContext.run(record.id, fn); this.stop(record, result && typeof result === "object" && "success" in result && result.success === false ? "failed" : "completed"); return result; }
		catch (error) { this.stop(record, "failed"); throw error; }
	}
}
