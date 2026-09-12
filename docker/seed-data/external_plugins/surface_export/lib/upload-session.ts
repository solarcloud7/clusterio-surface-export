import { getErrorMessage, RCON_CHUNK_SIZE, toAsciiJson } from "../helpers";

export const UPLOAD_PROTOCOL = 1;
export interface UploadLimits {
	chunkBytes: number; maxUploadBytes: number; maxBufferedBytes: number; maxSessions: number;
}
export interface UploadReceipt {
	version: number; success: boolean; state?: string; error?: string;
	attemptId?: string; operationId?: string; epoch?: string; jobId?: string;
	receivedChunks?: number; receivedBytes?: number;
	highWater?: number;
	limits?: UploadLimits;
}
export type UploadCall = (action: string, request: Record<string, unknown>) => Promise<UploadReceipt>;

/** An unknown commit outcome is not a failed import and cannot authorize source release. */
export class UploadUncertain extends Error {
	constructor(message: string, readonly attemptId: string, readonly epoch: string, readonly jobId?: string) {
		super(message);
	}
}
class UploadIdentityMismatch extends Error {}

export class UploadSessions {
	private epoch = "";
	private generation = 0;
	private limits?: Readonly<UploadLimits>;
	private sequence = 0;
	private begins: Promise<unknown> = Promise.resolve();
	private active = new Map<string, Promise<UploadReceipt>>();
	private cleanup = new Map<string, string>();
	private cleanupTimer?: NodeJS.Timeout;
	private cleanupRunning = false;
	private cleanupErrors = new Map<string, string>();
	constructor(private readonly call: UploadCall, private readonly report: (message: string) => void = console.warn) {}

	async initialize(epoch: string): Promise<void> {
		this.stop();
		const generation = this.generation;
		const reply = await this.call("initialize", { version: UPLOAD_PROTOCOL, epoch });
		if (generation !== this.generation) throw new Error("Upload initialization was stopped or replaced");
		this.check(reply);
		if (reply.epoch !== epoch) throw new Error("Upload runtime epoch mismatch");
		if (!Number.isSafeInteger(reply.highWater ?? 0) || (reply.highWater ?? 0) < 0) throw new Error("Invalid upload sequence checkpoint");
		const limits = reply.limits;
		if (!limits || ![limits.chunkBytes, limits.maxUploadBytes, limits.maxBufferedBytes, limits.maxSessions]
			.every(value => Number.isSafeInteger(value) && value > 0)
			|| limits.chunkBytes > RCON_CHUNK_SIZE || limits.chunkBytes > limits.maxUploadBytes
			|| limits.maxUploadBytes > limits.maxBufferedBytes) {
			throw new Error("Invalid or missing receiver upload limits; deploy matching Node and Lua");
		}
		this.limits = Object.freeze({ ...limits });
		this.sequence = reply.highWater ?? 0;
		this.epoch = epoch;
	}

	stop(): void {
		this.generation++;
		this.epoch = "";
		this.limits = undefined;
		if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
		this.cleanupTimer = undefined;
		this.cleanup.clear();
		this.cleanupErrors.clear();
		this.active.clear();
		this.begins = Promise.resolve();
	}

	private check(reply: UploadReceipt): UploadReceipt {
		if (reply.version !== UPLOAD_PROTOCOL || reply.success !== true) {
			throw new Error(reply.error || "Unsupported upload protocol; deploy matching Node and Lua");
		}
		return reply;
	}

	private checkIdentity(reply: UploadReceipt, operationId: string, attemptId: string, begin = false): void {
		if (reply.state !== "unavailable" && (typeof reply.attemptId !== "string" || !reply.attemptId || reply.operationId !== operationId
			|| (!begin && reply.attemptId !== attemptId))) {
			throw new UploadIdentityMismatch("Upload receipt identity does not match this operation");
		}
	}

	send(operationId: string, platformName: string, forceName: string, data: unknown): Promise<UploadReceipt> {
		if (!operationId) return Promise.reject(new Error("Upload requires an operation identity"));
		const existing = this.active.get(operationId);
		if (existing) return existing;
		if (!this.limits) return Promise.reject(new Error("Upload runtime is not ready"));
		if (this.active.size + this.cleanup.size >= this.limits.maxSessions) return Promise.reject(new Error("Upload admission is full or cleanup is pending"));
		const pending = this.upload(operationId, platformName, forceName, data);
		this.active.set(operationId, pending);
		void pending.finally(() => {
			if (this.active.get(operationId) === pending) this.active.delete(operationId);
		}).catch(() => undefined);
		return pending;
	}

	private async upload(operationId: string, platformName: string, forceName: string, data: unknown): Promise<UploadReceipt> {
		const epoch = this.epoch;
		const limits = this.limits;
		if (!epoch || !limits) throw new Error("Upload runtime is not ready");
		// ASCII JSON makes string offsets exact encoded-byte offsets, including Unicode names.
		const json = toAsciiJson(JSON.stringify(data));
		if (json.length > limits.maxUploadBytes) throw new Error(`Upload exceeds receiver encoded-byte limit (${limits.maxUploadBytes} bytes)`);
		const totalChunks = Math.ceil(json.length / limits.chunkBytes);
		let attemptId = "";
		let commitSent = false;
		const invoke = async (action: string, fields: Record<string, unknown> = {}) => {
			if (this.epoch !== epoch) throw new Error("Upload runtime stopped or replaced");
			const reply = this.check(await this.call(action, { version: UPLOAD_PROTOCOL, attemptId, operationId, ...fields }));
			if (this.epoch !== epoch) throw new Error("Upload runtime stopped or replaced");
			this.checkIdentity(reply, operationId, attemptId, action === "begin");
			return reply;
		};
		try {
			// Allocate sequences in actual begin order, not while concurrent encoders are working.
			const begin = this.begins.catch(() => undefined).then(async () => {
				const sequence = ++this.sequence;
				attemptId = `${epoch}:${sequence}`;
				return invoke("begin", { epoch, sequence, operationId, platformName, forceName,
					totalBytes: json.length, totalChunks });
			});
			this.begins = begin;
			const admitted = await begin;
			if (admitted.state === "accepted" && admitted.jobId) return admitted;
			if (admitted.state !== "receiving" || admitted.attemptId !== attemptId) {
				throw new UploadUncertain("Operation already has an upload attempt; inspect job status", admitted.attemptId || attemptId, epoch, admitted.jobId);
			}
			for (let index = 1; index <= totalChunks; index++) {
				await invoke("chunk", { index, data: json.slice((index - 1) * limits.chunkBytes, index * limits.chunkBytes) });
			}
			commitSent = true;
			const result = await invoke("commit");
			if (result.state === "accepted" && result.jobId) return result;
			if (result.state === "rejected") { commitSent = false; throw new Error(result.error || "Import rejected"); }
			throw new UploadUncertain(result.error || "Import admission is unconfirmed", attemptId, epoch, result.jobId);
		} catch (error) {
			if (attemptId && this.epoch === epoch) {
				try {
					const status = await invoke("status");
					if (status.state === "accepted" && status.jobId) return status;
					if (status.state === "receiving") {
						await invoke("abort");
						commitSent = false;
					} else if (status.state === "rejected" || status.state === "aborted") commitSent = false;
				} catch (cleanupError) {
					if (cleanupError instanceof UploadIdentityMismatch) {
						throw new UploadUncertain(cleanupError.message, attemptId, epoch);
					}
					this.cleanup.set(attemptId, operationId);
					this.reportCleanup(attemptId, cleanupError);
					this.scheduleCleanup(epoch);
					if (commitSent) throw new UploadUncertain(`${getErrorMessage(error)}; status check: ${getErrorMessage(cleanupError)}`, attemptId, epoch);
					throw new Error(getErrorMessage(error), {cause: cleanupError});
				}
			}
			if (error instanceof UploadUncertain) throw error;
			if (commitSent) throw new UploadUncertain(getErrorMessage(error), attemptId, epoch);
			throw error;
		}
	}

	private scheduleCleanup(epoch: string): void {
		if (this.cleanupTimer || this.cleanupRunning || !this.cleanup.size || this.epoch !== epoch) return;
		this.cleanupTimer = setTimeout(() => {
			this.cleanupTimer = undefined;
			void this.reconcileCleanup(epoch);
		}, 5000);
		this.cleanupTimer.unref?.();
	}

	private reportCleanup(attemptId: string, error: unknown): void {
		const message = getErrorMessage(error);
		if (this.cleanupErrors.get(attemptId) !== message) {
			this.cleanupErrors.set(attemptId, message);
			this.report(`Upload buffer cleanup pending for ${attemptId}: ${message}`);
		}
	}

	async reconcileCleanup(epoch = this.epoch): Promise<void> {
		if (this.cleanupRunning || !epoch || this.epoch !== epoch) return;
		this.cleanupRunning = true;
		try {
			for (const [attemptId, operationId] of [...this.cleanup].slice(0, this.limits?.maxSessions ?? 0)) {
				if (this.epoch !== epoch) break;
				try {
					const request = { version: UPLOAD_PROTOCOL, attemptId, operationId };
					const status = this.check(await this.call("status", request));
					if (this.epoch !== epoch) break;
					this.checkIdentity(status, operationId, attemptId);
					if (status.state === "receiving") this.check(await this.call("abort", request));
					// Admitting/accepted/unavailable belong to job observation; never replay or release them.
					this.cleanup.delete(attemptId);
					this.cleanupErrors.delete(attemptId);
				} catch (error) {
					if (error instanceof UploadIdentityMismatch) {
						this.cleanup.delete(attemptId);
						this.cleanupErrors.delete(attemptId);
						this.report(`Upload buffer cleanup refused for ${attemptId}: ${error.message}`);
						continue;
					}
					return this.reportCleanup(attemptId, error);
				}
			}
		} finally {
			this.cleanupRunning = false;
			this.scheduleCleanup(this.epoch);
		}
	}
}
