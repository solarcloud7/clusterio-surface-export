/**
 * @file controller.js
 * @description Controller plugin for Surface Export - runs on central controller
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

"use strict";
const fs = require("fs/promises");
const path = require("path");
const { BaseControllerPlugin } = require("@clusterio/controller");
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

		// Track active transfers (key: transferId, value: transfer state)
		this.activeTransfers = new Map();

		// Transaction event logs (key: transferId, value: array of events)
		this.transactionLogs = new Map();
		
		// Persisted transaction logs (array of completed transfer logs)
		this.persistedTransactionLogs = [];

		// Register event handler for platform exports from instances
		this.controller.handle(messages.PlatformExportEvent, this.handlePlatformExport.bind(this));
		this.controller.handle(messages.ListExportsRequest, this.handleListExportsRequest.bind(this));
		this.controller.handle(messages.TransferPlatformRequest, this.handleTransferPlatformRequest.bind(this));
		this.controller.handle(messages.TransferValidationEvent, this.handleTransferValidation.bind(this));
		this.controller.handle(messages.GetTransactionLogRequest, this.handleGetTransactionLog.bind(this));

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
		this.logger.info(`Shutting down - ${this.platformStorage.size} platforms in storage`);
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

			// Add new log
			allLogs.push({
				transferId,
				transferInfo: {
					exportId: transfer.exportId,
					platformName: transfer.platformName,
					sourceInstanceId: transfer.sourceInstanceId,
					targetInstanceId: transfer.targetInstanceId,
					status: transfer.status,
					startedAt: transfer.startedAt,
					completedAt: transfer.completedAt,
					failedAt: transfer.failedAt,
					error: transfer.error,
				},
				events,
				savedAt: Date.now(),
			});

			// Keep only last 10 logs
			if (allLogs.length > 10) {
				allLogs = allLogs.slice(-10);
			}

			// Write back to disk
			await fs.writeFile(this.transactionLogPath, JSON.stringify(allLogs, null, 2));
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

			// Track transfer state
			const platformInfo = exportData.exportData?.platform || {};
			this.activeTransfers.set(transferId, {
				transferId,
				exportId,
				platformName: exportData.platformName,
				platformIndex: platformInfo.index || 1,
				forceName: platformInfo.force || "player",
				sourceInstanceId: exportData.instanceId,
				targetInstanceId,
				startedAt: Date.now(),
				status: "importing",
			});

			this.logTransactionEvent(transferId, 'transfer_created', 
				`Transfer created: ${exportData.platformName} (${exportData.instanceId} → ${targetInstanceId})`, {
					platformName: exportData.platformName,
					sourceInstanceId: exportData.instanceId,
					targetInstanceId,
					exportId,
					metrics: {
						storedDataSizeKB: Math.round((exportData.size || 0) / 1024 * 10) / 10,
						exportTimestamp: exportData.timestamp,
						ageMs: Date.now() - exportData.timestamp,
					},
				});

			this.logger.info(`Created transfer ${transferId}: ${exportData.platformName} (${exportData.instanceId} → ${targetInstanceId})`);

			// Debug: Log what's in exportData.exportData
			const innerData = exportData.exportData;
			this.logger.info(`[Transfer Debug] exportData.exportData keys: ${Object.keys(innerData || {}).join(', ')}`);
			this.logger.info(`[Transfer Debug] has_compressed=${!!innerData?.compressed}, has_payload=${!!innerData?.payload}, has_verification=${!!innerData?.verification}`);
			
			// Capture payload metrics
			const payloadMetrics = {
				isCompressed: !!innerData?.compressed,
				compressionType: innerData?.compression || 'none',
				payloadSizeKB: innerData?.payload ? Math.round(innerData.payload.length / 1024 * 10) / 10 : null,
				entityCount: innerData?.metadata?.total_entity_count || innerData?.verification?.entityCount || 'unknown',
				itemCount: innerData?.metadata?.total_item_count || 'unknown',
				fluidVolume: innerData?.metadata?.total_fluid_volume || 'unknown',
			};

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
				this.logTransactionEvent(transferId, 'import_failed', 
					`Import failed on target instance: ${response.error}`, {
						error: response.error,
						transmissionMs,
					});
				this.logger.error(`Failed to import on target: ${response.error}`);
				this.activeTransfers.delete(transferId);
				return { success: false, error: response.error };
			}

			// Update transfer state
			const transfer = this.activeTransfers.get(transferId);
			if (transfer) {
				transfer.status = "awaiting_validation";
				transfer.payloadMetrics = payloadMetrics;
				
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
						this.logTransactionEvent(transferId, 'validation_timeout', 
							`Validation timeout - no response received within 2 minutes`, {});
						this.logger.error(`Validation timeout for transfer ${transferId}`);
						
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
			return;
		}
		
		// Store import metrics in transfer for final summary
		if (importMetrics) {
			transfer.importMetrics = importMetrics;
		}

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
				} else {
					this.logger.error(`Failed to delete source platform: ${deleteResponse.error}`);
					transfer.status = "cleanup_failed";
					transfer.error = deleteResponse.error;

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

	async handleTransferPlatformRequest(request) {
		const instance = this.controller.instances.get(request.targetInstanceId);
		if (!instance) {
			return { success: false, error: `Unknown instance ${request.targetInstanceId}` };
		}
		return this.transferPlatform(request.exportId, request.targetInstanceId);
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
					targetInstanceId: transfer.targetInstanceId,
					status: transfer.status,
					startedAt: transfer.startedAt,
					completedAt: transfer.completedAt,
					failedAt: transfer.failedAt,
					error: transfer.error,
				} : null,
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

