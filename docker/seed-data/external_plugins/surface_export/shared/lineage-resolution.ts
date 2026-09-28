import type { LineageVerdictName } from "./lineage";

export const RESOLUTION_ACTIONS = ["keep_this", "keep_other", "adopt", "stale_copy", "new_platform", "release"] as const;
export type ResolutionAction = typeof RESOLUTION_ACTIONS[number];

export type ResolutionStep = "admitted" | "snapshot" | "abandon" | "delete" | "deleted" | "minted" | "committed" | "completed" | "failed";

export interface ResolutionRecord {
	requestId: string;
	signature: string;
	token: string;
	action: ResolutionAction;
	verdict: LineageVerdictName;
	instanceId: number;
	platformIndex: number;
	platformUid: string;
	platformName: string;
	forceName: string;
	lineage: string | null;
	fromGeneration: number | null;
	registrySnapshot: string;
	newGeneration: number | null;
	claim: boolean;
	authorized: boolean;
	refreshIdentity: boolean;
	deleteInstanceId: number | null;
	deletePlatformIndex: number | null;
	deletePlatformUid: string | null;
	deletePlatformName: string | null;
	deleteForceName: string | null;
	deleteExportId: string | null;
	jobId: string | null;
	snapshotExportId: string | null;
	releasedUid: string | null;
	passengers: number | null;
	step: ResolutionStep;
	status: "in_progress" | "completed" | "failed";
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export type PublicResolutionRecord = Omit<ResolutionRecord, "token">;

export interface ConflictEntry {
	instanceId: number;
	platformIndex: number;
	platformUid: string | null;
	platformName: string | null;
	forceName: string | null;
	state: "quarantine" | "tombstone" | "resolving";
	storedReason: string | null;
	liveVerdict: LineageVerdictName;
	lineage: string | null;
	generation: number | null;
	holderInstanceId: number | null;
	holderGeneration: number | null;
	holderPassengers: number | null;
	ownerJobId: string | null;
	retiredExportId: string | null;
	passengers: number | null;
	actions: ResolutionAction[];
	blocked: string | null;
	hints: { journalUidMatch: boolean; journalHubMatch: boolean; historyMatch: boolean; presence: string | null };
	resolution: {
		requestId: string; action: ResolutionAction; step: ResolutionStep; status: string; error: string | null;
		instanceId: number; platformIndex: number; platformUid: string;
	} | null;
}

export interface ResolutionFlags {
	journalUidMatch?: boolean;
	historyMatch?: boolean;
}

export function resolutionActions(verdict: LineageVerdictName, state: ConflictEntry["state"], flags: ResolutionFlags = {}): { actions: ResolutionAction[]; blocked: string | null } {
	if (state === "resolving") return { actions: [], blocked: "A resolution is already in progress for this copy; retry or abandon it with the same request ID." };
	switch (verdict) {
		case "duplicate": return { actions: ["keep_this", "keep_other"], blocked: null };
		case "rollback_other":
		case "unregistered":
		case "stale_self":
		case "ahead_of_registry": return { actions: ["adopt", "stale_copy"], blocked: null };
		case "legacy_unclassified":
			return state === "tombstone" || flags.journalUidMatch || flags.historyMatch
				? { actions: ["stale_copy"], blocked: null }
				: { actions: ["new_platform", "stale_copy"], blocked: null };
		case "duplicate_local": return { actions: ["stale_copy"], blocked: null };
		case "normal": return { actions: ["release", "stale_copy"], blocked: null };
		case "no_identity": return { actions: [], blocked: "This copy has no hub, so it has no identity yet. Once it has a hub, check again to release or delete it." };
		case "unverified": return { actions: [], blocked: "The server recorded as holding the current copy cannot confirm it. Bring that server online and check again." };
		case "in_transit": return { actions: [], blocked: "A transfer or resolution of this platform is still unresolved. It settles this copy when it finishes." };
		case "unresolved_handoff": return { actions: [], blocked: "An unresolved transfer owns this copy. It releases or deletes the copy when it settles." };
		default: return { actions: [], blocked: "This copy needs no resolution." };
	}
}
