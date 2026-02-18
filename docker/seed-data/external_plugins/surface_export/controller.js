/**
 * @file controller.js
 * @description Controller plugin for Surface Export - runs on central controller.
 * Delegates to focused modules in lib/ for transfer orchestration, tree building,
 * transaction logging, and subscription management.
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

"use strict";
const fs = require("fs/promises");
const path = require("path");
function requireClusterioModule(moduleName) {
	if (require.main && typeof require.main.require === "function") {
		try {
			return require.main.require(moduleName);
		} catch (err) {
			// Fallback to local resolution below.
		}
	}
	return require(moduleName);
}
const { BaseControllerPlugin } = requireClusterioModule("@clusterio/controller");
const lib = requireClusterioModule("@clusterio/lib");
const info = require("./index.js");
const messages = require("./messages");

const PlatformTree = require("./lib/platform-tree");
const TransactionLogger = require("./lib/transaction-logger");
const SubscriptionManager = require("./lib/subscription-manager");
const TransferOrchestrator = require("./lib/transfer-orchestrator");

const PLUGIN_NAME = info.plugin.name;
const STORAGE_FILENAME = "surface_export_storage.json";

class ControllerPlugin extends BaseControllerPlugin {
	async init() {
		this.logger.info("Surface Export controller plugin initializing...");

		// Shared state
		this.platformStorage = new Map();
		this.activeTransfers = new Map();
		this.transactionLogs = new Map();
		this.persistedTransactionLogs = [];
		this.surfaceExportSubscriptions = new Map();
		this.treeRevision = 0;
		this.transferRevision = 0;
		this.logRevision = 0;
		this.lastTreeForceName = "player";

		this.storagePath = path.resolve(
			this.controller.config.get("controller.database_directory"),
			STORAGE_FILENAME
		);
		this.transactionLogPath = path.resolve(
			this.controller.config.get("controller.database_directory"),
			"surface_export_transaction_logs.json"
		);

		// Instantiate modules (order matters: txLogger before subscriptions,
		// platformTree before orchestrator)
		this.platformTree = new PlatformTree(this, messages);
		this.txLogger = new TransactionLogger(this);
		this.subscriptions = new SubscriptionManager(this, lib, messages);
		this.orchestrator = new TransferOrchestrator(this, messages);

		await this.loadStorage();
		await this.txLogger.loadTransactionLogs();

		// Register message handlers
		this.controller.handle(messages.PlatformExportEvent, this.handlePlatformExport.bind(this));
		this.controller.handle(messages.ListExportsRequest, this.handleListExportsRequest.bind(this));
		this.controller.handle(messages.TransferPlatformRequest, this.orchestrator.handleTransferPlatformRequest.bind(this.orchestrator));
		this.controller.handle(messages.StartPlatformTransferRequest, this.orchestrator.handleStartPlatformTransferRequest.bind(this.orchestrator));
		this.controller.handle(messages.TransferValidationEvent, this.orchestrator.handleTransferValidation.bind(this.orchestrator));
		this.controller.handle(messages.GetPlatformTreeRequest, this.handleGetPlatformTreeRequest.bind(this));
		this.controller.handle(messages.ListTransactionLogsRequest, this.handleListTransactionLogsRequest.bind(this));
		this.controller.handle(messages.GetTransactionLogRequest, this.handleGetTransactionLog.bind(this));
		this.controller.handle(messages.SetSurfaceExportSubscriptionRequest, this.subscriptions.handleSetSurfaceExportSubscriptionRequest.bind(this.subscriptions));

		this.logger.info("Surface Export controller plugin initialized");
	}

	async onStart() {
		this.logger.info("Controller started - Surface Export plugin ready");
		this.logger.info(`Current storage: ${this.platformStorage.size} platforms`);
	}

	async onShutdown() {
		this.subscriptions.treeBroadcastLimiter.cancel();
		this.logger.info(`Shutting down - ${this.platformStorage.size} platforms in storage`);
	}

	onControlConnectionEvent(connection, event) {
		if (event === "close") {
			this.surfaceExportSubscriptions.delete(connection);
		}
	}

	async handlePlatformExport(event) {
		this.logger.info(
			`Received platform export: ${event.exportId} from instance ${event.instanceId} ` +
			`(${event.platformName})`
		);

		try {
			const serializedSize = Buffer.byteLength(JSON.stringify(event.exportData), "utf8");
			this.platformStorage.set(event.exportId, {
				exportId: event.exportId,
				platformName: event.platformName,
				instanceId: event.instanceId,
				exportData: event.exportData,
				timestamp: event.timestamp,
				size: serializedSize,
			});

			this.logger.info(`Stored platform export: ${event.exportId}`);

			const maxStorage = this.controller.config.get(`${PLUGIN_NAME}.max_storage_size`);
			if (this.platformStorage.size > maxStorage) {
				this.cleanupOldExports(maxStorage);
			}
			await this.persistStorage();
			this.subscriptions.queueTreeBroadcast("player");
		} catch (err) {
			this.logger.error(`Error handling platform export:\n${err.stack}`);
		}
	}

	cleanupOldExports(maxStorage) {
		const entries = Array.from(this.platformStorage.entries());
		entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

		const toRemove = entries.length - maxStorage;
		if (toRemove <= 0) {
			return;
		}
		for (let i = 0; i < toRemove; i++) {
			const exportId = entries[i][0];
			this.platformStorage.delete(exportId);
			this.logger.verbose(`Removed old export: ${exportId}`);
		}

		this.logger.info(`Cleaned up ${toRemove} old exports, now at ${this.platformStorage.size}`);
		this.persistStorage().catch(err => {
			this.logger.error(`Failed to persist after cleanup: ${err.message}`);
		});
		this.subscriptions.queueTreeBroadcast("player");
	}

	listStoredExports() {
		return Array.from(this.platformStorage.values()).map(data => ({
			exportId: data.exportId,
			platformName: data.platformName,
			instanceId: data.instanceId,
			timestamp: data.timestamp,
			size: data.size ?? Buffer.byteLength(JSON.stringify(data.exportData || {}), "utf8"),
		}));
	}

	async handleListExportsRequest() {
		return this.listStoredExports();
	}

	async handleGetPlatformTreeRequest(request) {
		const forceName = request.forceName || "player";
		this.lastTreeForceName = forceName;
		const tree = await this.platformTree.buildPlatformTree(forceName);
		this.treeRevision += 1;
		return {
			revision: this.treeRevision,
			generatedAt: Date.now(),
			forceName,
			hosts: tree.hosts,
			unassignedInstances: tree.unassignedInstances,
		};
	}

	async handleListTransactionLogsRequest(request) {
		return this.txLogger.getTransferSummaries(request?.limit || 50);
	}

	async handleGetTransactionLog(request) {
		const { transferId } = request;

		if (!transferId || transferId === "latest") {
			if (this.persistedTransactionLogs.length === 0) {
				return { success: false, error: "No transaction logs available" };
			}
			const latestLog = this.persistedTransactionLogs[this.persistedTransactionLogs.length - 1];
			return {
				success: true,
				transferId: latestLog.transferId,
				events: latestLog.events,
				transferInfo: latestLog.transferInfo,
				summary: latestLog.summary || null,
			};
		}

		if (this.transactionLogs.has(transferId)) {
			const events = this.transactionLogs.get(transferId);
			const transfer = this.activeTransfers.get(transferId);

			return {
				success: true,
				transferId,
				events,
				transferInfo: transfer ? this.txLogger.buildTransferInfo(transfer) : null,
				summary: transfer
					? this.txLogger.buildDetailedTransferSummary(transferId, transfer, this.txLogger.getLastEventTimestamp(transferId))
					: null,
			};
		}

		const persistedLog = this.persistedTransactionLogs.find(log => log.transferId === transferId);
		if (persistedLog) {
			return {
				success: true,
				transferId: persistedLog.transferId,
				events: persistedLog.events,
				transferInfo: persistedLog.transferInfo,
				summary: persistedLog.summary || null,
			};
		}

		return { success: false, error: `Transaction log not found for transfer: ${transferId}` };
	}

	async loadStorage() {
		try {
			const content = await fs.readFile(this.storagePath, "utf8");
			const entries = JSON.parse(content);
			if (Array.isArray(entries)) {
				for (const entry of entries) {
					if (entry && entry.exportId) {
						if (!entry.size && entry.exportData) {
							entry.size = Buffer.byteLength(JSON.stringify(entry.exportData), "utf8");
						}
						this.platformStorage.set(entry.exportId, entry);
					}
				}
			}
			this.logger.info(`Loaded ${this.platformStorage.size} stored platforms from disk`);
		} catch (err) {
			if (err.code === "ENOENT") {
				this.logger.verbose("No existing Surface Export storage found; starting fresh");
				return;
			}
			this.logger.error(`Failed to load Surface Export storage: ${err.message}`);
		}
	}

	async persistStorage() {
		try {
			const payload = JSON.stringify(Array.from(this.platformStorage.values()), null, 2);
			await fs.mkdir(path.dirname(this.storagePath), { recursive: true });
			await fs.writeFile(this.storagePath, payload, "utf8");
		} catch (err) {
			this.logger.error(`Failed to persist Surface Export storage: ${err.message}`);
		}
	}
}

module.exports = ControllerPlugin;
module.exports.ControllerPlugin = ControllerPlugin;
