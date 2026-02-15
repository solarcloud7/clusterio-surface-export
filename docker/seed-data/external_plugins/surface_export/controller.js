/**
 * @file controller.js
 * @description Controller plugin for Surface Export - runs on central controller
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
const PLUGIN_NAME = info.plugin.name;
const STORAGE_FILENAME = "surface_export_storage.json";

/**
 * Controller plugin class
 * Runs on the central Clusterio controller and manages platform storage
 */
class ControllerPlugin extends BaseControllerPlugin {
	/**
	 * Initialize plugin
	 * Called when plugin is loaded
	 */
	async init() {
		this.logger.info("Surface Export controller plugin initializing...");

		// Storage for platform exports (key: exportId, value: export data)
		this.platformStorage = new Map();
		this.activeTransfers = new Map();
		this.transactionLogs = new Map();
		this.persistedTransactionLogs = [];
		this.surfaceExportSubscriptions = new Map();
		this.treeRevision = 0;
		this.transferRevision = 0;
		this.logRevision = 0;
		this.treeBroadcastLimiter = new lib.RateLimiter({
			maxRate: 2,
			action: () => {
				this.emitTreeUpdate(this.lastTreeForceName || "player").catch(err => {
					this.logger.error(`Failed to broadcast tree update: ${err.message}`);
				});
			},
		});
		this.lastTreeForceName = "player";
		this.storagePath = path.resolve(
			this.controller.config.get("controller.database_directory"),
			STORAGE_FILENAME
		);
		this.transactionLogPath = path.resolve(
			this.controller.config.get("controller.database_directory"),
			"surface_export_transaction_logs.json"
		);
		await this.loadStorage();
		await this.loadTransactionLogs();

		// Register event handler for platform exports from instances
		this.controller.handle(messages.PlatformExportEvent, this.handlePlatformExport.bind(this));
		this.controller.handle(messages.ListExportsRequest, this.handleListExportsRequest.bind(this));
		this.controller.handle(messages.TransferPlatformRequest, this.handleTransferPlatformRequest.bind(this));
		this.controller.handle(messages.StartPlatformTransferRequest, this.handleStartPlatformTransferRequest.bind(this));
		this.controller.handle(messages.TransferValidationEvent, this.handleTransferValidation.bind(this));
		this.controller.handle(messages.GetPlatformTreeRequest, this.handleGetPlatformTreeRequest.bind(this));
		this.controller.handle(messages.ListTransactionLogsRequest, this.handleListTransactionLogsRequest.bind(this));
		this.controller.handle(messages.GetTransactionLogRequest, this.handleGetTransactionLog.bind(this));
		this.controller.handle(messages.SetSurfaceExportSubscriptionRequest, this.handleSetSurfaceExportSubscriptionRequest.bind(this));

		this.logger.info("Surface Export controller plugin initialized");
	}
	
	/**
	 * Called when controller starts
	 */
	async onStart() {
		this.logger.info("Controller started - Surface Export plugin ready");
		this.logger.info(`Current storage: ${this.platformStorage.size} platforms`);
	}
	
	/**
	 * Called when controller stops
	 */
	async onShutdown() {
		this.treeBroadcastLimiter.cancel();
		this.logger.info(`Shutting down - ${this.platformStorage.size} platforms in storage`);
	}

	onControlConnectionEvent(connection, event) {
		if (event === "close") {
			this.surfaceExportSubscriptions.delete(connection);
		}
	}
	
	/**
	 * Handle platform export event from instance
	 * @param {Object} event - PlatformExportEvent
	 */
	async handlePlatformExport(event) {
		this.logger.info(
			`Received platform export: ${event.exportId} from instance ${event.instanceId} ` +
			`(${event.platformName})`
		);
		
		try {
			const serializedSize = Buffer.byteLength(JSON.stringify(event.exportData), "utf8");
			// Store platform export
			this.platformStorage.set(event.exportId, {
				exportId: event.exportId,
				platformName: event.platformName,
				instanceId: event.instanceId,
				exportData: event.exportData,
				timestamp: event.timestamp,
				size: serializedSize,
			});
			
			this.logger.info(`Stored platform export: ${event.exportId}`);
			
			// Clean up old exports if storage exceeds configured limit
			const maxStorage = this.controller.config.get(`${PLUGIN_NAME}.max_storage_size`);
			if (this.platformStorage.size > maxStorage) {
				this.cleanupOldExports(maxStorage);
			}
			await this.persistStorage();
			this.queueTreeBroadcast("player");
		} catch (err) {
			this.logger.error(`Error handling platform export:\n${err.stack}`);
		}
	}
	
	/**
	 * Clean up old platform exports to maintain storage limit
	 * @param {number} maxStorage - Maximum number of exports to keep
	 */
	cleanupOldExports(maxStorage) {
		// Sort by timestamp (oldest first)
		const entries = Array.from(this.platformStorage.entries());
		entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
		
		// Remove oldest exports until we're at the limit
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
		this.queueTreeBroadcast("player");
	}
	
	/**
	 * List all stored platform exports
	 * @returns {Array} List of export metadata
	 */
	listStoredExports() {
		return Array.from(this.platformStorage.values()).map(data => ({
			exportId: data.exportId,
			platformName: data.platformName,
			instanceId: data.instanceId,
			timestamp: data.timestamp,
			size: data.size ?? Buffer.byteLength(JSON.stringify(data.exportData || {}), "utf8"),
		}));
	}

	normalizeTransferStatus(status) {
		if (status === "importing") {
			return "transporting";
		}
		return status;
	}

	buildTransferInfo(transfer) {
		return {
			transferId: transfer.transferId,
			exportId: transfer.exportId,
			platformName: transfer.platformName,
			platformIndex: transfer.platformIndex,
			forceName: transfer.forceName,
			sourceInstanceId: transfer.sourceInstanceId,
			sourceInstanceName: transfer.sourceInstanceName || this.resolveInstanceName(transfer.sourceInstanceId),
			targetInstanceId: transfer.targetInstanceId,
			targetInstanceName: transfer.targetInstanceName || this.resolveInstanceName(transfer.targetInstanceId),
			status: this.normalizeTransferStatus(transfer.status),
			startedAt: transfer.startedAt || null,
			completedAt: transfer.completedAt || null,
			failedAt: transfer.failedAt || null,
			error: transfer.error || null,
		};
	}

	getLastEventTimestamp(transferId) {
		const events = this.transactionLogs.get(transferId);
		if (!events || !events.length) {
			return null;
		}
		return events[events.length - 1].timestampMs || null;
	}

	buildTransferSummary(transferId, transfer, lastEventAt = null) {
		const info = this.buildTransferInfo(transfer);
		return {
			transferId,
			platformName: info.platformName,
			sourceInstanceId: info.sourceInstanceId,
			sourceInstanceName: info.sourceInstanceName,
			targetInstanceId: info.targetInstanceId,
			targetInstanceName: info.targetInstanceName,
			status: info.status,
			startedAt: info.startedAt || Date.now(),
			completedAt: info.completedAt,
			failedAt: info.failedAt,
			error: info.error,
			lastEventAt,
		};
	}

	formatDuration(durationMs) {
		if (typeof durationMs !== "number" || Number.isNaN(durationMs)) {
			return null;
		}
		if (durationMs >= 1000) {
			return `${(durationMs / 1000).toFixed(1)}s`;
		}
		return `${Math.round(durationMs)}ms`;
	}

	resolveTransferResult(status) {
		if (status === "completed") {
			return "SUCCESS";
		}
		if ([ "failed", "error", "cleanup_failed" ].includes(status)) {
			return "FAILED";
		}
		return "IN_PROGRESS";
	}

	buildPhaseSummary(transfer) {
		const phaseSummary = {};
		if (!transfer?.phases) {
			return phaseSummary;
		}
		for (const [name, phase] of Object.entries(transfer.phases)) {
			if (phase?.durationMs !== undefined) {
				phaseSummary[`${name}Ms`] = phase.durationMs;
			}
		}
		return phaseSummary;
	}

	buildDetailedTransferSummary(transferId, transfer, lastEventAt = null) {
		const info = this.buildTransferInfo(transfer);
		const endAt = info.completedAt || info.failedAt || lastEventAt || Date.now();
		const durationMs = info.startedAt ? Math.max(0, endAt - info.startedAt) : null;
		const validation = transfer.validationResult || null;
		let sourceVerification = transfer.sourceVerification || null;
		if (!sourceVerification && validation) {
			sourceVerification = {
				itemCounts: validation.expectedItemCounts || {},
				fluidCounts: validation.expectedFluidCounts || {},
			};
		}

		return {
			transferId,
			result: this.resolveTransferResult(info.status),
			status: info.status,
			totalDurationMs: durationMs,
			totalDurationStr: this.formatDuration(durationMs),
			phases: this.buildPhaseSummary(transfer),
			platform: {
				name: info.platformName,
				source: {
					instanceId: info.sourceInstanceId,
					instanceName: info.sourceInstanceName,
				},
				destination: {
					instanceId: info.targetInstanceId,
					instanceName: info.targetInstanceName,
				},
			},
			payload: transfer.payloadMetrics || null,
			import: transfer.importMetrics || null,
			validation,
			sourceVerification,
			startedAt: info.startedAt,
			completedAt: info.completedAt,
			failedAt: info.failedAt,
			lastEventAt,
			error: info.error || null,
		};
	}

	getTransferSummaries(limit = 50) {
		const byId = new Map();

		for (const [transferId, transfer] of this.activeTransfers) {
			byId.set(transferId, this.buildTransferSummary(
				transferId,
				transfer,
				this.getLastEventTimestamp(transferId),
			));
		}

		for (const persistedLog of this.persistedTransactionLogs) {
			const transferInfo = persistedLog.transferInfo || {};
			const events = Array.isArray(persistedLog.events) ? persistedLog.events : [];
			const lastEvent = events.length ? events[events.length - 1] : null;
			if (!byId.has(persistedLog.transferId)) {
				byId.set(persistedLog.transferId, {
					transferId: persistedLog.transferId,
					platformName: transferInfo.platformName || "Unknown",
					sourceInstanceId: transferInfo.sourceInstanceId ?? -1,
					sourceInstanceName: transferInfo.sourceInstanceName ?? null,
					targetInstanceId: transferInfo.targetInstanceId ?? -1,
					targetInstanceName: transferInfo.targetInstanceName ?? null,
					status: this.normalizeTransferStatus(transferInfo.status || "unknown"),
					startedAt: transferInfo.startedAt || persistedLog.savedAt || Date.now(),
					completedAt: transferInfo.completedAt || null,
					failedAt: transferInfo.failedAt || null,
					error: transferInfo.error || null,
					lastEventAt: lastEvent?.timestampMs || null,
				});
			}
		}

		return Array.from(byId.values())
			.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
			.slice(0, limit);
	}

	queueTreeBroadcast(forceName = "player") {
		this.lastTreeForceName = forceName || this.lastTreeForceName || "player";
		this.treeBroadcastLimiter.activate();
	}

	async requestInstancePlatforms(instanceId, forceName = "player") {
		try {
			const response = await this.controller.sendTo(
				{ instanceId },
				new messages.InstanceListPlatformsRequest({ forceName })
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

		for (const transfer of this.activeTransfers.values()) {
			if (transfer.sourceInstanceId !== instanceId) {
				continue;
			}

			for (const platform of withState) {
				const indexMatches = transfer.platformIndex && platform.platformIndex === transfer.platformIndex;
				const nameMatches = platform.platformName === transfer.platformName;
				if (indexMatches || nameMatches) {
					platform.transferId = transfer.transferId;
					platform.transferStatus = this.normalizeTransferStatus(transfer.status);
				}
			}
		}

		return withState;
	}

	async buildPlatformTree(forceName = "player") {
		const hostNodes = new Map();
		for (const host of this.controller.hosts.values()) {
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

		for (const instance of this.controller.instances.values()) {
			if (instance.isDeleted) {
				continue;
			}

			const instanceId = instance.id;
			const hostId = instance.config.get("instance.assigned_host");
			const host = hostId !== null && hostId !== undefined ? this.controller.hosts.get(hostId) : null;
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

	broadcastToSubscribers(filterFn, event) {
		const staleConnections = [];
		for (const [link, subscription] of this.surfaceExportSubscriptions.entries()) {
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
			this.surfaceExportSubscriptions.delete(link);
		}
	}

	async emitTreeUpdate(forceName = "player") {
		let hasTreeSubscribers = false;
		for (const subscription of this.surfaceExportSubscriptions.values()) {
			if (subscription.tree) {
				hasTreeSubscribers = true;
				break;
			}
		}
		if (!hasTreeSubscribers) {
			return;
		}

		this.lastTreeForceName = forceName || this.lastTreeForceName || "player";
		const tree = await this.buildPlatformTree(this.lastTreeForceName);
		this.treeRevision += 1;
		const generatedAt = Date.now();
		const event = new messages.SurfaceExportTreeUpdateEvent({
			revision: this.treeRevision,
			generatedAt,
			forceName: this.lastTreeForceName,
			tree,
		});
		this.broadcastToSubscribers(subscription => subscription.tree, event);
	}

	emitTransferUpdate(transfer) {
		if (!transfer) {
			return;
		}
		this.transferRevision += 1;
		const transferSummary = this.buildTransferSummary(
			transfer.transferId,
			transfer,
			this.getLastEventTimestamp(transfer.transferId),
		);
		const event = new messages.SurfaceExportTransferUpdateEvent({
			revision: this.transferRevision,
			generatedAt: Date.now(),
			transfer: transferSummary,
		});
		this.broadcastToSubscribers(subscription => subscription.transfers, event);
	}

	emitLogUpdate(transferId, logEvent) {
		this.logRevision += 1;
		let transferInfo = null;
		let summary = null;
		const activeTransfer = this.activeTransfers.get(transferId);
		if (activeTransfer) {
			transferInfo = this.buildTransferInfo(activeTransfer);
			summary = this.buildDetailedTransferSummary(
				transferId,
				activeTransfer,
				logEvent?.timestampMs || this.getLastEventTimestamp(transferId),
			);
		}

		if (!transferInfo || !summary) {
			const persistedLog = this.persistedTransactionLogs.find(log => log.transferId === transferId);
			if (persistedLog) {
				transferInfo = transferInfo || persistedLog.transferInfo || null;
				summary = summary || persistedLog.summary || null;
			}
		}

		const event = new messages.SurfaceExportLogUpdateEvent({
			revision: this.logRevision,
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

	async waitForStoredExport(exportId, timeoutMs = 10000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const stored = this.platformStorage.get(exportId);
			if (stored) {
				return stored;
			}
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		throw new Error(`Timed out waiting for export ${exportId} to be stored on controller`);
	}
	
	/**
	 * Persist transaction log to disk
	 * @param {string} transferId - Transfer ID
	 */
	async persistTransactionLog(transferId) {
		try {
			const events = this.transactionLogs.get(transferId);
			const transfer = this.activeTransfers.get(transferId);
			
			if (!events || !transfer) return;

			// Load existing logs
			let allLogs = [];
			try {
				const content = await fs.readFile(this.transactionLogPath, "utf8");
				allLogs = JSON.parse(content);
			} catch (err) {
				// File doesn't exist yet, that's okay
			}

			const summary = this.buildDetailedTransferSummary(
				transferId,
				transfer,
				events.length ? events[events.length - 1].timestampMs : null,
			);

			// Add or replace log entry for this transfer
			const logEntry = {
				transferId,
				transferInfo: {
					exportId: transfer.exportId,
					platformName: transfer.platformName,
					sourceInstanceId: transfer.sourceInstanceId,
					sourceInstanceName: transfer.sourceInstanceName || this.resolveInstanceName(transfer.sourceInstanceId),
					targetInstanceId: transfer.targetInstanceId,
					targetInstanceName: transfer.targetInstanceName || this.resolveInstanceName(transfer.targetInstanceId),
					status: this.normalizeTransferStatus(transfer.status),
					startedAt: transfer.startedAt,
					completedAt: transfer.completedAt,
					failedAt: transfer.failedAt,
					error: transfer.error,
				},
				summary,
				events,
				savedAt: Date.now(),
			};
			const existingIndex = allLogs.findIndex(log => log.transferId === transferId);
			if (existingIndex === -1) {
				allLogs.push(logEntry);
			} else {
				allLogs[existingIndex] = logEntry;
			}

			// Keep only last 10 logs
			if (allLogs.length > 10) {
				allLogs = allLogs.slice(-10);
			}

			// Write back to disk
			await fs.writeFile(this.transactionLogPath, JSON.stringify(allLogs, null, 2));
			this.persistedTransactionLogs = allLogs;
			this.logger.info(`Transaction log persisted: ${transferId}`);
		} catch (err) {
			this.logger.error(`Failed to persist transaction log ${transferId}: ${err.message}`);
		}
	}
	/**
	 * Load transaction logs from disk
	 */
	async loadTransactionLogs() {
		try {
			const content = await fs.readFile(this.transactionLogPath, "utf8");
			const allLogs = JSON.parse(content);
			if (!Array.isArray(allLogs)) {
				throw new Error("Transaction log file must contain an array");
			}
			this.logger.info(`Loaded ${allLogs.length} transaction logs from disk`);
			
			// Store the complete log data for retrieval
			this.persistedTransactionLogs = allLogs;
		} catch (err) {
			if (err.code === "ENOENT") {
				this.logger.info("No transaction logs file found, starting fresh");
				this.persistedTransactionLogs = [];
			} else {
				this.logger.error(`Error loading transaction logs: ${err.message}`);
				this.persistedTransactionLogs = [];
			}
		}
	}

	/**
	 * Log a critical event for a transaction with high-precision timing
	 * @param {string} transferId - Transfer ID
	 * @param {string} eventType - Event type (e.g., 'export_started', 'validation_timeout')
	 * @param {string} message - Event message
	 * @param {Object} data - Additional event data
	 */
	logTransactionEvent(transferId, eventType, message, data = {}) {
		if (!this.transactionLogs.has(transferId)) {
			this.transactionLogs.set(transferId, []);
		}

		const now = Date.now();
		const events = this.transactionLogs.get(transferId);
		const transfer = this.activeTransfers.get(transferId);

		// Calculate elapsed time from transfer start
		const elapsedMs = transfer?.startedAt ? now - transfer.startedAt : 0;
		
		// Calculate time since last event
		const lastEvent = events.length > 0 ? events[events.length - 1] : null;
		const deltaMs = lastEvent?.timestampMs ? now - lastEvent.timestampMs : 0;

		const event = {
			timestamp: new Date(now).toISOString(),
			timestampMs: now,
			elapsedMs,
			deltaMs,
			eventType,
			message,
			...data,
		};

		events.push(event);
		this.logger.info(`[Transaction ${transferId}] +${elapsedMs}ms ${eventType}: ${message}`);
		this.emitLogUpdate(transferId, event);
	}

	/**
	 * Start a new phase for timing purposes
	 * @param {string} transferId - Transfer ID
	 * @param {string} phaseName - Phase name
	 */
	startPhase(transferId, phaseName) {
		const transfer = this.activeTransfers.get(transferId);
		if (transfer) {
			if (!transfer.phases) transfer.phases = {};
			transfer.phases[phaseName] = { startMs: Date.now() };
		}
	}

	/**
	 * End a phase and record duration
	 * @param {string} transferId - Transfer ID
	 * @param {string} phaseName - Phase name
	 * @returns {number} Duration in ms
	 */
	endPhase(transferId, phaseName) {
		const transfer = this.activeTransfers.get(transferId);
		if (transfer?.phases?.[phaseName]) {
			const phase = transfer.phases[phaseName];
			phase.endMs = Date.now();
			phase.durationMs = phase.endMs - phase.startMs;
			return phase.durationMs;
		}
		return 0;
	}

	/**
	 * Resolve an instance ID to its display name
	 * @param {number} instanceId - Instance ID
	 * @returns {string|null} Instance name or null
	 */
	resolveInstanceName(instanceId) {
		try {
			const inst = this.controller.instances.get(instanceId);
			if (inst?.config) {
				return inst.config.get("instance.name") || null;
			}
		} catch (err) {
			// Ignore lookup errors
		}
		return null;
	}

	/**
	 * Get specific platform export
	 * @param {string} exportId - Export ID
	 * @returns {Object|null} Export data or null if not found
	 */
	getStoredExport(exportId) {
		return this.platformStorage.get(exportId) || null;
	}
	
	/**
	 * Transfer platform to another instance
	 * @param {string} exportId - Export ID to transfer
	 * @param {number} targetInstanceId - Instance ID to transfer to
	 * @returns {Object} Result with success status
	 */
	async transferPlatform(exportId, targetInstanceId) {
		this.logger.info(`Transferring platform ${exportId} to instance ${targetInstanceId}`);

		try {
			// Get export data
			const exportData = this.platformStorage.get(exportId);
			if (!exportData) {
				return { success: false, error: `Export not found: ${exportId}` };
			}

			// Generate transfer ID
			const transferId = `transfer_${Date.now()}_${Math.random().toString(36).substring(7)}`;

			// Extract data from stored export for detailed metrics
			const innerData = exportData.exportData;
			this.logger.info(`[Transfer Debug] exportData.exportData keys: ${Object.keys(innerData || {}).join(', ')}`);
			
			// Compute item/fluid totals from verification data
			const verification = innerData?.verification || {};
			const itemCounts = verification.item_counts || {};
			const fluidCounts = verification.fluid_counts || {};
			const totalItemCount = Object.values(itemCounts).reduce((sum, c) => sum + c, 0);
			const totalFluidVolume = Object.values(fluidCounts).reduce((sum, c) => sum + c, 0);
			const uniqueItemTypes = Object.keys(itemCounts).length;
			const uniqueFluidTypes = Object.keys(fluidCounts).length;
			
			// Capture payload metrics with real data from stored export
			const payloadMetrics = {
				isCompressed: !!innerData?.compressed,
				compressionType: innerData?.compression || 'none',
				payloadSizeKB: innerData?.payload ? Math.round(innerData.payload.length / 1024 * 10) / 10 : null,
				entityCount: innerData?.stats?.entity_count || 0,
				tileCount: innerData?.stats?.tile_count || 0,
				uniqueItemTypes,
				totalItemCount,
				uniqueFluidTypes,
				totalFluidVolume: Math.round(totalFluidVolume * 10) / 10,
			};
			
			// Resolve instance names
			const sourceInstanceName = this.resolveInstanceName(exportData.instanceId);
			const targetInstanceName = this.resolveInstanceName(targetInstanceId);

			// Track transfer state
			const platformInfo = exportData.exportData?.platform || {};
			this.activeTransfers.set(transferId, {
				transferId,
				exportId,
				platformName: exportData.platformName,
				platformIndex: platformInfo.index || 1,
				forceName: platformInfo.force || "player",
				sourceInstanceId: exportData.instanceId,
				sourceInstanceName,
				targetInstanceId,
				targetInstanceName,
				startedAt: Date.now(),
				status: "transporting",
				payloadMetrics,
				sourceVerification: {
					itemCounts,
					fluidCounts,
				},
			});

			this.logTransactionEvent(transferId, 'transfer_created', 
				`Transfer created: ${exportData.platformName} (${sourceInstanceName || exportData.instanceId} → ${targetInstanceName || targetInstanceId})`, {
					platformName: exportData.platformName,
					sourceInstanceId: exportData.instanceId,
					sourceInstanceName,
					targetInstanceId,
					targetInstanceName,
					exportId,
					metrics: {
						storedDataSizeKB: Math.round((exportData.size || 0) / 1024 * 10) / 10,
						exportTimestamp: exportData.timestamp,
						ageMs: Date.now() - exportData.timestamp,
					},
					payloadMetrics,
					sourceVerification: {
						itemCounts: itemCounts,
						fluidCounts: fluidCounts,
					},
				});
			this.emitTransferUpdate(this.activeTransfers.get(transferId));
			this.queueTreeBroadcast(platformInfo.force || "player");

			this.logger.info(`Created transfer ${transferId}: ${exportData.platformName} (${exportData.instanceId} → ${targetInstanceId})`);

			this.logger.info(`[Transfer Debug] has_compressed=${!!innerData?.compressed}, has_payload=${!!innerData?.payload}, has_verification=${!!innerData?.verification}`);

			// Start transmission phase timing
			this.startPhase(transferId, 'transmission');

			// Send import request to target instance
			const response = await this.controller.sendTo(
				{ instanceId: targetInstanceId },
				new messages.ImportPlatformRequest({
					exportId: exportId,
					exportData: {
						...exportData.exportData,
						_transferId: transferId,  // Embed transfer ID for tracking
						_sourceInstanceId: exportData.instanceId,
					},
					forceName: "player",
				})
			);

			const transmissionMs = this.endPhase(transferId, 'transmission');

			if (!response.success) {
				const failedTransfer = this.activeTransfers.get(transferId);
				if (failedTransfer) {
					failedTransfer.status = "failed";
					failedTransfer.error = response.error || "Import failed";
					failedTransfer.failedAt = Date.now();
				}
				this.logTransactionEvent(transferId, 'import_failed', 
					`Import failed on target instance: ${response.error}`, {
						error: response.error,
						transmissionMs,
					});
				this.logger.error(`Failed to import on target: ${response.error}`);
				if (failedTransfer) {
					let rollbackError = null;
					this.logTransactionEvent(transferId, "rollback_attempt", "Unlocking source platform after import failure", {});
					try {
						const unlockResponse = await this.controller.sendTo(
							{ instanceId: failedTransfer.sourceInstanceId },
							new messages.UnlockSourcePlatformRequest({
								platformName: failedTransfer.platformName,
								forceName: failedTransfer.forceName || "player",
							})
						);
						if (unlockResponse?.success) {
							this.logTransactionEvent(transferId, "rollback_success", "Source platform unlocked after import failure", {});
						} else {
							rollbackError = unlockResponse?.error || "Unknown unlock error";
							this.logTransactionEvent(transferId, "rollback_failed", `Failed to unlock source platform: ${rollbackError}`, {
								error: rollbackError,
							});
						}
					} catch (err) {
						rollbackError = err.message;
						this.logTransactionEvent(transferId, "rollback_failed", `Failed to unlock source platform: ${rollbackError}`, {
							error: rollbackError,
						});
					}
					if (rollbackError) {
						failedTransfer.error = `${failedTransfer.error}; rollback failed: ${rollbackError}`;
					}
					this.emitTransferUpdate(failedTransfer);
					this.queueTreeBroadcast(failedTransfer.forceName || "player");
					await this.persistTransactionLog(transferId);
				}
				return { success: false, error: response.error };
			}

			// Update transfer state
			const transfer = this.activeTransfers.get(transferId);
			if (transfer) {
				transfer.status = "awaiting_validation";
				transfer.payloadMetrics = payloadMetrics;
				this.emitTransferUpdate(transfer);
				this.queueTreeBroadcast(transfer.forceName || "player");
				
				this.logTransactionEvent(transferId, 'import_started', 
					`Import initiated on instance ${targetInstanceId}, awaiting validation`, {
						targetInstanceId,
						timeoutSeconds: 120,
						transmissionMs,
						payloadMetrics,
					});

				// Start validation phase timing
				this.startPhase(transferId, 'validation');
				
				// Set validation timeout (2 minutes)
				const VALIDATION_TIMEOUT_MS = 120000;
				transfer.validationTimeout = setTimeout(async () => {
					const currentTransfer = this.activeTransfers.get(transferId);
					if (currentTransfer && currentTransfer.status === "awaiting_validation") {
						// Log full transfer state at timeout for diagnosis
						const elapsed = Date.now() - currentTransfer.startedAt;
						this.logger.error(`Validation timeout for transfer ${transferId} after ${Math.round(elapsed / 1000)}s`);
						this.logger.error(`  Transfer state: status=${currentTransfer.status}, platform=${currentTransfer.platformName}`);
						this.logger.error(`  Source: instance ${currentTransfer.sourceInstanceId}, Target: instance ${currentTransfer.targetInstanceId}`);
						this.logTransactionEvent(transferId, 'validation_timeout', 
							`Validation timeout - no response received within 2 minutes`, {
								elapsedMs: elapsed,
								transferStatus: currentTransfer.status,
								targetInstanceId: currentTransfer.targetInstanceId,
							});
						
						// Trigger rollback via synthetic validation failure
						await this.handleTransferValidation({
							transferId,
							success: false,
							platformName: currentTransfer.platformName,
							sourceInstanceId: currentTransfer.sourceInstanceId,
							validation: {
								itemCountMatch: false,
								fluidCountMatch: false,
								mismatchDetails: "Validation timeout - no response received within 2 minutes",
							},
						});
					}
				}, VALIDATION_TIMEOUT_MS);
			}

			this.logger.info(`Platform import initiated on instance ${targetInstanceId}, awaiting validation (timeout: 2min)`);

			return {
				success: true,
				transferId,
				message: `Transfer initiated: ${transferId}`,
			};

		} catch (err) {
			this.logger.error(`Error transferring platform:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}

	/**
	 * Broadcast transfer status to both source and destination instances
	 * @param {Object} transfer - Transfer state object
	 * @param {string} status - Status message
	 * @param {string} color - Message color (optional)
	 */
	async broadcastTransferStatus(transfer, status, color = null) {
		const message = `[Transfer: ${transfer.platformName}] ${status}`;

		// Send to source instance
		try {
			await this.controller.sendTo(
				{ instanceId: transfer.sourceInstanceId },
				new messages.TransferStatusUpdate({
					transferId: transfer.transferId,
					platformName: transfer.platformName,
					message: message,
					color: color,
				})
			).catch(() => {
				// Source instance might be offline, that's okay
			});
		} catch (err) {
			// Ignore broadcast errors
		}

		// Send to destination instance
		try {
			await this.controller.sendTo(
				{ instanceId: transfer.targetInstanceId },
				new messages.TransferStatusUpdate({
					transferId: transfer.transferId,
					platformName: transfer.platformName,
					message: message,
					color: color,
				})
			).catch(() => {
				// Destination instance might be offline, that's okay
			});
		} catch (err) {
			// Ignore broadcast errors
		}
	}

	/**
	 * Handle validation event from destination instance
	 * @param {Object} event - TransferValidationEvent
	 */
	async handleTransferValidation(event) {
		// End validation phase timing
		const validationMs = this.endPhase(event.transferId, 'validation');
		
		// Build import metrics summary from Lua data
		const importMetrics = event.metrics ? {
			// Convert ticks to ms (60 ticks = 1 second = 1000ms, so ticks * 16.67)
			tiles_ms: Math.round((event.metrics.tiles_ticks || 0) * 16.67),
			entities_ms: Math.round((event.metrics.entities_ticks || 0) * 16.67),
			fluids_ms: Math.round((event.metrics.fluids_ticks || 0) * 16.67),
			belts_ms: Math.round((event.metrics.belts_ticks || 0) * 16.67),
			state_ms: Math.round((event.metrics.state_ticks || 0) * 16.67),
			validation_ms: Math.round((event.metrics.validation_ticks || 0) * 16.67),
			total_ms: Math.round((event.metrics.total_ticks || 0) * 16.67),
			// Ticks for reference
			total_ticks: event.metrics.total_ticks || 0,
			// Counts
			tiles_placed: event.metrics.tiles_placed || 0,
			entities_created: event.metrics.entities_created || 0,
			entities_failed: event.metrics.entities_failed || 0,
			fluids_restored: event.metrics.fluids_restored || 0,
			belt_items_restored: event.metrics.belt_items_restored || 0,
			circuits_connected: event.metrics.circuits_connected || 0,
			total_items: event.metrics.total_items || 0,
			total_fluids: event.metrics.total_fluids || 0,
		} : null;
		
		this.logTransactionEvent(event.transferId, 'validation_received', 
			`Validation result: ${event.success ? "SUCCESS" : "FAILED"}`, {
				success: event.success,
				validation: event.validation,
				validationMs,
				importMetrics,
			});

		this.logger.info(
			`Validation result for transfer ${event.transferId}: ` +
			`${event.success ? "SUCCESS" : "FAILED"}`
		);
		
		if (importMetrics) {
			this.logger.info(`Import metrics: ${importMetrics.total_ticks} ticks (${importMetrics.total_ms}ms), ` +
				`${importMetrics.entities_created} entities, ${importMetrics.belt_items_restored} belt items, ` +
				`${importMetrics.fluids_restored} fluids`);
		}

		const transfer = this.activeTransfers.get(event.transferId);
		if (!transfer) {
			this.logger.warn(`Received validation for unknown transfer: ${event.transferId}`);
			this.logger.warn(`  Active transfers: ${Array.from(this.activeTransfers.keys()).join(", ") || "(none)"}`);
			this.logger.warn(`  Event data: success=${event.success}, platform=${event.platformName}, source=${event.sourceInstanceId}`);
			return;
		}
		
		// Store import metrics in transfer for final summary
		if (importMetrics) {
			transfer.importMetrics = importMetrics;
		}
		
		// Store validation result in transfer for summary
		transfer.validationResult = event.validation || null;

		// Clear validation timeout if set
		if (transfer.validationTimeout) {
			clearTimeout(transfer.validationTimeout);
			transfer.validationTimeout = null;
			this.logTransactionEvent(event.transferId, 'validation_timeout_cleared', 
				'Validation timeout cleared - response received in time', {});
		}

		try {
			if (event.success) {
				// Start cleanup phase
				this.startPhase(event.transferId, 'cleanup');

				// Broadcast validation success
				await this.broadcastTransferStatus(
					transfer,
					"Validation passed ✓",
					"green"
				);

				// Validation passed - delete source platform
				this.logger.info(`Validation passed, deleting source platform: ${event.platformName}`);

				await this.broadcastTransferStatus(
					transfer,
					"Deleting source platform...",
					"yellow"
				);

				const deleteResponse = await this.controller.sendTo(
					{ instanceId: event.sourceInstanceId },
					new messages.DeleteSourcePlatformRequest({
						platformIndex: transfer.platformIndex,
						platformName: event.platformName,
						forceName: transfer.forceName,
					})
				);

				const cleanupMs = this.endPhase(event.transferId, 'cleanup');

				if (deleteResponse.success) {
					this.logTransactionEvent(event.transferId, 'source_deleted', 
						'Source platform deleted successfully', { cleanupMs });
					this.logger.info(`Source platform deleted successfully`);
					transfer.status = "completed";
					transfer.completedAt = Date.now();
					this.emitTransferUpdate(transfer);
					this.queueTreeBroadcast(transfer.forceName || "player");

					// Broadcast completion
					await this.broadcastTransferStatus(
						transfer,
						"Transfer complete! Source deleted, destination validated ✓",
						"green"
					);

					// Build phase timing summary
					const phaseSummary = {};
					if (transfer.phases) {
						for (const [phaseName, phase] of Object.entries(transfer.phases)) {
							if (phase.durationMs !== undefined) {
								phaseSummary[phaseName + 'Ms'] = phase.durationMs;
							}
						}
					}

					this.logTransactionEvent(event.transferId, 'transfer_completed', 
						`Transfer completed successfully in ${Math.round((transfer.completedAt - transfer.startedAt) / 1000)}s`, {
							durationMs: transfer.completedAt - transfer.startedAt,
							phases: phaseSummary,
							payloadMetrics: transfer.payloadMetrics,
							importMetrics: transfer.importMetrics,
						});

					// Persist transaction log to disk
					await this.persistTransactionLog(event.transferId);

					// Clean up stored export
					this.platformStorage.delete(transfer.exportId);
					await this.persistStorage();
					this.queueTreeBroadcast(transfer.forceName || "player");
				} else {
					this.logger.error(`Failed to delete source platform: ${deleteResponse.error}`);
					transfer.status = "cleanup_failed";
					transfer.error = deleteResponse.error;
					this.emitTransferUpdate(transfer);
					this.queueTreeBroadcast(transfer.forceName || "player");

					await this.broadcastTransferStatus(
						transfer,
						`⚠ Cleanup failed: ${deleteResponse.error}`,
						"yellow"
					);
				}

			} else {
				// Validation failed - broadcast failure
				const errorMsg = event.validation?.mismatchDetails || "Unknown error";

				this.logTransactionEvent(event.transferId, 'validation_failed', 
					`Validation failed: ${errorMsg}`, {
						validation: event.validation,
					});

				this.logger.error(`Validation failed: ${errorMsg}`);

				await this.broadcastTransferStatus(
					transfer,
					`Validation failed ✗ - Rolling back...`,
					"red"
				);

				const unlockResponse = await this.controller.sendTo(
					{ instanceId: event.sourceInstanceId },
					new messages.UnlockSourcePlatformRequest({
						platformName: event.platformName,
						forceName: transfer.forceName,
					})
				);

				if (unlockResponse.success) {
					this.logTransactionEvent(event.transferId, 'rollback_success', 
						'Source platform unlocked for rollback', {});
					this.logger.info(`Source platform unlocked for rollback`);

					await this.broadcastTransferStatus(
						transfer,
						`Rollback complete - Source unlocked. Error: ${errorMsg}`,
						"red"
					);
				} else {
					this.logTransactionEvent(event.transferId, 'rollback_failed', 
						`Failed to unlock source platform: ${unlockResponse.error}`, {
							error: unlockResponse.error,
						});
					this.logger.error(`Failed to unlock source platform: ${unlockResponse.error}`);

					await this.broadcastTransferStatus(
						transfer,
						`⚠ Rollback failed: ${unlockResponse.error}`,
						"red"
					);
				}

				transfer.status = "failed";
				transfer.error = errorMsg;
				transfer.completedAt = Date.now();
				this.emitTransferUpdate(transfer);
				this.queueTreeBroadcast(transfer.forceName || "player");

				this.logTransactionEvent(event.transferId, 'transfer_failed', 
					`Transfer failed after ${Math.round((transfer.completedAt - transfer.startedAt) / 1000)}s`, {
						durationMs: transfer.completedAt - transfer.startedAt,
						error: errorMsg,
					});

				// Persist transaction log to disk
				await this.persistTransactionLog(event.transferId);
			}

			// Clean up old transfers (keep last 100)
			if (this.activeTransfers.size > 100) {
				const sortedTransfers = Array.from(this.activeTransfers.entries())
					.sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));

				for (let i = 100; i < sortedTransfers.length; i++) {
					this.activeTransfers.delete(sortedTransfers[i][0]);
				}
			}

		} catch (err) {
			this.logger.error(`Error handling validation:\n${err.stack}`);
			transfer.status = "error";
			transfer.error = err.message;
			this.emitTransferUpdate(transfer);
			this.queueTreeBroadcast(transfer.forceName || "player");

			await this.broadcastTransferStatus(
				transfer,
				`Error: ${err.message}`,
				"red"
			);
		}
	}

	async handleListExportsRequest() {
		return this.listStoredExports();
	}

	async handleGetPlatformTreeRequest(request) {
		const forceName = request.forceName || "player";
		this.lastTreeForceName = forceName;
		const tree = await this.buildPlatformTree(forceName);
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
		return this.getTransferSummaries(request?.limit || 50);
	}

	async handleSetSurfaceExportSubscriptionRequest(request, src) {
		const link = this.controller.wsServer.controlConnections.get(src.id);
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
			link.user.checkPermission(messages.PERMISSIONS.VIEW_LOGS);
		}
		const hasAny = subscription.tree || subscription.transfers || subscription.logs;
		if (!hasAny) {
			this.surfaceExportSubscriptions.delete(link);
			return;
		}

		this.surfaceExportSubscriptions.set(link, subscription);

		if (subscription.tree) {
			const tree = await this.buildPlatformTree(this.lastTreeForceName || "player");
			this.treeRevision += 1;
			try {
				link.send(new messages.SurfaceExportTreeUpdateEvent({
					revision: this.treeRevision,
					generatedAt: Date.now(),
					forceName: this.lastTreeForceName || "player",
					tree,
				}));
			} catch (err) {
				this.surfaceExportSubscriptions.delete(link);
				return;
			}
		}

		if (subscription.transfers) {
			for (const transfer of this.activeTransfers.values()) {
				this.transferRevision += 1;
				try {
					link.send(new messages.SurfaceExportTransferUpdateEvent({
						revision: this.transferRevision,
						generatedAt: Date.now(),
						transfer: this.buildTransferSummary(
							transfer.transferId,
							transfer,
							this.getLastEventTimestamp(transfer.transferId),
						),
					}));
				} catch (err) {
					this.surfaceExportSubscriptions.delete(link);
					return;
				}
			}
		}
	}

	async handleStartPlatformTransferRequest(request) {
		const sourceInstanceId = Number(request.sourceInstanceId);
		if (!Number.isInteger(sourceInstanceId)) {
			return { success: false, error: `Invalid source instance: ${request.sourceInstanceId}` };
		}

		const sourceInstance = this.controller.instances.get(sourceInstanceId);
		if (!sourceInstance || sourceInstance.isDeleted) {
			return { success: false, error: `Unknown source instance ${sourceInstanceId}` };
		}

		const resolvedTarget = this.resolveTargetInstance(request.targetInstanceId);
		if (!resolvedTarget) {
			return { success: false, error: `Unknown target instance ${request.targetInstanceId}` };
		}
		if (resolvedTarget.id === sourceInstanceId) {
			return { success: false, error: "Source and destination instances must be different" };
		}

		const forceName = request.forceName || "player";
		const sourcePlatformIndex = Number(request.sourcePlatformIndex);
		if (!Number.isInteger(sourcePlatformIndex) || sourcePlatformIndex < 1) {
			return { success: false, error: `Invalid platform index ${request.sourcePlatformIndex}` };
		}

		try {
			const exportResponse = await this.controller.sendTo(
				{ instanceId: sourceInstanceId },
				new messages.ExportPlatformRequest({
					platformIndex: sourcePlatformIndex,
					forceName,
				})
			);
			if (!exportResponse?.success || !exportResponse.exportId) {
				return { success: false, error: exportResponse?.error || "Export failed" };
			}

			await this.waitForStoredExport(exportResponse.exportId);
			const transferResponse = await this.transferPlatform(exportResponse.exportId, resolvedTarget.id);
			return {
				...transferResponse,
				exportId: exportResponse.exportId,
			};
		} catch (err) {
			return { success: false, error: err.message };
		}
	}

	/**
	 * Resolve a target instance identifier to a real Clusterio instance ID.
	 * Accepts: numeric instance ID, instance name, or assigned host ID.
	 * @param {number|string} target - Target identifier
	 * @returns {{ id: number, instance: Object }|null} Resolved instance or null
	 */
	resolveTargetInstance(target) {
		this.logger.info(`[resolveTargetInstance] Looking up target=${target} (type=${typeof target})`);

		// 1. Direct ID lookup
		const direct = this.controller.instances.get(target);
		if (direct) {
			this.logger.info(`[resolveTargetInstance] Direct ID match: ${target}`);
			return { id: target, instance: direct };
		}
		this.logger.info(`[resolveTargetInstance] No direct ID match for ${target}, searching by name/host...`);

		// 2. Search by name or assigned host ID
		for (const [id, inst] of this.controller.instances) {
			const instName = inst.config && inst.config.get("instance.name");
			const assignedHost = inst.config && inst.config.get("instance.assigned_host");
			
			// Match by instance name
			if (instName === String(target)) {
				this.logger.info(`[resolveTargetInstance] Name match: '${instName}' -> id=${id}`);
				return { id, instance: inst };
			}
			// Match by assigned host ID (e.g. target=2 matches host 2's instance)
			if (assignedHost === target) {
				this.logger.info(`[resolveTargetInstance] Host ID match: host=${assignedHost} -> id=${id} (name='${instName}')`);
				return { id, instance: inst };
			}
			this.logger.verbose(`[resolveTargetInstance]   Checked: id=${id}, name='${instName}', host=${assignedHost} - no match`);
		}

		this.logger.warn(`[resolveTargetInstance] FAILED: No instance found for target=${target} (checked ${this.controller.instances.size} instances)`);
		return null;
	}

	async handleTransferPlatformRequest(request) {
		this.logger.info(`TransferPlatformRequest received: exportId=${request.exportId}, targetInstanceId=${request.targetInstanceId} (type=${typeof request.targetInstanceId})`);
		const resolved = this.resolveTargetInstance(request.targetInstanceId);
		if (!resolved) {
			this.logger.error(`Failed to resolve instance: ${request.targetInstanceId}. Available instances: ${Array.from(this.controller.instances).map(([id, inst]) => `${id}(${inst.config?.get("instance.name")})`).join(", ")}`);
			return { success: false, error: `Unknown instance ${request.targetInstanceId}` };
		}
		if (resolved.id !== request.targetInstanceId) {
			this.logger.info(`Resolved target instance ${request.targetInstanceId} → ${resolved.id}`);
		}
		return this.transferPlatform(request.exportId, resolved.id);
	}

	async handleGetTransactionLog(request) {
		const { transferId } = request;
		
		// If no transferId specified, return latest
		if (!transferId || transferId === "latest") {
			if (this.persistedTransactionLogs.length === 0) {
				return { 
					success: false, 
					error: "No transaction logs available" 
				};
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
		
		// Check in-memory logs first (active transfers)
		if (this.transactionLogs.has(transferId)) {
			const events = this.transactionLogs.get(transferId);
			const transfer = this.activeTransfers.get(transferId);

			return {
				success: true,
				transferId,
				events,
				transferInfo: transfer ? {
					exportId: transfer.exportId,
					platformName: transfer.platformName,
					sourceInstanceId: transfer.sourceInstanceId,
					sourceInstanceName: transfer.sourceInstanceName || this.resolveInstanceName(transfer.sourceInstanceId),
					targetInstanceId: transfer.targetInstanceId,
					targetInstanceName: transfer.targetInstanceName || this.resolveInstanceName(transfer.targetInstanceId),
					status: this.normalizeTransferStatus(transfer.status),
					startedAt: transfer.startedAt,
					completedAt: transfer.completedAt,
					failedAt: transfer.failedAt,
					error: transfer.error,
				} : null,
				summary: transfer
					? this.buildDetailedTransferSummary(transferId, transfer, this.getLastEventTimestamp(transferId))
					: null,
			};
		}
		
		// Check persisted logs
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
		
		return { 
			success: false, 
			error: `Transaction log not found for transfer: ${transferId}` 
		};
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

