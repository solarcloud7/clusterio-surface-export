import fs from "node:fs/promises";
import path from "node:path";
import type { Controller } from "@clusterio/controller";
import { safeOutputFile } from "@clusterio/lib";
import * as messages from "../messages";
import { getErrorMessage } from "../helpers";
import { enqueueWrite } from "./persist-queue";
import { timed } from "./timing";
import { instanceAddress } from "./platform-tree";

type GatewayLinkUpdate = {
	sourceInstanceId: number;
	gateways: Array<{ gatewayName: string; targets: messages.GatewayLink[] }>;
};

export class GatewayConfig {
	gatewayLinks = new Map<string, messages.GatewayLink[]>();
	gatewayConfigPath: string;
	gatewayConfigLoadError: string | null = null;
	private gatewayConfigUpdate?: Promise<void>;

	constructor(
		private readonly controller: Pick<Controller, "config" | "instances" | "hosts" | "sendTo">,
		private readonly logger: messages.IControllerPlugin["logger"],
		private readonly context: {
			isInstanceOnline(instanceId: number): boolean;
			resolveInstanceName(instanceId: number): string | null;
		},
	) {
		this.gatewayConfigPath = path.resolve(
			String(controller.config.get("controller.database_directory")),
			"surface_export_gateways.json",
		);
	}

	private lastGatewayModeWarning?: string;
	gatewayMode(): messages.GatewayMode {
		const { mode, warning } = messages.parseGatewayMode((this.controller.config as { get(key: string): unknown }).get("surface_export.gateway_mode"));
		if (warning && warning !== this.lastGatewayModeWarning) {
			this.lastGatewayModeWarning = warning;
			this.logger.warn(warning);
		}
		return mode;
	}

	passengerCarry(): messages.PassengerCarry {
		const config = this.controller.config as { get(key: string): unknown };
		return {
			armor: config.get("surface_export.passenger_carry_armor") !== false,
			inventory: config.get("surface_export.passenger_carry_inventory") === true,
		};
	}

	private targetAddress(instanceId: number): string {
		const inst = this.controller.instances.get(instanceId);
		if (!inst || inst.isDeleted) return "";
		const hostId = Number(inst.config.get("instance.assigned_host"));
		const host = Number.isInteger(hostId) ? this.controller.hosts.get(hostId) : null;
		return instanceAddress(host?.publicAddress, inst.gamePort ?? null);
	}

	private gatewayKey(sourceInstanceId: number, gatewayName: string): string {
		return `${sourceInstanceId}:${gatewayName}`;
	}

	private parseGatewayKey(key: string): { sourceInstanceId: number; gatewayName: string } | null {
		const idx = key.indexOf(":");
		if (idx <= 0) {
			return null;
		}
		const sourceInstanceId = Number(key.slice(0, idx));
		const gatewayName = key.slice(idx + 1);
		if (!Number.isInteger(sourceInstanceId) || !gatewayName) {
			return null;
		}
		return { sourceInstanceId, gatewayName };
	}

	async loadGatewayConfig() {
		try {
			const content = await fs.readFile(this.gatewayConfigPath, "utf8");
			const entries: unknown = JSON.parse(content);
			if (!Array.isArray(entries)) {
				throw new Error("Expected an array of gateway entries");
			}
			const loaded = new Map<string, messages.GatewayLink[]>();
			const liveInstances = [...this.controller.instances.values()].filter(inst => !inst.isDeleted);
			let migratedLegacy = 0;
			for (const entry of entries) {
				if (!(Array.isArray(entry) && entry.length === 2
					&& typeof entry[0] === "string" && Array.isArray(entry[1]))) {
					throw new Error("Invalid gateway entry");
				}
				const key = entry[0] as string;
				if (!entry[1].every(link => link && Number.isInteger(link.targetInstanceId)
					&& typeof link.targetGateway === "string" && link.targetGateway.length > 0)) {
					throw new Error(`Invalid targets for gateway '${key}'`);
				}
				const links = entry[1] as messages.GatewayLink[];
				const parsed = this.parseGatewayKey(key);
				if (parsed) {
					if (!(messages.ALL_GATEWAY_NAMES as readonly string[]).includes(parsed.gatewayName)) {
						this.logger.warn(`Dropping unknown gateway link '${key}'`);
						continue;
					}
					loaded.set(key, links);
				} else if ((messages.ALL_GATEWAY_NAMES as readonly string[]).includes(key)) {
					if (liveInstances.length === 0) {
						loaded.set(key, links);
						this.logger.warn(`Legacy gateway link '${key}' kept for migration on a later boot (no instances known yet)`);
						continue;
					}
					for (const inst of liveInstances) {
						const perInstance = links.filter(l => l.targetInstanceId !== inst.id);
						if (perInstance.length > 0) {
							loaded.set(this.gatewayKey(inst.id, key), perInstance);
						}
					}
					migratedLegacy += 1;
				} else {
					this.logger.warn(`Dropping unknown gateway link '${key}'`);
				}
			}
			this.gatewayLinks = loaded;
			this.gatewayConfigLoadError = null;
			if (migratedLegacy > 0) {
				const persistError = await this.persistGatewayConfig();
				if (persistError) {
					this.logger.warn(`Gateway migration is active in memory but could not be saved: ${persistError}`);
				} else {
					this.logger.warn(`Migrated ${migratedLegacy} legacy cluster-wide gateway link(s) to per-instance keys`);
				}
			}
			this.logger.info(`Loaded ${this.gatewayLinks.size} gateway link(s) from disk`);
		} catch (err: unknown) {
			const code = (err as { code?: string }).code;
			if (code === "ENOENT") {
				this.gatewayConfigLoadError = null;
				this.logger.verbose("No existing gateway config found; starting fresh");
				return;
			}
			this.gatewayConfigLoadError = getErrorMessage(err);
			this.logger.error(`Failed to load gateway config; writes disabled to preserve the file: ${this.gatewayConfigLoadError}`);
		}
	}

	async persistGatewayConfig(links = this.gatewayLinks): Promise<string | null> {
		try {
			if (this.gatewayConfigLoadError) {
				throw new Error(`Existing gateway config could not be loaded; repair the file and restart the controller: ${this.gatewayConfigLoadError}`);
			}
			const payload = JSON.stringify(Array.from(links.entries()), null, 2);
			await enqueueWrite(this.gatewayConfigPath, () => safeOutputFile(this.gatewayConfigPath, payload));
			return null;
		} catch (err: unknown) {
			const reason = getErrorMessage(err);
			this.logger.error(`Failed to persist gateway config: ${reason}`);
			return reason;
		}
	}

	private resolveGateways(sourceInstanceId: number): messages.ResolvedGateway[] {
		const out: messages.ResolvedGateway[] = [];
		for (const [key, links] of this.gatewayLinks.entries()) {
			const parsed = this.parseGatewayKey(key);
			if (!parsed || parsed.sourceInstanceId !== sourceInstanceId) {
				continue;
			}
			const targets = (links || []).map(link => ({
				instanceId: link.targetInstanceId,
				instanceName: this.context.resolveInstanceName(link.targetInstanceId) ?? "(unknown)",
				targetGateway: link.targetGateway,
				online: this.context.isInstanceOnline(link.targetInstanceId),
				address: this.targetAddress(link.targetInstanceId),
			}));
			out.push({ gatewayName: parsed.gatewayName, targets });
		}
		return out;
	}

	private async pushGatewayConfigToInstance(sourceInstanceId: number): Promise<string | null> {
		if (!this.context.isInstanceOnline(sourceInstanceId)) {
			return null;
		}
		try {
			const gateways = this.resolveGateways(sourceInstanceId);
			const response = await timed("Clusterio request round trip", "round-trip", () => this.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.PushGatewayConfigRequest({
					gateways,
					activeGatewayNames: messages.gatewayNamesFor(this.gatewayMode()),
					passengerCarry: this.passengerCarry(),
				}),
			)) as { success?: boolean; error?: string } | undefined;
			if (!response?.success) {
				const reason = response?.error || "the instance rejected the gateway config";
				this.logger.error(`Instance ${sourceInstanceId} did not apply the gateway config: ${reason}`);
				return reason;
			}
			return null;
		} catch (err: unknown) {
			const reason = getErrorMessage(err);
			this.logger.error(`Failed to push gateway config to instance ${sourceInstanceId}: ${reason}`);
			return reason;
		}
	}

	async pushGatewayConfigToAllSources(): Promise<Map<number, string | null>> {
		const sources = new Set<number>();
		for (const key of this.gatewayLinks.keys()) {
			const parsed = this.parseGatewayKey(key);
			if (parsed) sources.add(parsed.sourceInstanceId);
		}
		const results = new Map<number, string | null>();
		for (const sourceInstanceId of sources) {
			results.set(sourceInstanceId, await this.pushGatewayConfigToInstance(sourceInstanceId));
		}
		return results;
	}

	async handleGetGatewaysRequest(_request: Record<string, never>) {
		const activeNames = messages.gatewayNamesFor(this.gatewayMode());
		const links = Array.from(this.gatewayLinks.entries()).flatMap(([key, targets]) => {
			const parsed = this.parseGatewayKey(key);
			if (!parsed || !activeNames.includes(parsed.gatewayName)) {
				return [];
			}
			return [{ sourceInstanceId: parsed.sourceInstanceId, gatewayName: parsed.gatewayName, targets }];
		});
		return {
			gatewayMode: this.gatewayMode(),
			gatewayNames: activeNames,
			links,
		};
	}

	handleSetGatewayLinkRequest(request: GatewayLinkUpdate) {
		const previous = this.gatewayConfigUpdate ?? Promise.resolve();
		const update = previous.then(() => this.applyGatewayLinkRequest(request));
		this.gatewayConfigUpdate = update.then(() => undefined, () => undefined);
		return update;
	}

	private async applyGatewayLinkRequest(request: GatewayLinkUpdate) {
		const sourceInstanceId = Number(request.sourceInstanceId);
		const mode = this.gatewayMode();
		const activeNames = messages.gatewayNamesFor(mode);
		const submitted = request.gateways || [];
		if (!submitted.length) {
			return { success: false, error: "No gateways in the request" };
		}
		const sourceInstance = this.controller.instances.get(sourceInstanceId);
		if (!sourceInstance || sourceInstance.isDeleted) {
			return { success: false, error: `Unknown source instance: ${request.sourceInstanceId}` };
		}

		const normalized = new Map<string, messages.GatewayLink[]>();
		for (const entry of submitted) {
			const gatewayName = entry?.gatewayName;
			if (!gatewayName || !activeNames.includes(gatewayName)) {
				return { success: false, error: `Unknown gateway for ${mode} mode: ${gatewayName}` };
			}
			if (normalized.has(gatewayName)) {
				return { success: false, error: `Gateway '${gatewayName}' appears twice in one request` };
			}
			normalized.set(gatewayName, (entry.targets || [])
				.filter(t => Number.isInteger(Number(t.targetInstanceId)) && Number(t.targetInstanceId) !== sourceInstanceId)
				.map(t => ({ targetInstanceId: Number(t.targetInstanceId), targetGateway: t.targetGateway || gatewayName })));
		}

		if (mode === "multi") {
			const proposed = new Map<string, messages.GatewayLink[]>();
			for (const name of messages.MULTI_GATEWAY_NAMES) {
				const next = normalized.has(name)
					? normalized.get(name)
					: this.gatewayLinks.get(this.gatewayKey(sourceInstanceId, name));
				if (next?.length) {
					proposed.set(name, next);
				}
			}
			for (const [gatewayName, targets] of normalized) {
				const others = new Map(proposed);
				others.delete(gatewayName);
				const violation = messages.checkMultiModeLink(gatewayName, targets, others);
				if (violation) {
					return { success: false, error: violation };
				}
			}
		}

		const updated = new Map(this.gatewayLinks);
		for (const [gatewayName, targets] of normalized) {
			const key = this.gatewayKey(sourceInstanceId, gatewayName);
			if (targets.length > 0) {
				updated.set(key, targets);
			} else {
				updated.delete(key);
			}
		}
		const persistError = await this.persistGatewayConfig(updated);
		if (persistError) {
			return { success: false, error: `Gateway config could not be written to disk: ${persistError}` };
		}
		this.gatewayLinks = updated;
		const pushError = await this.pushGatewayConfigToInstance(sourceInstanceId);
		this.logger.info(
			`Instance ${sourceInstanceId} gateways set: `
			+ [...normalized].map(([name, targets]) => `${name}=${targets.length}`).join(", "),
		);
		if (pushError) {
			return {
				success: true,
				error: `Saved, but instance ${sourceInstanceId} is still running the previous gateway config: ${pushError}`,
			};
		}
		return { success: true };
	}

	async handleGetGatewayConfigRequest(request: { instanceId: number }) {
		return {
			gateways: this.resolveGateways(Number(request.instanceId)),
			activeGatewayNames: messages.gatewayNamesFor(this.gatewayMode()),
			passengerCarry: this.passengerCarry(),
		};
	}
}
