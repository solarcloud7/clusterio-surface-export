import fs from "node:fs/promises";
import { safeOutputFile } from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import type { ActiveTransfer } from "../messages";

export interface QueuedTransferRequest {
	sourceInstanceId: number; sourcePlatformIndex: number; targetInstanceId: number;
	forceName?: string; targetPlanet?: string | null; platformName?: string;
}
export interface QueueEntry {
	id: string;
	request: QueuedTransferRequest;
	operation: ActiveTransfer;
}
const terminal = (operation: ActiveTransfer) => ["completed", "failed", "error", "cleanup_failed"].includes(operation.status)
	&& !operation.timingPendingRecovery;
const instances = (entry: QueueEntry) => [entry.request.sourceInstanceId, entry.request.targetInstanceId];

// Admission retains each operation through cleanup/recovery. Capacity permits bounded
// overlap of external work; Factorio's shared scheduler still controls Lua job steps.
export class TransferRequestQueue {
	readonly entries = new Map<string, QueueEntry>();
	private running = new Set<string>();
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private pumping = false;
	private path?: string;
	private unavailable?: Error;
	get admissionError(): string | undefined { return this.unavailable?.message; }

	constructor(private hooks: {
		run(entry: QueueEntry): Promise<void>;
		interrupted(entry: QueueEntry): Promise<void>;
		busyInstances(): number[];
		capacity?(): number;
		error(error: unknown): void;
	}) {}

	async init(path: string) {
		this.path = path;
		try { await this.load(); }
		catch (error) {
			this.unavailable = new Error(`Transfer queue unavailable; repair its journal and restart: ${String(error)}`);
			this.hooks.error(this.unavailable);
		}
	}

	private async load() {
		let saved: QueueEntry[];
		try { saved = JSON.parse(await fs.readFile(this.path!, "utf8")); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (!Array.isArray(saved) || saved.length > 100 || saved.some(entry => !entry?.id || !entry.request || !entry.operation)) {
			throw new Error("Invalid transfer queue journal; preserved for diagnosis");
		}
		// Never replay an export after a process restart: delivery may have happened before the crash.
		for (const entry of saved) await this.hooks.interrupted(entry);
		await this.persist();
	}

	find(request: QueuedTransferRequest) {
		return [...this.entries.values()].find(entry => entry.request.sourceInstanceId === request.sourceInstanceId
			&& entry.request.sourcePlatformIndex === request.sourcePlatformIndex
			&& (entry.request.forceName || "player") === (request.forceName || "player"));
	}

	async add(entry: QueueEntry) {
		if (this.unavailable) throw this.unavailable;
		if (this.stopped) throw new Error("Controller is shutting down; transfer was not queued");
		if (this.entries.size >= 100) throw new Error("Transfer queue is full (100 requests)");
		this.entries.set(entry.id, entry);
		try { await this.persist(); }
		catch (error) { this.entries.delete(entry.id); throw error; }
		this.wake();
	}

	async persist() {
		if (this.unavailable) throw this.unavailable;
		if (!this.path) return;
		// Timers and profiler state are not durable queue state.
		const value = JSON.stringify([...this.entries.values()].map(entry => ({ ...entry,
			operation: { ...entry.operation, validationTimeout: undefined, timing: undefined } })));
		await enqueueWrite(this.path, () => safeOutputFile(this.path!, value));
	}

	private wake() {
		if (this.stopped || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.pump().catch(error => this.hooks.error(error));
		}, 100);
		this.timer.unref();
	}

	async pump() {
		if (this.pumping || this.stopped || this.unavailable) return;
		this.pumping = true;
		try {
			let removed = false;
			for (const [id, entry] of this.entries) {
				if (!this.running.has(id) && terminal(entry.operation)) { this.entries.delete(id); removed = true; }
			}
			if (removed) await this.persist();
			const configured = this.hooks.capacity?.() ?? 1;
			const capacity = Number.isInteger(configured) && configured >= 1 && configured <= 4 ? configured : 1;
			// Unknown/recovering ownership blocks an instance regardless of normal capacity.
			const occupied = new Map(this.hooks.busyInstances().map(id => [id, Infinity]));
			const reserve = (entry: QueueEntry) => {
				for (const id of new Set(instances(entry))) occupied.set(id, (occupied.get(id) ?? 0) + 1);
			};
			for (const entry of this.entries.values()) {
				if (entry.operation.status !== "queued" || this.running.has(entry.id)) {
					reserve(entry);
				}
			}
			for (const entry of this.entries.values()) {
				if (entry.operation.status !== "queued" || this.running.has(entry.id)) continue;
				const blocked = instances(entry).some(id => (occupied.get(id) ?? 0) >= capacity);
				// Preserve FIFO for overlapping routes; independent pairs can run concurrently.
				if (blocked) {
					for (const id of instances(entry)) occupied.set(id, Infinity);
					continue;
				}
				reserve(entry);
				this.running.add(entry.id);
				entry.operation.status = "preparing";
				try { await this.persist(); }
				catch (error) { entry.operation.status = "queued"; this.running.delete(entry.id); throw error; }
				void this.hooks.run(entry).catch(error => this.hooks.error(error)).finally(() => {
					this.running.delete(entry.id);
					this.wake();
				});
			}
		} finally {
			this.pumping = false;
			if (this.entries.size) this.wake();
		}
	}

	stop() {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
	}
}
