import type { ConflictEntry, ResolutionAction } from "./lineage-resolution";

export type CopyState = "present" | "missing" | "unknown" | "none";

export interface QuarantineCopy {
	instanceId: number | null;
	platformName: string | null;
	generation: number | null;
	transferId: string | null;
	state: CopyState;
	newer: boolean;
}

export interface QuarantineRow {
	key: string;
	left: QuarantineCopy;
	right: QuarantineCopy;
	leftAction: ResolutionAction | null;
	centerAction: ResolutionAction | null;
	rightAction: ResolutionAction | null;
	rightKeeps: boolean;
	blocked: string | null;
	resolution: ConflictEntry["resolution"];
}

const LEFT_ACTIONS: readonly ResolutionAction[] = ["keep_this", "adopt", "release"];

function holderState(conflict: ConflictEntry): CopyState {
	if (conflict.holderInstanceId === null) return "none";
	if (conflict.liveVerdict === "stale_self" || conflict.holderPresence === "present") return "present";
	if (conflict.holderPresence === "absent") return "missing";
	return "unknown";
}

export function quarantineRow(conflict: ConflictEntry): QuarantineRow {
	const actions = conflict.actions;
	const duplicate = conflict.liveVerdict === "duplicate";
	const leftAction = LEFT_ACTIONS.find(action => actions.includes(action))
		?? (!duplicate && actions.includes("new_platform") ? "new_platform" : null);
	const centerAction: ResolutionAction | null = duplicate && actions.includes("new_platform") ? "new_platform" : null;
	const rightAction: ResolutionAction | null = actions.includes("keep_other") ? "keep_other"
		: actions.includes("stale_copy") ? "stale_copy" : null;
	const leftGeneration = conflict.generation;
	const rightGeneration = conflict.holderInstanceId === null ? null : conflict.holderGeneration;
	const comparable = leftGeneration !== null && rightGeneration !== null && leftGeneration !== rightGeneration;
	const right: QuarantineCopy = {
		instanceId: conflict.holderInstanceId,
		platformName: conflict.holderPlatformName ?? conflict.platformName,
		generation: rightGeneration,
		transferId: conflict.holderLastTransferId ?? null,
		state: holderState(conflict),
		newer: comparable && rightGeneration! > leftGeneration!,
	};
	return {
		key: `${conflict.instanceId}:${conflict.platformIndex}`,
		left: {
			instanceId: conflict.instanceId,
			platformName: conflict.platformName,
			generation: leftGeneration,
			transferId: conflict.lastTransferId ?? null,
			state: "present",
			newer: comparable && leftGeneration! > rightGeneration!,
		},
		right,
		leftAction,
		centerAction,
		rightAction,
		rightKeeps: rightAction === "keep_other" || (rightAction === "stale_copy" && right.state === "present"),
		blocked: conflict.blocked,
		resolution: conflict.resolution,
	};
}

export function quarantinedKeys(conflicts: readonly ConflictEntry[]): Set<string> {
	return new Set(conflicts.map(conflict => `${conflict.instanceId}:${conflict.platformIndex}`));
}
