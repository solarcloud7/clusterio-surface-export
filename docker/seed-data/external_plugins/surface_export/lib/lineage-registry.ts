import fs from "fs/promises";
import * as lib from "@clusterio/lib";
import { enqueueWrite } from "./persist-queue";
import { getErrorMessage } from "../helpers";
import { isGeneration, isLineage, type LineageEntry, type TransferCommit } from "../shared/lineage";
import { RESOLUTION_ACTIONS, type ResolutionRecord } from "../shared/lineage-resolution";

export { isGeneration, isLineage, type LineageEntry, type LineageSource, type TransferCommit } from "../shared/lineage";

export const LINEAGE_REGISTRY_FILENAME = "surface_export_lineage_registry.json";

export type LineageCommitPlan =
	| { kind: "legacy" }
	| { kind: "lineage"; lineage: string; fromGeneration: number; toGeneration: number }
	| { kind: "refused"; error: string };

function validEntry(value: unknown): value is LineageEntry {
	const entry = value as Partial<LineageEntry> | null;
	return Boolean(entry) && Number.isSafeInteger(entry!.instanceId) && isGeneration(entry!.generation)
		&& typeof entry!.platformName === "string" && typeof entry!.forceName === "string"
		&& (entry!.lastExportId === null || (typeof entry!.lastExportId === "string" && entry!.lastExportId !== ""))
		&& typeof entry!.updatedAt === "number" && Number.isFinite(entry!.updatedAt)
		&& (entry!.source === "claim" || entry!.source === "transfer" || entry!.source === "resolution");
}

function validResolution(id: unknown, value: unknown): value is ResolutionRecord {
	const record = value as Partial<ResolutionRecord> | null;
	return typeof id === "string" && id !== "" && Boolean(record) && record!.requestId === id
		&& typeof record!.signature === "string" && (RESOLUTION_ACTIONS as readonly string[]).includes(String(record!.action))
		&& Number.isSafeInteger(record!.instanceId) && Number.isSafeInteger(record!.platformIndex)
		&& typeof record!.platformUid === "string" && typeof record!.step === "string"
		&& (record!.status === "in_progress" || record!.status === "completed" || record!.status === "failed")
		&& (record!.lineage === null || isLineage(record!.lineage));
}

function sameEntry(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function lineageCommitPlan(intent: { lineage?: string | null; lineageGeneration?: number | null },
	held: { lineage?: unknown; generation?: unknown }): LineageCommitPlan {
	const intentCarries = intent.lineage !== undefined && intent.lineage !== null;
	const holdCarries = held.lineage !== undefined && held.lineage !== null;
	if (!intentCarries && !holdCarries) return { kind: "legacy" };
	if (intentCarries !== holdCarries) {
		return { kind: "refused", error: "Transfer and destination hold disagree on whether the platform has a lineage" };
	}
	if (!isLineage(intent.lineage) || !isGeneration(intent.lineageGeneration)
		|| held.lineage !== intent.lineage || held.generation !== intent.lineageGeneration + 1) {
		return { kind: "refused", error: "Destination hold lineage does not match this transfer" };
	}
	return { kind: "lineage", lineage: intent.lineage, fromGeneration: intent.lineageGeneration, toGeneration: intent.lineageGeneration + 1 };
}

export function transferCommitDecision(entry: LineageEntry | undefined, commit: TransferCommit): "write" | "noop" | string {
	if (!isLineage(commit.lineage) || !isGeneration(commit.fromGeneration) || commit.toGeneration !== commit.fromGeneration + 1) {
		return "the transfer does not advance a valid lineage by one generation";
	}
	if (entry && entry.instanceId === commit.targetInstanceId && entry.generation === commit.toGeneration
		&& entry.lastExportId === commit.transferId) return "noop";
	if (!entry) return commit.fromGeneration === 0 ? "write" : `no registry entry exists for generation ${commit.fromGeneration}`;
	if (entry.instanceId === commit.sourceInstanceId && entry.generation === commit.fromGeneration) return "write";
	return `the registry records instance ${entry.instanceId} at generation ${entry.generation}`;
}

export class LineageRegistry {
	private entries = new Map<string, LineageEntry>();
	private resolutions = new Map<string, ResolutionRecord>();
	private file: string | null = null;
	private queue: Promise<void> = Promise.resolve();
	loadError: string | null = null;
	fileMissing = false;

	constructor(private readonly now: () => number = Date.now) {}

	async load(file: string): Promise<void> {
		this.file = file;
		this.entries = new Map();
		this.resolutions = new Map();
		this.loadError = null;
		this.fileMissing = false;
		try {
			const saved = JSON.parse(await fs.readFile(file, "utf8")) as { version?: unknown; entries?: unknown; resolutions?: unknown };
			if (saved?.version !== 1 || !Array.isArray(saved.entries)) throw new Error("not a version 1 lineage registry");
			const entries = new Map<string, LineageEntry>();
			for (const pair of saved.entries as unknown[]) {
				if (!Array.isArray(pair) || pair.length !== 2 || !isLineage(pair[0]) || !validEntry(pair[1]) || entries.has(pair[0])) {
					throw new Error("invalid or duplicate lineage entry");
				}
				entries.set(pair[0], { ...pair[1] });
			}
			const resolutions = new Map<string, ResolutionRecord>();
			if (saved.resolutions !== undefined && !Array.isArray(saved.resolutions)) throw new Error("invalid resolution records");
			for (const pair of (saved.resolutions ?? []) as unknown[]) {
				if (!Array.isArray(pair) || pair.length !== 2 || !validResolution(pair[0], pair[1]) || resolutions.has(pair[0])) {
					throw new Error("invalid or duplicate resolution record");
				}
				resolutions.set(pair[0], { ...pair[1] });
			}
			this.entries = entries;
			this.resolutions = resolutions;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.fileMissing = true;
				return;
			}
			this.loadError = `Platform lineage registry ${file} is unreadable (${getErrorMessage(error)}); `
				+ "startup recovery and lineage transfers are refused until it is repaired";
		}
	}

	markUnreadable(reason: string): void {
		this.loadError = `Platform lineage registry ${this.file} is unreadable (${reason}); `
			+ "startup recovery and lineage transfers are refused until it is repaired";
	}

	get(lineage: string): LineageEntry | undefined {
		const entry = this.entries.get(lineage);
		return entry ? { ...entry } : undefined;
	}

	resolution(requestId: string): ResolutionRecord | undefined {
		const record = this.resolutions.get(requestId);
		return record ? { ...record } : undefined;
	}

	listResolutions(): ResolutionRecord[] {
		return [...this.resolutions.values()].map(record => ({ ...record }));
	}

	precheckTransfer(commit: TransferCommit): string | null {
		if (this.loadError) return this.loadError;
		const decision = transferCommitDecision(this.get(commit.lineage), commit);
		return decision === "write" || decision === "noop" ? null : decision;
	}

	async commitTransfer(commit: TransferCommit): Promise<"write" | "noop"> {
		return this.update(draft => {
			const decision = transferCommitDecision(draft.get(commit.lineage), commit);
			if (decision !== "write" && decision !== "noop") throw new Error(`Lineage registry refused the transfer: ${decision}`);
			if (decision === "write") {
				draft.set(commit.lineage, { instanceId: commit.targetInstanceId, generation: commit.toGeneration,
					platformName: commit.platformName, forceName: commit.forceName, lastExportId: commit.transferId,
					updatedAt: this.now(), source: "transfer" });
			}
			return decision;
		});
	}

	update<T>(mutate: (draft: Map<string, LineageEntry>, resolutions: Map<string, ResolutionRecord>) => T): Promise<T> {
		if (this.loadError) return Promise.reject(new Error(this.loadError));
		const run = this.queue.then(async () => {
			const draft = new Map([...this.entries].map(([lineage, entry]) => [lineage, { ...entry }]));
			const resolutionDraft = new Map([...this.resolutions].map(([id, record]) => [id, { ...record }]));
			const result = mutate(draft, resolutionDraft);
			let changed = false;
			for (const [lineage, entry] of draft) {
				const prior = this.entries.get(lineage);
				if (sameEntry(prior, entry)) continue;
				if (!isLineage(lineage) || !validEntry(entry)) throw new Error(`Invalid lineage registry entry for ${lineage}`);
				if (prior && entry.generation <= prior.generation) {
					throw new Error(`Lineage ${lineage} generation must increase beyond ${prior.generation}`);
				}
				changed = true;
			}
			for (const lineage of this.entries.keys()) {
				if (!draft.has(lineage)) throw new Error(`Lineage ${lineage} cannot be removed from the registry`);
			}
			for (const [id, record] of resolutionDraft) {
				if (sameEntry(this.resolutions.get(id), record)) continue;
				if (!validResolution(id, record)) throw new Error(`Invalid resolution record ${id}`);
				changed = true;
			}
			for (const id of this.resolutions.keys()) {
				if (!resolutionDraft.has(id)) throw new Error(`Resolution ${id} cannot be removed from the registry`);
			}
			if (changed) {
				await this.write(draft, resolutionDraft);
				this.entries = draft;
				this.resolutions = resolutionDraft;
			}
			return result;
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async write(next: Map<string, LineageEntry>, resolutions: Map<string, ResolutionRecord>): Promise<void> {
		const file = this.file;
		if (!file) return;
		const payload = JSON.stringify(resolutions.size ? { version: 1, entries: [...next], resolutions: [...resolutions] } : { version: 1, entries: [...next] });
		await enqueueWrite(file, () => lib.safeOutputFile(file, payload));
	}
}
