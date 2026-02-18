"use strict";

/**
 * WebSocket subscription management and live update broadcasting.
 * Manages surfaceExportSubscriptions Map and revision counters.
 * Handles tree/transfer/log update events sent to connected web UI clients.
 */
class SubscriptionManager {
	constructor(plugin, lib, messages) {
		this.plugin = plugin;
		this.messages = messages;
		this.treeBroadcastLimiter = new lib.RateLimiter({
			maxRate: 2,
			action: () => {
				this.emitTreeUpdate(this.plugin.lastTreeForceName || "player").catch(err => {
					this.plugin.logger.error(`Failed to broadcast tree update: ${err.message}`);
				});
			},
		});
	}

	queueTreeBroadcast(forceName = "player") {
		this.plugin.lastTreeForceName = forceName || this.plugin.lastTreeForceName || "player";
		this.treeBroadcastLimiter.activate();
	}

	broadcastToSubscribers(filterFn, event) {
		const staleConnections = [];
		for (const [link, subscription] of this.plugin.surfaceExportSubscriptions.entries()) {
			if (!filterFn(subscription)) {
				continue;
			}
			try {
				link.send(event);
			} catch (err) {
				staleConnections.push(link);
			}
		}

		for (const link of staleConnections) {
			this.plugin.surfaceExportSubscriptions.delete(link);
		}
	}

	async emitTreeUpdate(forceName = "player") {
		let hasTreeSubscribers = false;
		for (const subscription of this.plugin.surfaceExportSubscriptions.values()) {
			if (subscription.tree) {
				hasTreeSubscribers = true;
				break;
			}
		}
		if (!hasTreeSubscribers) {
			return;
		}

		this.plugin.lastTreeForceName = forceName || this.plugin.lastTreeForceName || "player";
		const tree = await this.plugin.platformTree.buildPlatformTree(this.plugin.lastTreeForceName);
		this.plugin.treeRevision += 1;
		const generatedAt = Date.now();
		const event = new this.messages.SurfaceExportTreeUpdateEvent({
			revision: this.plugin.treeRevision,
			generatedAt,
			forceName: this.plugin.lastTreeForceName,
			tree,
		});
		this.broadcastToSubscribers(subscription => subscription.tree, event);
	}

	emitTransferUpdate(transfer) {
		if (!transfer) {
			return;
		}
		this.plugin.transferRevision += 1;
		const transferSummary = this.plugin.txLogger.buildTransferSummary(
			transfer.transferId,
			transfer,
			this.plugin.txLogger.getLastEventTimestamp(transfer.transferId),
		);
		const event = new this.messages.SurfaceExportTransferUpdateEvent({
			revision: this.plugin.transferRevision,
			generatedAt: Date.now(),
			transfer: transferSummary,
		});
		this.broadcastToSubscribers(subscription => subscription.transfers, event);
	}

	emitLogUpdate(transferId, logEvent) {
		this.plugin.logRevision += 1;
		let transferInfo = null;
		let summary = null;
		const activeTransfer = this.plugin.activeTransfers.get(transferId);
		if (activeTransfer) {
			transferInfo = this.plugin.txLogger.buildTransferInfo(activeTransfer);
			summary = this.plugin.txLogger.buildDetailedTransferSummary(
				transferId,
				activeTransfer,
				logEvent?.timestampMs || this.plugin.txLogger.getLastEventTimestamp(transferId),
			);
		}

		if (!transferInfo || !summary) {
			const persistedLog = this.plugin.persistedTransactionLogs.find(log => log.transferId === transferId);
			if (persistedLog) {
				transferInfo = transferInfo || persistedLog.transferInfo || null;
				summary = summary || persistedLog.summary || null;
			}
		}

		const event = new this.messages.SurfaceExportLogUpdateEvent({
			revision: this.plugin.logRevision,
			generatedAt: Date.now(),
			transferId,
			event: logEvent || {},
			transferInfo: transferInfo || null,
			summary: summary || null,
		});

		this.broadcastToSubscribers(subscription => (
			subscription.logs && (!subscription.transferId || subscription.transferId === transferId)
		), event);
	}

	async handleSetSurfaceExportSubscriptionRequest(request, src) {
		const link = this.plugin.controller.wsServer.controlConnections.get(src.id);
		if (!link) {
			return;
		}

		const subscription = {
			tree: Boolean(request.tree),
			transfers: Boolean(request.transfers),
			logs: Boolean(request.logs),
			transferId: request.transferId || null,
		};
		if (subscription.logs) {
			link.user.checkPermission(this.messages.PERMISSIONS.VIEW_LOGS);
		}
		const hasAny = subscription.tree || subscription.transfers || subscription.logs;
		if (!hasAny) {
			this.plugin.surfaceExportSubscriptions.delete(link);
			return;
		}

		this.plugin.surfaceExportSubscriptions.set(link, subscription);

		if (subscription.tree) {
			const tree = await this.plugin.platformTree.buildPlatformTree(this.plugin.lastTreeForceName || "player");
			this.plugin.treeRevision += 1;
			try {
				link.send(new this.messages.SurfaceExportTreeUpdateEvent({
					revision: this.plugin.treeRevision,
					generatedAt: Date.now(),
					forceName: this.plugin.lastTreeForceName || "player",
					tree,
				}));
			} catch (err) {
				this.plugin.surfaceExportSubscriptions.delete(link);
				return;
			}
		}

		if (subscription.transfers) {
			for (const transfer of this.plugin.activeTransfers.values()) {
				this.plugin.transferRevision += 1;
				try {
					link.send(new this.messages.SurfaceExportTransferUpdateEvent({
						revision: this.plugin.transferRevision,
						generatedAt: Date.now(),
						transfer: this.plugin.txLogger.buildTransferSummary(
							transfer.transferId,
							transfer,
							this.plugin.txLogger.getLastEventTimestamp(transfer.transferId),
						),
					}));
				} catch (err) {
					this.plugin.surfaceExportSubscriptions.delete(link);
					return;
				}
			}
		}
	}
}

module.exports = SubscriptionManager;
