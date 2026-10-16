import { hasUnresolvedPlatformOwnership } from "../shared/operation-lifecycle.js";

export const CLUSTER_PAUSE_RENDEZVOUS = Symbol.for("cluster_pause.rendezvous");
export const PARTICIPANT_NAME = "surface_export";

export interface ClusterPauseHold {
	reason: string;
	ref?: string;
}

export interface ClusterPausePhaseEvent {
	phase: string;
	paused?: number[];
}

export interface ClusterPauseParticipantHandlers {
	listHolds(): ClusterPauseHold[];
	onPhase(event: ClusterPausePhaseEvent): void;
}

export interface ClusterPauseApi {
	registerParticipant(name: string, participant: ClusterPauseParticipantHandlers): void;
	holdsChanged(name: string): void;
}

interface Rendezvous {
	api?: ClusterPauseApi;
	waiting: Array<(api: ClusterPauseApi) => void>;
}

export function joinClusterPause(host: object, ready: (api: ClusterPauseApi) => void): void {
	const target = host as { [CLUSTER_PAUSE_RENDEZVOUS]?: Rendezvous };
	const rendezvous = target[CLUSTER_PAUSE_RENDEZVOUS] ?? (target[CLUSTER_PAUSE_RENDEZVOUS] = { waiting: [] });
	if (rendezvous.api) ready(rendezvous.api);
	else rendezvous.waiting.push(ready);
}

type Operation = {
	transferId: string;
	operationType?: string | null;
	status: string;
	timingPendingRecovery?: boolean | null;
	passengers?: Array<{ name?: unknown }> | null;
};

export interface ParticipantSource {
	activeTransfers: Map<string, Operation>;
	pendingTransfers: Map<string, unknown>;
	recoveryReservations: Map<number, unknown>;
	lineageRegistry?: { listResolutions(): Array<{ requestId: string; status: string }> };
	pendingTransfersLoadError?: string | null;
	transactionLogLoadError?: string | null;
	orchestrator?: { requestQueue: { admissionError?: string | null } };
}

export class ClusterPauseParticipant {
	private api: ClusterPauseApi | null = null;
	private phase = "running";
	private paused = new Set<number>();
	private admissions = 0;
	private readonly starting = new Set<number>();

	constructor(private readonly source: ParticipantSource, private readonly logger: { info(message: string): void }) {}

	get joined(): boolean {
		return this.api !== null;
	}

	attach(host: object): void {
		joinClusterPause(host, api => {
			this.api = api;
			api.registerParticipant(PARTICIPANT_NAME, { listHolds: () => this.listHolds(), onPhase: event => this.onPhase(event) });
			this.logger.info("Registered as a cluster_pause participant");
		});
	}

	onPhase(event: ClusterPausePhaseEvent): void {
		this.phase = event.phase;
		this.paused = new Set(Array.isArray(event.paused) ? event.paused : []);
	}

	refusal(instanceIds: number[]): string | null {
		if (!this.api) return null;
		if (this.phase === "draining" || this.phase === "paused") {
			return `The cluster is ${this.phase === "paused" ? "paused" : "pausing"} because no players are online, so new transfers, imports and exports are refused. `
				+ "Join any server, or resume the cluster with clusterioctl cluster-pause resume, then retry.";
		}
		const held = [...new Set(instanceIds)].filter(id => this.paused.has(id));
		if (held.length === 0) return null;
		return `Instance ${held.join(", ")} has not confirmed it resumed from the cluster pause, so new work there is refused. `
			+ "The cluster pause plugin retries the resume; retry once it confirms.";
	}

	async track<T>(work: () => Promise<T>): Promise<T> {
		this.admissions++;
		this.changed();
		try { return await work(); }
		finally {
			this.admissions--;
			this.changed();
		}
	}

	changed(): void {
		this.api?.holdsChanged(PARTICIPANT_NAME);
	}

	onInstanceStatus(instanceId: number, status: string | undefined, loaded: boolean): void {
		const before = this.starting.has(instanceId);
		if (status === "starting" && loaded) this.starting.add(instanceId);
		else if (status !== "running") this.starting.delete(instanceId);
		if (before !== this.starting.has(instanceId)) this.changed();
	}

	onRecoveryFinished(instanceId: number): void {
		if (this.starting.delete(instanceId)) this.changed();
	}

	listHolds(): ClusterPauseHold[] {
		const holds: ClusterPauseHold[] = [];
		const listed = new Set<string>();
		for (const operation of this.source.activeTransfers.values()) {
			if (operation.status !== "queued" && !hasUnresolvedPlatformOwnership(operation)) continue;
			listed.add(operation.transferId);
			holds.push({ reason: `${operation.operationType ?? "transfer"} ${operation.status}`, ref: operation.transferId });
			for (const passenger of operation.passengers ?? []) {
				if (typeof passenger?.name === "string" && passenger.name !== "") holds.push({ reason: "passenger in transit", ref: passenger.name });
			}
		}
		for (const transferId of this.source.pendingTransfers.keys()) {
			if (!listed.has(transferId)) holds.push({ reason: "pending transfer intent", ref: transferId });
		}
		if (this.admissions > 0) holds.push({ reason: "admission request in progress", ref: String(this.admissions) });
		for (const instanceId of this.starting) {
			if (!this.source.recoveryReservations.has(instanceId)) holds.push({ reason: "instance starting up", ref: String(instanceId) });
		}
		for (const instanceId of this.source.recoveryReservations.keys()) {
			holds.push({ reason: "instance reconciling its save", ref: String(instanceId) });
		}
		for (const record of this.source.lineageRegistry?.listResolutions() ?? []) {
			if (record.status === "in_progress") holds.push({ reason: "platform resolution in progress", ref: record.requestId });
		}
		for (const error of [this.source.pendingTransfersLoadError, this.source.transactionLogLoadError, this.source.orchestrator?.requestQueue.admissionError]) {
			if (error) holds.push({ reason: "transfer state unavailable", ref: error });
		}
		return holds;
	}
}
