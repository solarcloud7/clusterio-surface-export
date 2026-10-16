import type {
	ClusterPauseHoldEntry, ClusterPausePhase, ClusterPauseReason, ClusterPauseState, ClusterPauseStatus,
} from "../shared/cluster-pause.js";

export type ClusterPauseInstanceState = "running" | "stopped" | "unknown";

export interface ClusterPauseInstance {
	id: number;
	name: string;
	loaded: boolean;
	state: ClusterPauseInstanceState;
}

export interface ClusterPauseHold {
	reason: string;
	ref?: string;
}

export interface ClusterPauseParticipant {
	listHolds(): ClusterPauseHold[];
	onPhase(event: ClusterPauseState): void;
}

export interface ClusterPauseDeps {
	enabled(): boolean;
	countdownMs(): unknown;
	instances(): ClusterPauseInstance[];
	send(instanceId: number, paused: boolean): Promise<boolean>;
	emit(event: ClusterPauseState): void;
	checkpoint(paused: number[]): Promise<void>;
	nowMs(): number;
	wallClockMs(): number;
	setTimer(callback: () => void, durationMs: number): unknown;
	clearTimer(handle: unknown): void;
	logger: { info(message: string): void; warn(message: string): void };
}

export const DEFAULT_COUNTDOWN_MS = 30_000;

type Phase = ClusterPausePhase | "pausing";
type Hold = { kind: "admin" | "failure"; reason: string };

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ClusterPause {
	private phase: Phase = "running";
	private reason: ClusterPauseReason = "controller_start";
	private sinceMs: number;
	private countdownStartedMs: number | null = null;
	private countdownTimer: unknown = null;
	private generation = 0;
	private hold: Hold | null = null;
	private lastError: string | null = null;
	private stopped = false;
	private latePausing = false;
	private lastEvent: ClusterPauseState | null = null;
	private readonly online = new Map<number, Set<string>>();
	private readonly paused = new Map<number, { sinceMs: number; confirmed: boolean }>();
	private readonly latePause = new Set<number>();
	private readonly ready = new Set<number>();
	private readonly resuming = new Set<number>();
	private readonly resumeErrors = new Map<number, string>();
	private readonly participants = new Map<string, ClusterPauseParticipant>();
	private readonly participantErrors = new Map<string, string>();

	constructor(private readonly deps: ClusterPauseDeps, restored: { paused?: unknown } | null = null) {
		this.sinceMs = deps.wallClockMs();
		const ids = Array.isArray(restored?.paused) ? restored.paused : [];
		for (const id of ids) {
			if (Number.isSafeInteger(id)) this.paused.set(id as number, { sinceMs: this.sinceMs, confirmed: false });
		}
		if (this.paused.size) deps.logger.info(`Restored ${this.paused.size} instance(s) that may still be paused from before the controller restart; they are resumed`);
	}

	get currentPhase(): ClusterPausePhase {
		return this.phase === "pausing" ? "draining" : this.phase;
	}

	start() {
		this.publish(true);
		this.retryResumes();
	}

	seed(entries: Iterable<[number, string]>) {
		for (const [instanceId, name] of entries) this.playersOn(instanceId).add(name.toLowerCase());
	}

	registerParticipant(name: string, participant: ClusterPauseParticipant) {
		if (typeof name !== "string" || name === "") throw new Error("A cluster pause participant needs a name");
		if (typeof participant?.listHolds !== "function" || typeof participant.onPhase !== "function") {
			throw new Error(`Cluster pause participant ${name} needs listHolds and onPhase`);
		}
		const current = this.state();
		this.participants.set(name, participant);
		this.deps.logger.info(`Cluster pause participant registered: ${name}`);
		this.notify(participant, name, current);
		this.evaluate("instance_state");
	}

	holdsChanged(name: string) {
		if (this.participants.has(name)) this.evaluate("holds_cleared");
	}

	onPlayerEvent(instanceId: number, type: string, name: string) {
		if (type !== "join" && type !== "leave") return;
		const player = name.toLowerCase();
		this.hold = null;
		if (type === "join") {
			this.playersOn(instanceId).add(player);
			this.resume("player_joined", `${name} joined instance ${instanceId}`);
			return;
		}
		this.online.get(instanceId)?.delete(player);
		this.evaluate("last_player_left");
	}

	onInstanceStatus(instanceId: number, status: string | undefined) {
		if (status === "stopped" || status === "unassigned" || status === "deleted") {
			this.online.delete(instanceId);
			this.ready.delete(instanceId);
			this.latePause.delete(instanceId);
		}
		if (status === "deleted") {
			this.resumeErrors.delete(instanceId);
			if (this.paused.delete(instanceId)) this.publish(false);
		}
		if (this.hold?.kind === "failure") this.hold = null;
		this.evaluate("instance_state");
	}

	onInstanceReady(instanceId: number) {
		if (this.stopped) return;
		this.ready.add(instanceId);
		if (this.deps.enabled() && this.phase === "pausing") {
			this.resume("instance_state", `instance ${instanceId} became ready while the cluster was pausing`);
			return;
		}
		if (this.deps.enabled() && this.phase === "paused") {
			this.latePause.add(instanceId);
			this.evaluate("instance_state");
			return;
		}
		this.sendResume(instanceId);
		this.evaluate("instance_state");
	}

	onConfigChanged() {
		this.hold = null;
		this.evaluate("disabled");
	}

	poll() {
		this.evaluate("holds_cleared");
		this.retryResumes();
	}

	stop() {
		this.stopped = true;
		this.clearCountdown();
	}

	control(action: "pause" | "resume"): ClusterPauseStatus {
		if (action === "resume") {
			this.resume("command", "resumed by an administrator");
			for (const instance of this.deps.instances()) {
				if (instance.loaded && instance.state === "running") this.sendResume(instance.id);
			}
			this.hold = { kind: "admin", reason: "Resumed by an administrator; the countdown starts again after the next join or leave" };
			return this.status();
		}
		if (!this.deps.enabled()) throw new Error("Cluster pause is turned off; set cluster_pause.enabled to true first");
		if (this.phase !== "running" && this.phase !== "countdown") return this.status();
		const names = [...this.onlineNames()];
		if (names.length) throw new Error(`Players are online (${names.join(", ")}); the cluster pauses only while nobody is playing`);
		const instances = this.deps.instances();
		const unknown = instances.filter(instance => instance.state === "unknown");
		if (unknown.length) throw new Error(`The state of ${unknown.map(instance => `${instance.name} (${instance.id})`).join(", ")} is unknown; the cluster stays running`);
		if (this.targets(instances).length === 0) {
			throw new Error("No running instance with cluster_pause loaded has reported ready; there is nothing to pause");
		}
		this.hold = null;
		this.startDraining("command");
		return this.status();
	}

	state(): ClusterPauseState {
		const instances = this.deps.instances();
		const nameOf = (id: number) => instances.find(instance => instance.id === id)?.name ?? String(id);
		return {
			phase: this.currentPhase,
			sinceMs: this.sinceMs,
			reason: this.reason,
			online: [...this.online].filter(([, players]) => players.size > 0)
				.map(([instanceId, players]) => ({ instanceId, name: nameOf(instanceId), players: [...players].sort() })),
			holds: this.collectHolds(),
			confirmed: this.currentPhase === "paused" ? [...this.paused].filter(([, entry]) => entry.confirmed).map(([id]) => id) : [],
			paused: [...this.paused.keys()],
		};
	}

	status(): ClusterPauseStatus {
		const instances = this.deps.instances();
		const countdownMs = this.countdownMs();
		const state = this.state();
		return {
			...state,
			enabled: this.deps.enabled() === true,
			countdownMs,
			countdownRemainingMs: this.phase === "countdown" && this.countdownStartedMs !== null
				? Math.max(0, countdownMs - (this.deps.nowMs() - this.countdownStartedMs)) : null,
			hold: this.hold?.reason ?? null,
			lastError: this.lastError,
			onlineCount: this.onlineNames().size,
			participants: [...this.participants.keys()].sort(),
			unknownInstances: instances.filter(instance => instance.state === "unknown").map(instance => ({ instanceId: instance.id, name: instance.name })),
			notLoaded: instances.filter(instance => !instance.loaded).map(instance => ({ instanceId: instance.id, name: instance.name })),
			notReady: instances.filter(instance => instance.loaded && instance.state === "running" && !this.ready.has(instance.id))
				.map(instance => ({ instanceId: instance.id, name: instance.name })),
		};
	}

	private evaluate(trigger: ClusterPauseReason) {
		if (this.stopped) return;
		if (!this.deps.enabled()) {
			if (this.phase !== "running") this.resume("disabled", "cluster pause was turned off");
			return;
		}
		const instances = this.deps.instances();
		const unknown = instances.some(instance => instance.state === "unknown");
		const occupied = this.onlineNames().size > 0;
		switch (this.phase) {
			case "running":
				if (!this.hold && !occupied && !unknown && this.targets(instances).length > 0) {
					this.startCountdown(trigger === "last_player_left" ? trigger : "instance_state");
				}
				return;
			case "countdown":
				if (occupied || unknown) this.resume(occupied ? "player_joined" : "unknown_state", occupied ? "a player is online" : "an instance state is unknown");
				else if (this.countdownStartedMs !== null && this.deps.nowMs() - this.countdownStartedMs >= this.countdownMs()) this.startDraining("countdown_elapsed");
				return;
			case "draining":
				if (occupied || unknown) this.resume(occupied ? "player_joined" : "unknown_state", occupied ? "a player is online" : "an instance state is unknown");
				else if (this.resuming.size === 0 && this.collectHolds().length === 0) void this.pauseAll(instances);
				return;
			case "pausing":
				if (occupied || unknown) this.resume(occupied ? "player_joined" : "unknown_state", occupied ? "a player is online" : "an instance state is unknown");
				return;
			case "paused":
				if (occupied) this.resume("player_joined", "a player is online");
				else if (this.latePause.size > 0 && !this.latePausing && this.collectHolds().length === 0) void this.pauseLate();
				return;
		}
	}

	private collectHolds(): ClusterPauseHoldEntry[] {
		const holds: ClusterPauseHoldEntry[] = [];
		for (const [participant, handlers] of this.participants) {
			let listed: unknown;
			try { listed = handlers.listHolds(); }
			catch (error) {
				this.participantFailed(participant, `listHolds threw: ${errorMessage(error)}`, holds);
				continue;
			}
			if (!Array.isArray(listed)) {
				this.participantFailed(participant, "listHolds returned no hold list", holds);
				continue;
			}
			if (this.participantErrors.delete(participant)) this.deps.logger.info(`Cluster pause participant ${participant} lists its holds again`);
			for (const entry of listed as Array<Partial<ClusterPauseHold> | null>) {
				const reason = typeof entry?.reason === "string" && entry.reason !== "" ? entry.reason : "unnamed hold";
				holds.push(typeof entry?.ref === "string" ? { participant, reason, ref: entry.ref } : { participant, reason });
			}
		}
		return holds;
	}

	private participantFailed(participant: string, error: string, holds: ClusterPauseHoldEntry[]) {
		holds.push({ participant, reason: "participant state unavailable", ref: error });
		if (this.participantErrors.get(participant) === error) return;
		this.participantErrors.set(participant, error);
		this.deps.logger.warn(`Cluster pause participant ${participant} counts as holding: ${error}`);
	}

	private startCountdown(reason: ClusterPauseReason) {
		const durationMs = this.countdownMs();
		this.countdownStartedMs = this.deps.nowMs();
		this.countdownTimer = this.deps.setTimer(() => {
			this.countdownTimer = null;
			this.evaluate("countdown_elapsed");
		}, durationMs);
		this.transition("countdown", reason);
	}

	private startDraining(reason: ClusterPauseReason) {
		this.clearCountdown();
		this.transition("draining", reason);
		this.evaluate("holds_cleared");
	}

	private targets(instances: ClusterPauseInstance[]): ClusterPauseInstance[] {
		return instances.filter(instance => instance.loaded && instance.state === "running" && this.ready.has(instance.id));
	}

	private async recordTargets(ids: number[], generation: number): Promise<number[] | null> {
		const added = ids.filter(id => !this.paused.has(id));
		for (const id of added) this.paused.set(id, { sinceMs: this.deps.wallClockMs(), confirmed: false });
		let error: string | null = null;
		try { await this.deps.checkpoint([...this.paused.keys()]); }
		catch (err) { error = errorMessage(err); }
		if (error === null && generation === this.generation) return added;
		for (const id of added) this.paused.delete(id);
		if (error !== null) this.fail(`The pause targets could not be recorded before pausing: ${error}`);
		else {
			this.publish(false);
			this.retryResumes();
		}
		return null;
	}

	private async pauseAll(instances: ClusterPauseInstance[]) {
		const generation = ++this.generation;
		this.phase = "pausing";
		const targets = this.targets(instances);
		if (targets.length === 0) {
			this.resume("instance_state", "no running instance with cluster_pause loaded has reported ready");
			return;
		}
		const added = await this.recordTargets(targets.map(instance => instance.id), generation);
		if (!added) return;
		const results = await Promise.all(targets.map(async instance => {
			try { return { instance, confirmed: await this.deps.send(instance.id, true) === true, error: null as string | null }; }
			catch (error) { return { instance, confirmed: false, error: errorMessage(error) }; }
		}));
		for (const result of results) {
			if (result.confirmed || result.error !== null) {
				this.paused.set(result.instance.id, { sinceMs: this.deps.wallClockMs(), confirmed: result.confirmed });
			} else if (added.includes(result.instance.id)) {
				this.paused.delete(result.instance.id);
			}
		}
		if (generation !== this.generation) {
			this.publish(false);
			this.retryResumes();
			return;
		}
		const failed = results.filter(result => !result.confirmed);
		if (failed.length === 0) {
			this.lastError = null;
			this.transition("paused", "holds_cleared");
			return;
		}
		this.fail(`Cluster pause was not confirmed by ${failed.map(result => `${result.instance.name} (${result.instance.id}): `
			+ (result.error ?? "the instance reported it is not paused")).join("; ")}`);
	}

	private async pauseLate() {
		const generation = this.generation;
		const ids = [...this.latePause];
		this.latePause.clear();
		this.latePausing = true;
		const failures: string[] = [];
		try {
			const added = await this.recordTargets(ids, generation);
			if (!added) return;
			await Promise.all(ids.map(async instanceId => {
				let confirmed = false;
				let error: string | null = null;
				try { confirmed = await this.deps.send(instanceId, true) === true; }
				catch (err) { error = errorMessage(err); }
				if (confirmed || error !== null) this.paused.set(instanceId, { sinceMs: this.deps.wallClockMs(), confirmed });
				else if (added.includes(instanceId)) this.paused.delete(instanceId);
				if (!confirmed) failures.push(`${instanceId}: ${error ?? "the instance reported it is not paused"}`);
			}));
		} finally {
			this.latePausing = false;
		}
		if (generation !== this.generation || this.phase !== "paused") {
			this.publish(false);
			this.retryResumes();
			return;
		}
		if (failures.length) this.fail(`An instance that started while the cluster was paused did not confirm the pause (${failures.join("; ")})`);
		else this.publish(false);
	}

	private fail(reason: string) {
		this.lastError = reason;
		this.deps.logger.warn(`${reason}. The cluster stays running until the next join, leave or instance change.`);
		this.resume("pause_failed", reason);
		this.hold = { kind: "failure", reason };
	}

	private resume(reason: ClusterPauseReason, detail: string) {
		const previous = this.phase;
		this.generation++;
		this.clearCountdown();
		this.latePause.clear();
		if (previous !== "running") {
			this.deps.logger.info(`Cluster ${previous === "paused" ? "resuming" : "pause cancelled"}: ${detail}`);
			this.transition("running", reason);
		}
		this.retryResumes();
	}

	private transition(phase: Phase, reason: ClusterPauseReason) {
		this.phase = phase;
		this.reason = reason;
		this.sinceMs = this.deps.wallClockMs();
		this.publish(true);
	}

	private publish(phaseChanged: boolean) {
		if (this.stopped) return;
		const event = this.state();
		if (!phaseChanged && this.lastEvent && sameIds(this.lastEvent.paused, event.paused) && sameIds(this.lastEvent.confirmed, event.confirmed)) return;
		if (!phaseChanged) event.reason = "instance_state";
		this.lastEvent = event;
		for (const [name, participant] of this.participants) this.notify(participant, name, event);
		try { this.deps.emit(event); }
		catch (error) { this.deps.logger.warn(`Cluster pause state could not be sent: ${errorMessage(error)}`); }
	}

	private notify(participant: ClusterPauseParticipant, name: string, event: ClusterPauseState) {
		try { participant.onPhase(event); }
		catch (error) { this.deps.logger.warn(`Cluster pause participant ${name} failed to handle ${event.phase}: ${errorMessage(error)}`); }
	}

	private retryResumes() {
		if (this.stopped || this.phase === "paused" || this.phase === "pausing" || this.paused.size === 0) return;
		const running = new Set(this.deps.instances().filter(instance => instance.state === "running").map(instance => instance.id));
		for (const instanceId of this.paused.keys()) {
			if (running.has(instanceId)) this.sendResume(instanceId);
		}
	}

	private sendResume(instanceId: number) {
		if (this.resuming.has(instanceId)) return;
		this.resuming.add(instanceId);
		void this.deps.send(instanceId, false).then(applied => {
			if (applied !== false) {
				this.noteResumeError(instanceId, "the instance reported it is still paused");
				return;
			}
			const known = this.paused.delete(instanceId);
			if (this.resumeErrors.delete(instanceId) || known) this.deps.logger.info(`Instance ${instanceId} confirmed it resumed from the cluster pause`);
			if (known) this.publish(false);
		}, (error: unknown) => this.noteResumeError(instanceId, errorMessage(error))).finally(() => this.resuming.delete(instanceId));
	}

	private noteResumeError(instanceId: number, error: string) {
		const added = !this.paused.has(instanceId);
		if (added) this.paused.set(instanceId, { sinceMs: this.deps.wallClockMs(), confirmed: false });
		this.lastError = `Instance ${instanceId} did not confirm it resumed: ${error}`;
		if (this.resumeErrors.get(instanceId) !== error) {
			this.deps.logger.warn(`${this.lastError}. New work there stays refused by participants and the resume is retried.`);
		}
		this.resumeErrors.set(instanceId, error);
		if (added) this.publish(false);
	}

	private clearCountdown() {
		if (this.countdownTimer !== null) this.deps.clearTimer(this.countdownTimer);
		this.countdownTimer = null;
		this.countdownStartedMs = null;
	}

	private countdownMs(): number {
		const value = Number(this.deps.countdownMs());
		return Number.isFinite(value) && value >= 0 ? value : DEFAULT_COUNTDOWN_MS;
	}

	private playersOn(instanceId: number): Set<string> {
		let players = this.online.get(instanceId);
		if (!players) {
			players = new Set();
			this.online.set(instanceId, players);
		}
		return players;
	}

	private onlineNames(): Set<string> {
		const names = new Set<string>();
		for (const players of this.online.values()) for (const player of players) names.add(player);
		return names;
	}
}

function sameIds(a: number[], b: number[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}
