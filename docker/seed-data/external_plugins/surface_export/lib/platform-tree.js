"use strict";

/**
 * Platform tree building and instance resolution.
 * Queries connected instances for their platforms and builds
 * the hierarchical host → instance → platform tree used by the web UI.
 */
class PlatformTree {
	constructor(plugin, messages) {
		this.plugin = plugin;
		this.messages = messages;
	}

	resolveInstanceName(instanceId) {
		try {
			const inst = this.plugin.controller.instances.get(instanceId);
			if (inst?.config) {
				return inst.config.get("instance.name") || null;
			}
		} catch (err) {
			// Ignore lookup errors
		}
		return null;
	}

	resolveTargetInstance(target) {
		const logger = this.plugin.logger;
		logger.info(`[resolveTargetInstance] Looking up target=${target} (type=${typeof target})`);

		const direct = this.plugin.controller.instances.get(target);
		if (direct) {
			logger.info(`[resolveTargetInstance] Direct ID match: ${target}`);
			return { id: target, instance: direct };
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

	async requestInstancePlatforms(instanceId, forceName = "player") {
		try {
			const response = await this.plugin.controller.sendTo(
				{ instanceId },
				new this.messages.InstanceListPlatformsRequest({ forceName })
			);
			return {
				platforms: Array.isArray(response?.platforms) ? response.platforms : [],
				error: null,
			};
		} catch (err) {
			return {
				platforms: [],
				error: err.message,
			};
		}
	}

	applyActiveTransferState(platforms, instanceId) {
		const withState = platforms.map(platform => ({
			...platform,
			transferId: null,
			transferStatus: "idle",
		}));

		for (const transfer of this.plugin.activeTransfers.values()) {
			if (transfer.sourceInstanceId !== instanceId) {
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
		const hostNodes = new Map();
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

		const unassignedInstances = [];
		const platformLoads = [];

		for (const instance of this.plugin.controller.instances.values()) {
			if (instance.isDeleted) {
				continue;
			}

			const instanceId = instance.id;
			const hostId = instance.config.get("instance.assigned_host");
			const host = hostId !== null && hostId !== undefined ? this.plugin.controller.hosts.get(hostId) : null;
			const node = {
				instanceId,
				instanceName: instance.config.get("instance.name"),
				hostId: hostId ?? null,
				status: instance.status,
				connected: Boolean(host?.connected),
				platforms: [],
				platformError: null,
			};

			if (hostId !== null && hostId !== undefined && hostNodes.has(hostId)) {
				hostNodes.get(hostId).instances.push(node);
			} else {
				unassignedInstances.push(node);
			}

			if (host?.connected) {
				platformLoads.push((async () => {
					const { platforms, error } = await this.requestInstancePlatforms(instanceId, forceName);
					node.platforms = this.applyActiveTransferState(platforms, instanceId)
						.sort((a, b) => a.platformName.localeCompare(b.platformName));
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

module.exports = PlatformTree;
