export type ClusterPausePhase = "running" | "countdown" | "draining" | "paused";

export type ClusterPauseReason =
	| "last_player_left"
	| "countdown_elapsed"
	| "holds_cleared"
	| "player_joined"
	| "command"
	| "controller_start"
	| "pause_failed"
	| "unknown_state"
	| "disabled"
	| "instance_state";

export interface ClusterPauseHoldEntry {
	participant: string;
	reason: string;
	ref?: string;
}

export interface ClusterPauseOnline {
	instanceId: number;
	name: string;
	players: string[];
}

export interface ClusterPauseState {
	phase: ClusterPausePhase;
	sinceMs: number;
	reason: ClusterPauseReason;
	online: ClusterPauseOnline[];
	holds: ClusterPauseHoldEntry[];
	confirmed: number[];
	paused: number[];
}

export interface ClusterPauseInstanceSummary {
	instanceId: number;
	name: string;
}

export interface ClusterPauseStatus extends ClusterPauseState {
	enabled: boolean;
	countdownMs: number;
	countdownRemainingMs: number | null;
	hold: string | null;
	lastError: string | null;
	onlineCount: number;
	participants: string[];
	unknownInstances: ClusterPauseInstanceSummary[];
	notLoaded: ClusterPauseInstanceSummary[];
	notReady: ClusterPauseInstanceSummary[];
}

export interface ClusterPausePersisted {
	version: 1;
	phase: ClusterPausePhase;
	sinceMs: number;
	paused: number[];
}
