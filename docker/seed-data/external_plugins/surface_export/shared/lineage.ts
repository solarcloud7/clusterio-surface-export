export const LINEAGE_PATTERN_SOURCE = "^lineage:[^:\\s]+:[1-9][0-9]*$";
const LINEAGE_PATTERN = new RegExp(LINEAGE_PATTERN_SOURCE);

export function isLineage(value: unknown): value is string {
	return typeof value === "string" && value.length <= 200 && LINEAGE_PATTERN.test(value);
}

export function isGeneration(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

export type LineageSource = "claim" | "transfer" | "resolution";

export interface LineageEntry {
	instanceId: number;
	generation: number;
	platformName: string;
	forceName: string;
	lastExportId: string | null;
	updatedAt: number;
	source: LineageSource;
}

export interface TransferCommit {
	lineage: string;
	transferId: string;
	sourceInstanceId: number;
	targetInstanceId: number;
	fromGeneration: number;
	toGeneration: number;
	platformName: string;
	forceName: string;
}

export type LineageVerdictName =
	| "normal" | "unchanged" | "rollback_other" | "in_transit" | "legacy_unclassified" | "unregistered"
	| "stale_self" | "ahead_of_registry" | "unverified" | "duplicate" | "duplicate_local"
	| "unresolved_handoff" | "no_identity";

export interface PlatformFacts {
	platformIndex: number;
	platformUid: string | null;
	hadIdentity: boolean;
	lineage: string | null;
	generation: number | null;
	hubUnitNumber: number | null;
	surfaceIndex: number | null;
	platformName: string | null;
	forceName: string | null;
	lockKind: string | null;
	jobOwns: boolean;
	journalUidMatch: boolean;
	journalHubMatch: boolean;
	protected: boolean;
}

export interface LineageVerdict {
	platformIndex: number;
	verdict: LineageVerdictName;
	lineage?: string;
	generation?: number;
	mint?: true;
	claim?: true;
	adopt?: true;
	adoptGeneration?: number;
	holderInstanceId?: number;
	holderGeneration?: number;
	presenceNeeded?: number;
	hints: { journalUidMatch: boolean; journalHubMatch: boolean; historyMatch: boolean; presence?: string };
}
