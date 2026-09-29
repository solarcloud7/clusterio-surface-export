import { randomBytes } from "node:crypto";
import { classifyPlatform, lineageKey, type ClassifyContext, type ControllerHints, type Presence } from "./lineage-classifier";
import type { LineageRegistry } from "./lineage-registry";
import { protectedSourceIndexes } from "../shared/recovery";
import { getErrorMessage } from "../helpers";
import type { LineageEntry, LineageVerdict, PlatformFacts, ResolutionCandidate } from "../shared/lineage";
import { resolutionActions, type ConflictEntry, type PublicResolutionRecord, type ResolutionAction, type ResolutionRecord } from "../shared/lineage-resolution";
import type { ActiveTransfer, PendingTransferIntent, StoredExport } from "../messages";

export interface ResolverHost {
	lineageRegistry: LineageRegistry;
	pendingTransfers: Map<string, PendingTransferIntent>;
	activeTransfers: Map<string, ActiveTransfer>;
	platformStorage: Map<string, StoredExport>;
	recoveryReservations: Map<number, unknown>;
	logger: { warn(message: string): void; info(message: string): void };
	isInstanceOnline(instanceId: number): boolean;
	instanceIds(): number[];
	knownInstanceIds(): number[];
	lineageInTransit(lineage: string | null): boolean;
	completedTransferFrom(instanceId: number, platformUid: string | null): boolean;
	transferIntoTrip?(instanceId: number, lineage: string | null, generation: number | null): string | null;
	owningSourceJob(instanceId: number, platform: PlatformFacts): string | null;
	lineagePresence(wanted: Map<number, Set<string>>): Promise<Map<string, Presence>>;
	send(instanceId: number, message: unknown): Promise<any>;
}

export interface ResolveRequest {
	instanceId: number;
	platformIndex: number;
	platformUid: string;
	action: ResolutionAction;
	requestId: string;
}

export interface ResolveResult {
	success: boolean;
	requestId: string;
	status?: string;
	step?: string;
	error?: string;
	snapshotExportId?: string | null;
	passengers?: number | null;
}

interface Evaluated {
	candidate: ResolutionCandidate;
	verdict: LineageVerdict;
	entry: LineageEntry | undefined;
	holderPresence: Presence | undefined;
}

type Messages = typeof import("../messages");
type ApplyStep = "prepare_delete" | "retarget" | "authorize" | "mint" | "release" | "restore";

const DELETE_ACTIONS: readonly ResolutionAction[] = ["stale_copy", "keep_other", "keep_this"];
const RELEASE_ACTIONS: readonly ResolutionAction[] = ["keep_this", "adopt", "new_platform", "release"];
const ABANDONABLE_STEPS = new Set(["admitted", "snapshot", "delete", "abandon", "minted"]);

function factsOf(candidate: ResolutionCandidate): PlatformFacts {
	return {
		platformIndex: candidate.platformIndex, platformUid: candidate.platformUid, hadIdentity: candidate.hadIdentity,
		lineage: candidate.lineage ?? null, generation: candidate.generation ?? null, hubUnitNumber: candidate.hubUnitNumber ?? null,
		surfaceIndex: candidate.surfaceIndex ?? null, platformName: candidate.platformName ?? null, forceName: candidate.forceName ?? null,
		lockKind: "startup", jobOwns: candidate.jobOwns === true, journalUidMatch: candidate.journalUidMatch === true,
		journalHubMatch: candidate.journalHubMatch === true, protected: candidate.protected === true,
	};
}

export function publicRecord(record: ResolutionRecord): PublicResolutionRecord {
	const { token: _token, ...visible } = record;
	return visible;
}

export class LineageResolver {
	private running = new Map<string, Promise<ResolveResult>>();

	constructor(private readonly host: ResolverHost, private readonly messages: Messages,
		private readonly options: { snapshotWaitMs: number; pollMs: number } = { snapshotWaitMs: 60_000, pollMs: 500 }) {}

	private get registry() { return this.host.lineageRegistry; }

	async candidates(instanceId: number): Promise<{ epoch: string; platforms: ResolutionCandidate[] }> {
		if (!this.host.isInstanceOnline(instanceId)) throw new Error(`Instance ${instanceId} is offline or reconciling`);
		const indexes = protectedSourceIndexes(instanceId, this.host.pendingTransfers.values(), this.host.activeTransfers.values());
		const reply = await this.host.send(instanceId, new this.messages.LineageCandidatesRequest({ protectedSourceIndexes: indexes }));
		if (!reply?.success || typeof reply.epoch !== "string" || !Array.isArray(reply.platforms)) {
			throw new Error(reply?.error || `Instance ${instanceId} did not list its quarantined copies`);
		}
		return { epoch: reply.epoch, platforms: reply.platforms };
	}

	async evaluate(instanceId: number, epoch: string, candidates: ResolutionCandidate[]): Promise<Evaluated[]> {
		const counts = new Map<string, number>();
		for (const candidate of candidates) if (candidate.lineage) counts.set(candidate.lineage, (counts.get(candidate.lineage) ?? 0) + 1);
		const localCopies = new Set(candidates.filter(candidate => candidate.localCopy === true).map(candidate => candidate.platformIndex));
		const context: ClassifyContext = { instanceId, epoch, mode: "plugin_history", allowAdoption: false };
		const hints = (facts: PlatformFacts): ControllerHints => ({
			inTransit: this.host.lineageInTransit(facts.lineage),
			historyMatch: this.host.completedTransferFrom(instanceId, facts.platformUid),
			duplicateLocal: facts.lineage !== null && ((counts.get(facts.lineage) ?? 0) > 1 || localCopies.has(facts.platformIndex)),
			ownerJobId: this.host.owningSourceJob(instanceId, facts),
		});
		const wanted = new Map<number, Set<string>>();
		for (const candidate of candidates) {
			const facts = factsOf(candidate);
			const key = lineageKey(facts, epoch);
			const entry = key ? this.registry.get(key) : undefined;
			const first = classifyPlatform(facts, hints(facts), entry, undefined, context);
			const holder = first.presenceNeeded ?? (entry && entry.instanceId !== instanceId ? entry.instanceId : undefined);
			if (holder !== undefined && first.lineage) {
				const set = wanted.get(holder) ?? new Set<string>();
				set.add(first.lineage);
				wanted.set(holder, set);
			}
		}
		const presence = await this.host.lineagePresence(wanted);
		return candidates.map(candidate => {
			const facts = factsOf(candidate);
			const key = lineageKey(facts, epoch);
			const entry = key ? this.registry.get(key) : undefined;
			const holderPresence = entry && key ? presence.get(`${entry.instanceId}\u0000${key}`) : undefined;
			const verdict = classifyPlatform(facts, hints(facts), entry, holderPresence, context);
			return { candidate, verdict, entry, holderPresence };
		});
	}

	async list(instanceId: number | null): Promise<{ conflicts: ConflictEntry[]; unavailable: Array<{ instanceId: number; reason: string }>; resolutions: PublicResolutionRecord[] }> {
		const conflicts: ConflictEntry[] = [];
		const unavailable: Array<{ instanceId: number; reason: string }> = [];
		const resolutions = this.registry.listResolutions();
		for (const id of instanceId === null ? this.host.instanceIds() : [instanceId]) {
			try {
				const listing = await this.candidates(id);
				for (const { candidate, verdict, entry, holderPresence } of await this.evaluate(id, listing.epoch, listing.platforms)) {
					const gate = resolutionActions(verdict.verdict, candidate.state, { journalUidMatch: candidate.journalUidMatch, historyMatch: verdict.hints.historyMatch });
					const active = resolutions.find(record => record.instanceId === id && record.platformIndex === candidate.platformIndex
						&& (record.platformUid === candidate.platformUid || record.releasedUid === candidate.platformUid) && record.status === "in_progress")
						?? resolutions.find(record => record.deleteInstanceId === id && record.deletePlatformIndex === candidate.platformIndex
							&& record.status === "in_progress");
					conflicts.push({
						instanceId: id, platformIndex: candidate.platformIndex, platformUid: candidate.platformUid,
						platformName: candidate.platformName ?? null, forceName: candidate.forceName ?? null,
						state: candidate.state, storedReason: candidate.reason ?? null, liveVerdict: verdict.verdict,
						lineage: candidate.lineage ?? null, generation: candidate.generation ?? null,
						holderInstanceId: verdict.holderInstanceId ?? null, holderGeneration: verdict.holderGeneration ?? null,
						holderPassengers: holderPresence?.state === "present" ? holderPresence.passengers ?? null : null,
						holderPresence: holderPresence?.state ?? null, holderPlatformName: entry?.platformName ?? null,
						holderLastTransferId: entry?.source === "transfer" ? entry.lastExportId ?? null : null,
						lastTransferId: this.host.transferIntoTrip?.(id, candidate.lineage ?? null, candidate.generation ?? null) ?? null,
						ownerJobId: verdict.ownerJobId ?? candidate.ownerJobId ?? null, retiredExportId: candidate.retiredExportId ?? null,
						passengers: candidate.passengers ?? null, actions: active ? [] : gate.actions,
						blocked: active ? "A resolution is in progress for this copy; retry or abandon it with the same request ID." : gate.blocked,
						hints: { journalUidMatch: verdict.hints.journalUidMatch, journalHubMatch: verdict.hints.journalHubMatch,
							historyMatch: verdict.hints.historyMatch, presence: verdict.hints.presence ?? null },
						resolution: active ? { requestId: active.requestId, action: active.action, step: active.step, status: active.status, error: active.error,
							instanceId: active.instanceId, platformIndex: active.platformIndex, platformUid: active.platformUid } : null,
					});
				}
			} catch (error: unknown) {
				unavailable.push({ instanceId: id, reason: getErrorMessage(error) });
			}
		}
		return { conflicts, unavailable, resolutions: resolutions.map(publicRecord) };
	}

	resolve(request: ResolveRequest): Promise<ResolveResult> {
		const signature = JSON.stringify([request.instanceId, request.platformIndex, request.platformUid, request.action]);
		const existing = this.registry.resolution(request.requestId);
		if (existing && existing.signature !== signature) {
			return Promise.resolve({ success: false, requestId: request.requestId, error: "This request ID already belongs to another resolution" });
		}
		return this.run(request.requestId, () => existing ? this.resume(existing) : this.admit(request, signature));
	}

	abandon(requestId: string): Promise<ResolveResult> {
		const record = this.registry.resolution(requestId);
		if (!record) return Promise.resolve({ success: false, requestId, error: "No resolution has this request ID" });
		return this.run(requestId, async () => {
			const current = this.registry.resolution(requestId)!;
			if (current.status !== "in_progress") return this.result(current);
			if (!ABANDONABLE_STEPS.has(current.step)) {
				return { success: false, requestId, status: current.status, step: current.step,
					error: "This resolution has already deleted or committed a copy; retry it with the same request ID to finish" };
			}
			const reason = current.error ? `Abandoned by an administrator after: ${current.error}` : "Abandoned by an administrator";
			const next = DELETE_ACTIONS.includes(current.action)
				? await this.abandonRecord(current, reason)
				: await this.fail(current, `${reason}; ${current.action === "new_platform" ? "the copy stays quarantined and may already carry a new platform history" : "no copy was changed"}`);
			return this.resume(next);
		});
	}

	private run(requestId: string, work: () => Promise<ResolveResult>): Promise<ResolveResult> {
		const inFlight = this.running.get(requestId);
		if (inFlight) return inFlight;
		const run = work().catch((error: unknown) => ({ success: false, requestId, error: getErrorMessage(error) }));
		this.running.set(requestId, run);
		return run.finally(() => this.running.delete(requestId));
	}

	private refuse(request: ResolveRequest, error: string): ResolveResult {
		return { success: false, requestId: request.requestId, error };
	}

	private async presenceAbsent(lineage: string, instanceIds: number[]): Promise<string | null> {
		const wanted = new Map<number, Set<string>>(instanceIds.map(id => [id, new Set([lineage])]));
		if (!wanted.size) return null;
		const presence = await this.host.lineagePresence(wanted);
		for (const id of instanceIds) {
			const answer = presence.get(`${id}\u0000${lineage}`);
			if (answer?.state === "present") return `Instance ${id} still has a copy of this platform`;
			if (answer?.state !== "absent") return `Instance ${id} could not rule out a copy of this platform (${answer?.state === "unknown" ? answer.reason : "no answer"})`;
		}
		return null;
	}

	private async admit(request: ResolveRequest, signature: string): Promise<ResolveResult> {
		const { instanceId, platformIndex, platformUid, action, requestId } = request;
		if (this.host.recoveryReservations.has(instanceId)) return this.refuse(request, "The instance is reconciling its loaded save; retry after recovery completes");
		const listing = await this.candidates(instanceId);
		const evaluated = await this.evaluate(instanceId, listing.epoch, listing.platforms);
		const target = evaluated.find(item => item.candidate.platformIndex === platformIndex);
		if (!target || target.candidate.platformUid !== platformUid) {
			return this.refuse(request, "This copy changed or is no longer quarantined; refresh and choose again");
		}
		const { candidate, verdict, entry } = target;
		const gate = resolutionActions(verdict.verdict, candidate.state, { journalUidMatch: candidate.journalUidMatch, historyMatch: verdict.hints.historyMatch });
		if (!gate.actions.includes(action)) {
			return this.refuse(request, `Action ${action} is not available for a ${verdict.verdict} copy${gate.blocked ? `: ${gate.blocked}` : ""}`);
		}
		const lineage = candidate.lineage ?? (action === "release" && verdict.mint ? verdict.lineage ?? null : null);
		if (action === "adopt" && lineage) {
			const others = this.host.knownInstanceIds().filter(id => id !== instanceId);
			const refusal = await this.presenceAbsent(lineage, others);
			if (refusal) return this.refuse(request, `${refusal}; adoption refused`);
		}
		let deleteTarget: { instanceId: number; platformIndex: number; platformUid: string; platformName: string; forceName: string;
			exportId: string | null; passengers: number | null } | null = null;
		const journalMatched = candidate.state === "tombstone" || candidate.journalUidMatch === true;
		if (action === "stale_copy" || action === "keep_other") {
			deleteTarget = { instanceId, platformIndex, platformUid, platformName: candidate.platformName ?? "", forceName: candidate.forceName ?? "player",
				exportId: journalMatched ? candidate.retiredExportId ?? null : null, passengers: candidate.passengers ?? null };
			if (journalMatched && !deleteTarget.exportId) return this.refuse(request, "The retired copy's original transfer is unknown; it cannot be deleted safely");
		}
		if (action === "keep_this") {
			const holder = verdict.holderInstanceId;
			if (holder === undefined || !lineage || !this.host.isInstanceOnline(holder) || this.host.recoveryReservations.has(holder)) {
				return this.refuse(request, "The server holding the other copy is offline or reconciling");
			}
			const reply = await this.host.send(holder, new this.messages.LineagePresenceRequest({ lineages: [lineage] }));
			const answer = reply?.success === true && Array.isArray(reply.lineages)
				? reply.lineages.find((item: { lineage?: string }) => item?.lineage === lineage) : undefined;
			if (!answer || answer.present !== true || answer.held === true || !Number.isSafeInteger(answer.platformIndex)
				|| typeof answer.platformUid !== "string" || typeof answer.forceName !== "string") {
				return this.refuse(request, "The other copy could not be identified as a live platform; refresh and choose again");
			}
			deleteTarget = { instanceId: holder, platformIndex: answer.platformIndex, platformUid: answer.platformUid,
				platformName: String(answer.platformName ?? ""), forceName: answer.forceName, exportId: null,
				passengers: Number.isSafeInteger(answer.passengers) ? answer.passengers : null };
		}
		const generation = candidate.generation ?? (lineage !== null && verdict.mint ? verdict.generation ?? null : null);
		const claim = action === "release" && verdict.claim === true && lineage !== null;
		let newGeneration: number | null = null;
		if (action === "adopt") newGeneration = Math.max(entry?.generation ?? -1, generation ?? 0) + 1;
		if (action === "keep_this") newGeneration = (entry?.generation ?? generation ?? 0) + 1;
		if (action === "new_platform") newGeneration = 0;
		if (action === "release") newGeneration = generation;
		const now = Date.now();
		const record: ResolutionRecord = {
			requestId, signature, token: randomBytes(32).toString("hex"), action, verdict: verdict.verdict, instanceId, platformIndex, platformUid,
			platformName: candidate.platformName ?? "", forceName: candidate.forceName ?? "player", lineage, fromGeneration: generation,
			registrySnapshot: JSON.stringify(lineage ? entry ?? null : null), newGeneration, claim, authorized: false, refreshIdentity: journalMatched,
			deleteInstanceId: deleteTarget?.instanceId ?? null, deletePlatformIndex: deleteTarget?.platformIndex ?? null,
			deletePlatformUid: deleteTarget?.platformUid ?? null, deletePlatformName: deleteTarget?.platformName ?? null,
			deleteForceName: deleteTarget?.forceName ?? null, deleteExportId: deleteTarget?.exportId ?? null,
			jobId: null, snapshotExportId: null, releasedUid: null, passengers: deleteTarget ? deleteTarget.passengers : candidate.passengers ?? null,
			step: "admitted", status: "in_progress", error: null, createdAt: now, updatedAt: now,
		};
		const protectedIndexes = protectedSourceIndexes(instanceId, this.host.pendingTransfers.values(), this.host.activeTransfers.values());
		await this.registry.update((draft, resolutions) => {
			if (resolutions.has(requestId)) throw new Error("This request ID already belongs to another resolution");
			const current = lineage ? draft.get(lineage) ?? null : null;
			if (JSON.stringify(current) !== record.registrySnapshot) throw new Error("The lineage registry changed; refresh and choose again");
			for (const other of resolutions.values()) {
				if (other.status !== "in_progress") continue;
				if ((other.instanceId === instanceId && other.platformIndex === platformIndex) || (lineage && other.lineage === lineage)) {
					throw new Error(`Resolution ${other.requestId} is already in progress for this platform`);
				}
			}
			if (lineage && this.host.lineageInTransit(lineage)) throw new Error("A transfer of this platform is in flight");
			if (protectedIndexes.includes(-1) || protectedIndexes.includes(platformIndex)) throw new Error("An unresolved transfer owns this copy");
			if (deleteTarget && deleteTarget.instanceId !== instanceId) {
				const other = protectedSourceIndexes(deleteTarget.instanceId, this.host.pendingTransfers.values(), this.host.activeTransfers.values());
				if (other.includes(-1) || other.includes(deleteTarget.platformIndex)) throw new Error("An unresolved transfer owns the other copy");
			}
			resolutions.set(requestId, record);
		});
		this.host.logger.info(`Platform resolution ${requestId} admitted: ${action} for instance ${instanceId} platform ${platformIndex}`);
		return this.resume(record);
	}

	private async save(record: ResolutionRecord, changes: Partial<ResolutionRecord>): Promise<ResolutionRecord> {
		const next = { ...record, ...changes, updatedAt: Date.now() };
		await this.registry.update((_draft, resolutions) => { resolutions.set(record.requestId, next); });
		return next;
	}

	private result(record: ResolutionRecord, pending?: string): ResolveResult {
		return { success: record.status !== "failed", requestId: record.requestId, status: record.status, step: record.step,
			error: pending ?? record.error ?? undefined, snapshotExportId: record.snapshotExportId, passengers: record.passengers };
	}

	private async apply(instanceId: number, record: ResolutionRecord, step: ApplyStep, platformIndex: number, platformUid: string,
		extra: { lineage?: string | null; generation?: number | null; exportId?: string | null; refreshIdentity?: boolean } = {}) {
		if (!this.host.isInstanceOnline(instanceId) || this.host.recoveryReservations.has(instanceId)) return { pending: `Instance ${instanceId} is offline or reconciling` };
		try {
			const reply = await this.host.send(instanceId, new this.messages.ApplyLineageResolutionRequest({ requestId: record.requestId, step,
				platformIndex, platformUid, token: record.token, lineage: extra.lineage ?? null, generation: extra.generation ?? null,
				exportId: extra.exportId ?? null, refreshIdentity: extra.refreshIdentity === true }));
			return { reply };
		} catch (error: unknown) {
			return { pending: `The ${step} reply was not received (${getErrorMessage(error)}); retry with the same request ID` };
		}
	}

	private async commitRegistry(record: ResolutionRecord, instanceId: number, generation: number, lineage: string): Promise<string | null> {
		const marker = `resolution:${record.requestId}`;
		let refusal: string | null = null;
		await this.registry.update((draft, resolutions) => {
			const current = draft.get(lineage);
			const done = current && current.lastExportId === marker && current.instanceId === instanceId && current.generation === generation;
			if (!done && JSON.stringify(current ?? null) !== record.registrySnapshot) {
				refusal = `The lineage registry changed after this resolution was admitted (${current ? `instance ${current.instanceId} generation ${current.generation}` : "no entry"})`;
				return;
			}
			if (!done) {
				draft.set(lineage, { instanceId, generation, platformName: record.platformName, forceName: record.forceName,
					lastExportId: marker, updatedAt: Date.now(), source: "resolution" });
			}
			resolutions.set(record.requestId, { ...record, lineage, step: "committed", updatedAt: Date.now() });
		});
		return refusal;
	}

	private async resume(initial: ResolutionRecord): Promise<ResolveResult> {
		let record = initial;
		for (;;) {
			if (record.status !== "in_progress") return this.result(record);
			const next = await this.advance(record);
			if (typeof next === "string") return this.result(record, next);
			record = next;
		}
	}

	private fail(record: ResolutionRecord, error: string) {
		this.host.logger.warn(`Platform resolution ${record.requestId} failed: ${error}`);
		return this.save(record, { status: "failed", step: "failed", error });
	}

	private abandonRecord(record: ResolutionRecord, error: string) {
		return this.save(record, { step: "abandon", error });
	}

	private async advance(record: ResolutionRecord): Promise<ResolutionRecord | string> {
		const deleting = DELETE_ACTIONS.includes(record.action);
		if (record.step === "abandon") {
			const outcome = await this.apply(record.deleteInstanceId!, record, "restore", record.deletePlatformIndex!, record.deletePlatformUid!);
			if ("pending" in outcome) return `${record.error}; restoring the copy's protection is pending: ${outcome.pending}`;
			if (outcome.reply?.committed === true && record.snapshotExportId) {
				return this.save(record, { step: "delete", error: `Abandon refused: ${outcome.reply.error || "the deletion is already committed"}; retry to finish it` });
			}
			if (!outcome.reply?.success) return `${record.error}; restoring the copy's protection was refused: ${outcome.reply?.error || "no reason"}`;
			this.host.logger.warn(`Platform resolution ${record.requestId} abandoned: ${record.error}`);
			return this.save(record, { status: "failed", step: "failed" });
		}
		if (record.step === "admitted" && RELEASE_ACTIONS.includes(record.action) && !record.authorized) {
			const outcome = await this.apply(record.instanceId, record, "authorize", record.platformIndex, record.platformUid);
			if ("pending" in outcome) return outcome.pending!;
			if (!outcome.reply?.success) return this.fail(record, outcome.reply?.error || "The copy could not be authorized for release");
			return this.save(record, { authorized: true });
		}
		if (record.step === "admitted" && deleting) {
			const outcome = await this.apply(record.deleteInstanceId!, record, "prepare_delete", record.deletePlatformIndex!, record.deletePlatformUid!);
			if ("pending" in outcome) return outcome.pending!;
			if (!outcome.reply?.success || typeof outcome.reply.jobId !== "string") return this.fail(record, outcome.reply?.error || "The snapshot was refused");
			return this.save(record, { jobId: outcome.reply.jobId, step: "snapshot" });
		}
		if (record.step === "snapshot") return this.awaitSnapshot(record);
		if (record.step === "delete") {
			const instanceId = record.deleteInstanceId!;
			if (!this.host.isInstanceOnline(instanceId)) return `Instance ${instanceId} is offline or reconciling`;
			const exportId = record.deleteExportId ?? record.jobId;
			if (record.deleteExportId && record.deleteExportId !== record.jobId) {
				const outcome = await this.apply(instanceId, record, "retarget", record.deletePlatformIndex!, record.deletePlatformUid!, { exportId: record.deleteExportId });
				if ("pending" in outcome) return outcome.pending!;
				if (!outcome.reply?.success) return `The retired copy could not be prepared for deletion: ${outcome.reply?.error || "refused"}; abandon or retry with the same request ID`;
			}
			let reply;
			try {
				reply = await this.host.send(instanceId, new this.messages.DeleteSourcePlatformRequest({ platformIndex: record.deletePlatformIndex!,
					platformName: record.deletePlatformName ?? "", forceName: record.deleteForceName ?? record.forceName, exportId }));
			} catch (error: unknown) {
				return `The deletion reply was not received (${getErrorMessage(error)}); retry with the same request ID`;
			}
			if (!reply?.success) {
				const error = `Deletion not confirmed: ${reply?.error || "refused"}; the copy stays protected. Retry, or abandon with the same request ID`;
				await this.save(record, { error });
				return error;
			}
			return record.action === "keep_this" ? this.save(record, { step: "deleted", error: null }) : this.save(record, { step: "completed", status: "completed", error: null });
		}
		if ((record.step === "admitted" && (record.action === "adopt" || (record.action === "release" && record.claim)))
			|| (record.step === "deleted" && record.action === "keep_this")
			|| (record.step === "minted" && record.action === "new_platform")) {
			const refusal = await this.commitRegistry(record, record.instanceId, record.newGeneration!, record.lineage!);
			if (refusal) return this.fail(record, `${refusal}; the kept copy stays quarantined`);
			return { ...this.registry.resolution(record.requestId)! };
		}
		if (record.step === "admitted" && record.action === "new_platform") {
			const outcome = await this.apply(record.instanceId, record, "mint", record.platformIndex, record.platformUid, { lineage: record.lineage });
			if ("pending" in outcome) return outcome.pending!;
			if (!outcome.reply?.success || typeof outcome.reply.lineage !== "string") return this.fail(record, outcome.reply?.error || "The new lineage was refused");
			if (outcome.reply.lineage === record.lineage) return this.fail(record, "The new lineage equals the current one; the copy would still share its history");
			return this.save(record, { lineage: outcome.reply.lineage, step: "minted", registrySnapshot: "null" });
		}
		if ((record.step === "admitted" && record.action === "release") || record.step === "committed") {
			const outcome = await this.apply(record.instanceId, record, "release", record.platformIndex, record.platformUid,
				{ lineage: record.lineage, generation: record.lineage ? record.newGeneration : null, refreshIdentity: record.refreshIdentity });
			if ("pending" in outcome) return outcome.pending!;
			if (!outcome.reply?.success) return this.fail(record, outcome.reply?.error || "The release was refused");
			return this.save(record, { releasedUid: outcome.reply.platformUid ?? record.platformUid, step: "completed", status: "completed" });
		}
		return this.fail(record, `Unknown resolution step ${record.step} for ${record.action}`);
	}

	private async awaitSnapshot(record: ResolutionRecord): Promise<ResolutionRecord | string> {
		const instanceId = record.deleteInstanceId!;
		const exportId = `${instanceId}:${record.jobId}`;
		const deadline = Date.now() + this.options.snapshotWaitMs;
		for (;;) {
			if (this.host.platformStorage.has(exportId)) return this.save(record, { snapshotExportId: exportId, step: "delete" });
			if (this.host.isInstanceOnline(instanceId)) {
				try {
					const batch = await this.host.send(instanceId, new this.messages.JobsStatusRequest([{ jobId: record.jobId! }]));
					const status = Array.isArray(batch?.jobs) ? batch.jobs.find((job: { jobId?: string }) => job.jobId === record.jobId) : undefined;
					if (status?.state === "failed" || status?.state === "interrupted") {
						return this.abandonRecord(record, `The snapshot ${status.state} (${status.error || "export failed"}); nothing was deleted`);
					}
					if (!status || status.state === "unavailable") {
						return this.abandonRecord(record, "The instance no longer knows the snapshot job and no snapshot was stored; nothing was deleted");
					}
				} catch (error: unknown) {
					this.host.logger.warn(`Resolution ${record.requestId} snapshot status unavailable: ${getErrorMessage(error)}`);
				}
			}
			if (Date.now() >= deadline) return "Waiting for the snapshot to be stored; retry with the same request ID";
			await new Promise(resolve => setTimeout(resolve, this.options.pollMs));
		}
	}
}
