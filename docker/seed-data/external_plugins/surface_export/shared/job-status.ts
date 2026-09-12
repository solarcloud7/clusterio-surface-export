export type JobState = "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted" | "cleanup-pending" | "unavailable";
export interface JobReference { jobId?: string; operationId?: string }
export interface JobStatus extends JobReference {
	version?: number;
	epoch?: string;
	state: JobState;
	phase?: string;
	work?: Record<string, number>;
	observedTick?: number;
	startedTick?: number;
	elapsedTicks?: number;
	waitUntilTick?: number;
	error?: string;
	completion?: Record<string, unknown>;
}
export interface JobStatusBatch { version: number; epoch: string; observedTick: number; jobs: JobStatus[] }
export interface JobObservation {
	reason?: string;
	message: string; state: JobState; phase?: string; epoch?: string; observedTick?: number;
	work?: Record<string, number>; waitUntilTick?: number;
}
