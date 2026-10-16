import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Controller, ControllerPluginContext, InstanceRecord } from "@clusterio/controller";
import type * as lib from "@clusterio/lib";
import { ClusterPause, errorMessage, type ClusterPauseInstance, type ClusterPauseParticipant } from "./lib/cluster-pause.js";
import type { ClusterPausePersisted, ClusterPauseState, ClusterPauseStatus } from "./shared/cluster-pause.js";
import * as messages from "./messages.js";

const PLUGIN_NAME = "cluster_pause";
export const STATE_FILENAME = "cluster_pause.json";
export const CLUSTER_PAUSE_RENDEZVOUS = Symbol.for("cluster_pause.rendezvous");
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_HOLD_CHECK_INTERVAL_MS = 5_000;
const MIN_HOLD_CHECK_INTERVAL_MS = 250;
const CONFIG_FIELDS = new Set([`${PLUGIN_NAME}.enabled`, `${PLUGIN_NAME}.countdown_ms`, `${PLUGIN_NAME}.hold_check_interval_ms`]);

export interface ClusterPauseApi {
	registerParticipant(name: string, participant: ClusterPauseParticipant): void;
	holdsChanged(name: string): void;
	status(): ClusterPauseStatus;
}

interface Rendezvous {
	api?: ClusterPauseApi;
	waiting: Array<(api: ClusterPauseApi) => void>;
}

export function publishApi(host: object, api: ClusterPauseApi, logger: { warn(message: string): void }): void {
	const target = host as { [CLUSTER_PAUSE_RENDEZVOUS]?: Rendezvous };
	const rendezvous = target[CLUSTER_PAUSE_RENDEZVOUS] ?? (target[CLUSTER_PAUSE_RENDEZVOUS] = { waiting: [] });
	rendezvous.api = api;
	for (const ready of rendezvous.waiting.splice(0)) {
		try { ready(api); }
		catch (error) { logger.warn(`A cluster pause participant failed to register: ${errorMessage(error)}`); }
	}
}

export async function loadPersistedState(file: string, logger: { warn(message: string): void }): Promise<{ paused: unknown } | null | "unreadable"> {
	let saved: Partial<ClusterPausePersisted>;
	try { saved = JSON.parse(await fs.readFile(file, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		logger.warn(`Cluster pause state ${file} is unreadable; every instance is treated as possibly paused: ${errorMessage(error)}`);
		return "unreadable";
	}
	if (saved?.version !== 1 || !Array.isArray(saved.paused)) {
		logger.warn(`Cluster pause state ${file} is not a version 1 record; every instance is treated as possibly paused`);
		return "unreadable";
	}
	return { paused: saved.paused };
}

export class ControllerPlugin {
	private static readonly instances = new WeakMap<Controller, ControllerPlugin>();
	machine!: ClusterPause;
	readonly api: ClusterPauseApi;
	private pollTimer?: ReturnType<typeof setInterval>;
	private statePath!: string;
	private writing: Promise<void> = Promise.resolve();

	private constructor(readonly controller: Controller, readonly logger: lib.Logger) {
		this.api = {
			registerParticipant: (name, participant) => this.machine.registerParticipant(name, participant),
			holdsChanged: name => this.machine.holdsChanged(name),
			status: () => this.machine.status(),
		};
	}

	static async fromContext(context: ControllerPluginContext): Promise<ControllerPlugin> {
		const { controller, logger, plugin: info } = context;
		const plugin = new ControllerPlugin(controller, logger);
		await plugin.init();
		controller.hooks.shutdown.attach(info.name, () => plugin.onShutdown());
		controller.hooks.playerEvent.attach(info.name, (instance, event) => plugin.onPlayerEvent(instance, event));
		controller.hooks.instanceStatusChanged.attach(info.name, instance => plugin.onInstanceStatusChanged(instance));
		controller.hooks.controllerConfigFieldChanged.attach(info.name, field => plugin.onControllerConfigFieldChanged(field));
		ControllerPlugin.instances.set(controller, plugin);
		publishApi(controller, plugin.api, logger);
		return plugin;
	}

	static get(controller: Controller): ControllerPlugin | undefined {
		return ControllerPlugin.instances.get(controller);
	}

	private get c(): Controller { return this.controller; }
	private cfg(key: string): unknown {
		return (this.controller.config as { get(k: string): unknown }).get(key);
	}

	async init() {
		this.statePath = path.resolve(String(this.c.config.get("controller.database_directory")), STATE_FILENAME);
		const loaded = await loadPersistedState(this.statePath, this.logger);
		const restored = loaded === "unreadable"
			? { paused: this.instances().filter(instance => instance.loaded).map(instance => instance.id) }
			: loaded;
		this.machine = new ClusterPause({
			enabled: () => this.cfg(`${PLUGIN_NAME}.enabled`) === true,
			countdownMs: () => this.cfg(`${PLUGIN_NAME}.countdown_ms`),
			instances: () => this.instances(),
			send: (instanceId, paused) => this.send(instanceId, paused),
			emit: event => this.emit(event),
			nowMs: () => performance.now(),
			wallClockMs: () => Date.now(),
			setTimer: (callback, durationMs) => setTimeout(callback, durationMs).unref(),
			clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
			logger: this.logger,
		}, restored);
		const online: Array<[number, string]> = [];
		for (const user of this.c.users.values()) {
			for (const instanceId of user.instances) online.push([instanceId, user.name]);
		}
		this.machine.seed(online);
		this.c.subscriptions.handle(messages.ClusterPauseStateEvent, async () => new messages.ClusterPauseStateEvent(this.machine.state()));
		this.c.handle(messages.ClusterPauseStatusRequest, async () => this.machine.status());
		this.c.handle(messages.ClusterPauseControlRequest, async (request: messages.ClusterPauseControlRequest) => this.machine.control(request.action));
		this.c.handle(messages.ClusterPauseInstanceReadyEvent, async (_event: messages.ClusterPauseInstanceReadyEvent, src: { id: number }) => {
			this.machine.onInstanceReady(src.id);
		});
		this.machine.start();
		this.startPoll();
	}

	instances(): ClusterPauseInstance[] {
		return [...this.c.instances.values()].filter(instance => !instance.isDeleted).map(instance => {
			const status = String(instance.status);
			const hostId = Number(instance.config.get("instance.assigned_host"));
			const host = Number.isInteger(hostId) ? this.c.hosts.get(hostId) : undefined;
			return {
				id: instance.id,
				name: String(instance.config.get("instance.name") ?? instance.id),
				loaded: instance.config.get("cluster_pause.load_plugin") !== false,
				state: status === "running" && host?.connected ? "running" : status === "stopped" || status === "unassigned" ? "stopped" : "unknown",
			};
		});
	}

	async send(instanceId: number, paused: boolean): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const reply = await Promise.race([
				this.c.sendTo({ instanceId }, new messages.ClusterPauseRequest({ paused })),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Cluster pause request timed out")), REQUEST_TIMEOUT_MS);
				}),
			]) as { paused?: unknown } | undefined;
			if (typeof reply?.paused !== "boolean") throw new Error("Cluster pause reply carried no applied value");
			return reply.paused;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	emit(event: ClusterPauseState) {
		this.logger.info(`Cluster pause ${event.phase} (${event.reason}): ${JSON.stringify({ sinceMs: event.sinceMs, online: event.online,
			holds: event.holds, confirmed: event.confirmed, paused: event.paused })}`);
		const message = new messages.ClusterPauseStateEvent(event);
		this.c.subscriptions.broadcast(message);
		this.c.sendTo("allInstances", message);
		this.persist(event);
	}

	persist(event: ClusterPauseState) {
		const record: ClusterPausePersisted = { version: 1, phase: event.phase, sinceMs: event.sinceMs, paused: event.paused };
		const file = this.statePath;
		this.writing = this.writing.then(async () => {
			const temporary = `${file}.tmp`;
			await fs.writeFile(temporary, JSON.stringify(record));
			await fs.rename(temporary, file);
		}).catch((error: unknown) => {
			this.logger.warn(`Cluster pause state could not be saved: ${errorMessage(error)}`);
		});
	}

	holdCheckIntervalMs(): number {
		const value = Number(this.cfg(`${PLUGIN_NAME}.hold_check_interval_ms`));
		return Number.isFinite(value) && value >= MIN_HOLD_CHECK_INTERVAL_MS ? value : DEFAULT_HOLD_CHECK_INTERVAL_MS;
	}

	startPoll() {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = setInterval(() => {
			try { this.machine.poll(); }
			catch (error) { this.logger.error(`Cluster pause check failed: ${errorMessage(error)}`); }
		}, this.holdCheckIntervalMs());
		this.pollTimer.unref();
	}

	async onPlayerEvent(instance: InstanceRecord | undefined, event: lib.PlayerEvent) {
		if (instance) this.machine.onPlayerEvent(instance.id, event.type, event.name);
	}

	async onInstanceStatusChanged(instance: { id: number; status?: string } | undefined) {
		if (instance) this.machine.onInstanceStatus(instance.id, instance.status);
	}

	async onControllerConfigFieldChanged(field: string) {
		if (!CONFIG_FIELDS.has(field)) return;
		if (field === `${PLUGIN_NAME}.hold_check_interval_ms`) this.startPoll();
		this.machine.onConfigChanged();
	}

	async onShutdown() {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.machine.stop();
		await this.writing;
	}
}

export default ControllerPlugin.fromContext;
