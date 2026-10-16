import type { Logger } from "@clusterio/lib";
import type { Instance, InstancePluginContext } from "@clusterio/host";
import { errorMessage } from "./lib/cluster-pause.js";
import type { ClusterPausePhase } from "./shared/cluster-pause.js";
import * as messages from "./messages.js";

const PLUGIN_NAME = "cluster_pause";

export function parseSetPausedReply(raw: unknown): boolean {
	const text = String(raw ?? "").trim();
	let reply: { success?: unknown; paused?: unknown; error?: unknown };
	try { reply = JSON.parse(text); }
	catch (error) { throw new Error(`Cluster pause returned an unreadable reply: ${text.slice(0, 200)}`, { cause: error }); }
	if (reply?.success !== true || typeof reply.paused !== "boolean") throw new Error(String(reply?.error || "Cluster pause refused"));
	return reply.paused;
}

export class InstancePlugin {
	phase: ClusterPausePhase | null = null;
	private epoch = 0;
	private started = false;

	private constructor(readonly instance: Instance, readonly logger: Logger) {}

	static async fromContext(context: InstancePluginContext): Promise<InstancePlugin> {
		const { instance, logger, plugin: info } = context;
		const plugin = new InstancePlugin(instance, logger);
		plugin.init();
		instance.hooks.start.attach(info.name, () => plugin.onStart());
		instance.hooks.exit.attach(info.name, () => plugin.onExit());
		instance.hooks.controllerConnectionEvent.attach(info.name, event => plugin.onControllerConnectionEvent(event));
		return plugin;
	}

	init() {
		this.instance.handle(messages.ClusterPauseRequest, async (request: messages.ClusterPauseRequest) => ({ paused: await this.setPaused(request.paused) }));
		this.instance.handle(messages.ClusterPauseStateEvent, async (event: messages.ClusterPauseStateEvent) => { this.phase = event.phase; });
	}

	async onStart() {
		this.started = true;
		this.announce();
	}

	async onControllerConnectionEvent(event: string) {
		if (event === "connect" && this.started) this.announce();
	}

	announce() {
		const epoch = ++this.epoch;
		void this.reportReady(epoch).catch((error: unknown) => {
			this.logger.warn(`Cluster pause readiness was not reported, so the controller neither pauses nor confirms resuming this instance: ${errorMessage(error)}`);
		});
	}

	onExit() {
		this.epoch++;
		this.started = false;
		this.phase = null;
	}

	async reportReady(epoch: number) {
		const raw = String(await this.instance.sendRcon(`/sc rcon.print(remote.interfaces["cluster_pause"] and "ready" or "missing")`, false, PLUGIN_NAME) || "");
		if (epoch !== this.epoch) return;
		if (raw.trim() !== "ready") throw new Error(`the cluster_pause remote interface is not loaded: ${raw.trim().slice(0, 200)}`);
		await this.instance.sendTo("controller", new messages.ClusterPauseInstanceReadyEvent());
	}

	async setPaused(paused: boolean): Promise<boolean> {
		const raw = await this.instance.sendRcon(
			`/sc rcon.print(helpers.table_to_json(remote.call("cluster_pause", "set_paused", ${paused === true})))`, false, PLUGIN_NAME);
		return parseSetPausedReply(raw);
	}
}

export default InstancePlugin.fromContext;
