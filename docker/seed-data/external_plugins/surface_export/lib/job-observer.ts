import { performance } from "node:perf_hooks";
import type { JobObservation, JobReference, JobStatus, JobStatusBatch } from "../shared/job-status";

/** Read-only observation. No cancellation, retry of work, or ownership decisions live here. */
export class JobObserver {
	private instances = new Map<number, { next: number; cursor: number; pending?: Promise<JobStatusBatch> }>();
	private progress = new Map<string, { signature: string; at: number; epoch: string | undefined }>();
	constructor(private readonly fetch: (instance: number, jobs: JobReference[]) => Promise<JobStatusBatch>,
		private readonly now = () => performance.now()) {}

	async poll(instance: number, jobs: JobReference[]): Promise<(JobStatusBatch & {requested: JobReference[]}) | undefined> {
		const slot = this.instances.get(instance) || { next: -Infinity, cursor: 0 };
		this.instances.set(instance, slot);
		if (slot.pending || this.now() < slot.next || jobs.length === 0) return undefined;
		slot.next = this.now() + 5000;
		const requested = Array.from({length: Math.min(jobs.length,100)}, (_, index) => jobs[(slot.cursor+index)%jobs.length]);
		slot.cursor = (slot.cursor+requested.length)%jobs.length;
		const pending = this.fetch(instance, requested);
		slot.pending = pending;
		try {
			const batch = await pending;
			if (batch.version !== 1 || typeof batch.epoch !== "string" || !Array.isArray(batch.jobs)) {
				throw new Error("Unsupported job status protocol");
			}
			return {...batch, requested};
		} finally { slot.pending = undefined; }
	}

	forget(key: string): void { this.progress.delete(key); }

	observe(key: string, status: JobStatus, thresholdMs: number): JobObservation {
		const signature = JSON.stringify([status.phase, Object.entries(status.work || {}).sort(([a], [b]) => a.localeCompare(b))]);
		const previous = this.progress.get(key);
		if (!previous || previous.epoch !== status.epoch || previous.signature !== signature) {
			this.progress.set(key, { signature, epoch: status.epoch, at: this.now() });
		}
		const stalled = this.now() - this.progress.get(key)!.at >= thresholdMs;
		const message = status.state === "queued" ? "Waiting in Lua queue"
			: status.state === "waiting" ? "Waiting for a scheduled Lua phase"
				: status.state === "running" ? (stalled ? "No progress observed" : "Lua work progressing")
					: status.state === "completed" ? "Lua work completed; awaiting confirmed resolution"
						: status.state === "failed" ? "Lua job failed; awaiting recovery result"
							: status.state === "interrupted" ? "Lua job interrupted; protections retained"
								: status.state === "cleanup-pending" ? "Destination cleanup pending"
									: "Status unavailable";
		return {message, reason: status.error, state: status.state, phase: status.phase, epoch: status.epoch,
			observedTick: status.observedTick, work: status.work, waitUntilTick: status.waitUntilTick};
	}
}
