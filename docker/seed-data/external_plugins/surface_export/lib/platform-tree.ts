"use strict";

import type { PlatformHostNode, PlatformInfo, PlatformInstanceNode } from "../messages";
import { getErrorMessage } from "../helpers";

type InstanceLike = {
	id: number;
	status: string;
	isDeleted: boolean;
	config: { get(key: string): unknown };
};

type HostLike = {
	id: number;
	name: string;
	connected: boolean;
	isDeleted: boolean;
};

type ControllerLike = {
	instances: Map<number, InstanceLike>;
	hosts: Map<number, HostLike>;
	sendTo: (target: { instanceId: number }, message: unknown) => Promise<{ platforms?: PlatformInfo[] }>;
};

type LoggerLike = {
	info(msg: string): void;
	warn(msg: string): void;
	verbose(msg: string): void;
};

type ActiveTransferLike = {
	transferId: string;
	sourceInstanceId: number;
	platformIndex?: number;
	platformName?: string;
	status: string;
};

type PluginLike = {
	controller: ControllerLike;
	logger: LoggerLike;
	activeTransfers: Map<string, ActiveTransferLike>;
	txLogger: { normalizeTransferStatus(status: string): string };
	platformDepartureTimes: Map<string, number>;
};

/**
 * Platform tree building and instance resolution.
 * Queries connected instances for their platforms and builds
 * the hierarchical host → instance → platform tree used by the web UI.
 */
export class PlatformTree {
	private plugin: PluginLike;
	private messages: typeof import("../messages");

	constructor(plugin: PluginLike, messages: typeof import("../messages")) {
		this.plugin = plugin;
		this.messages = messages;
	}

	resolveInstanceName(instanceId: number) {
		try {
			const inst = this.plugin.controller.instances.get(instanceId);
			if (inst?.config) {
				return inst.config.get("instance.name") || null;
			}
		} catch (_err) {
			// Ignore lookup errors
		}
		return null;
	}

	resolveTargetInstance(target: unknown) {
		const logger = this.plugin.logger;
		logger.info(`[resolveTargetInstance] Looking up target=${target} (type=${typeof target})`);

		const numericTarget = Number(target);
		const direct = Number.isInteger(numericTarget) ? this.plugin.controller.instances.get(numericTarget) : undefined;
		if (direct) {
			logger.info(`[resolveTargetInstance] Direct ID match: ${numericTarget}`);
			return { id: numericTarget, instance: direct };
		}
		logger.info(`[resolveTargetInstance] No direct ID match for ${target}, searching by name/host...`);

		for (const [id, inst] of this.plugin.controller.instances) {
			const instName = inst.config && inst.config.get("instance.name");
			const assignedHost = inst.config && inst.config.get("instance.assigned_host");

			if (instName === String(target)) {
				logger.info(`[resolveTargetInstance] Name match: '${instName}' -> id=${id}`);
				return { id, instance: inst };
			}
			if (assignedHost === target) {
				logger.info(`[resolveTargetInstance] Host ID match: host=${assignedHost} -> id=${id} (name='${instName}')`);
				return { id, instance: inst };
			}
			logger.verbose(`[resolveTargetInstance]   Checked: id=${id}, name='${instName}', host=${assignedHost} - no match`);
		}

		logger.warn(`[resolveTargetInstance] FAILED: No instance found for target=${target} (checked ${this.plugin.controller.instances.size} instances)`);
		return null;
	}

	async requestInstancePlatforms(instanceId: number, forceName = "player") {
		try {
			const response = await this.plugin.controller.sendTo(
				{ instanceId },
				new this.messages.InstanceListPlatformsRequest({ forceName }),
			);
			return {
				platforms: Array.isArray(response?.platforms) ? response.platforms : [],
				error: null,
			};
		} catch (err: unknown) {
			return {
				platforms: [],
				error: getErrorMessage(err),
			};
		}
	}

	applyActiveTransferState(platforms: Array<PlatformInfo>, instanceId: number) {
		const withState: PlatformInfo[] = platforms.map(platform => ({
			...platform,
			transferId: null,
			transferStatus: "idle",
		}));

		const terminalStatuses = new Set(["completed", "failed", "cleanup_failed", "error"]);
		for (const transfer of this.plugin.activeTransfers.values()) {
			if (transfer.sourceInstanceId !== instanceId) {
				continue;
			}
			// Skip terminal transfers — their source platform no longer exists and the
			// same name may now belong to an unrelated platform on this instance.
			if (terminalStatuses.has(transfer.status)) {
				continue;
			}

			for (const platform of withState) {
				const indexMatches = transfer.platformIndex && platform.platformIndex === transfer.platformIndex;
				const nameMatches = platform.platformName === transfer.platformName;
				if (indexMatches || nameMatches) {
					platform.transferId = transfer.transferId;
					platform.transferStatus = this.plugin.txLogger.normalizeTransferStatus(transfer.status);
				}
			}
		}

		return withState;
	}

	async buildPlatformTree(forceName = "player") {
		const hostNodes = new Map<number, PlatformHostNode>();
		for (const host of this.plugin.controller.hosts.values()) {
			if (host.isDeleted) {
				continue;
			}
			const hostId = host.id;
			hostNodes.set(hostId, {
				hostId,
				hostName: host.name,
				connected: Boolean(host.connected),
				instances: [],
			});
		}

		const unassignedInstances: Array<PlatformInstanceNode> = [];
		const platformLoads: Array<Promise<void>> = [];

		for (const instance of this.plugin.controller.instances.values()) {
			if (instance.isDeleted) {
				continue;
			}

			const instanceId = instance.id;
			const rawHostId = instance.config.get("instance.assigned_host");
			const parsedHostId = Number(rawHostId);
			const hostId = Number.isInteger(parsedHostId) ? parsedHostId : null;
			const host = hostId !== null ? this.plugin.controller.hosts.get(hostId) : null;
			const node: PlatformInstanceNode = {
				instanceId,
				instanceName: String(instance.config.get("instance.name") || ""),
				hostId,
				status: String(instance.status || ""),
				connected: Boolean(host?.connected),
				platforms: [],
				platformError: null,
			};

			if (hostId !== null && hostNodes.has(hostId)) {
				const hostNode = hostNodes.get(hostId);
				if (hostNode) {
					hostNode.instances.push(node);
				}
			} else {
				unassignedInstances.push(node);
			}

			if (host?.connected) {
				platformLoads.push((async () => {
					const { platforms, error } = await this.requestInstancePlatforms(instanceId, forceName);
					node.platforms = this.applyActiveTransferState(platforms, instanceId)
						.sort((a, b) => a.platformName.localeCompare(b.platformName));
					// Annotate in-flight platforms with wall-clock departure time for browser ETA
					for (const platform of node.platforms) {
						if (platform.departureTick != null) {
							platform.departureDateMs = this.plugin.platformDepartureTimes.get(platform.platformName) ?? null;
						}
					}
					node.platformError = error;
				})());
			}
		}

		await Promise.all(platformLoads);

		for (const hostNode of hostNodes.values()) {
			hostNode.instances.sort((a, b) => a.instanceName.localeCompare(b.instanceName));
		}
		unassignedInstances.sort((a, b) => a.instanceName.localeCompare(b.instanceName));

		const hosts = Array.from(hostNodes.values())
			.sort((a, b) => a.hostName.localeCompare(b.hostName));

		return { hosts, unassignedInstances };
	}
}
