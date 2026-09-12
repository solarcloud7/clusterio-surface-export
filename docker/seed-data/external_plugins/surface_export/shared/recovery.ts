export type PlatformSourceOfTruth = "plugin_history" | "save_game";

export type SourceRollback = "attempted" | "succeeded" | "failed";

export function sourceRollbackFromEvents(events: readonly { eventType?: unknown }[]): SourceRollback | undefined {
	for (let i = events.length - 1; i >= 0; i--) {
		switch (events[i].eventType) {
			case "rollback_attempt": return "attempted";
			case "rollback_success": return "succeeded";
			case "rollback_failed": return "failed";
		}
	}
	return undefined;
}

export interface RecoveryNotice {
	platformIndex: number;
	platformName: string;
	platformUid: string;
	exportId: string;
	status: "accepted" | "protected";
}

export interface InstanceRecoveryStatus {
	mode?: PlatformSourceOfTruth;
	epoch: string;
	state: "reconciling" | "ready" | "blocked";
	notices: RecoveryNotice[];
	error?: string;
}

export function recoveryMode(value: unknown): PlatformSourceOfTruth {
	if (value == null || value === "plugin_history") return "plugin_history";
	if (value === "save_game") return value;
	throw new Error("Platform source of truth must be plugin_history or save_game");
}

export function hasUnresolvedOwnership(instanceId: number, pending: Iterable<{ sourceInstanceId: number; targetInstanceId: number }>,
	active: Iterable<{ sourceInstanceId: number; targetInstanceId: number; status: string; timingPendingRecovery?: boolean }>) {
	const involves = (entry: { sourceInstanceId: number; targetInstanceId: number }) =>
		entry.sourceInstanceId === instanceId || entry.targetInstanceId === instanceId;
	return [...pending].some(involves) || [...active].some(entry => involves(entry)
		&& (entry.timingPendingRecovery || !["completed", "failed", "error"].includes(entry.status)) && entry.status !== "queued");
}

export function protectedSourceIndexes(instanceId: number,
	pending: Iterable<{ sourceInstanceId: number; sourcePlatformIndex?: number }>,
	active: Iterable<{ sourceInstanceId: number; platformIndex?: number; status: string; timingPendingRecovery?: boolean }>) {
	const indexes = [...pending].filter(entry => entry.sourceInstanceId === instanceId).map(entry => entry.sourcePlatformIndex);
	for (const entry of active) {
		if (entry.sourceInstanceId === instanceId && entry.status !== "queued"
			&& (entry.timingPendingRecovery || !["completed", "failed", "error"].includes(entry.status))) indexes.push(entry.platformIndex);
	}
	// Unknown historical indices cannot authorize releasing an arbitrary restored source.
	return [...new Set(indexes.map(index => Number.isInteger(index) && Number(index) >= 0 ? Number(index) : -1))];
}
