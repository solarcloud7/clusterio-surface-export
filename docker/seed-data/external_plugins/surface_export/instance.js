/**
 * @file instance.js
 * @description Instance plugin for Surface Export - runs on each Factorio host
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

"use strict";
const fs = require("fs").promises;
const path = require("path");
const lib = require("@clusterio/lib");
const { BaseInstancePlugin } = require("@clusterio/host");
const info = require("./index.js");
const messages = require("./messages");
const { sendChunkedJson, sendAdaptiveJson } = require("./helpers");

/**
 * Instance plugin class
 * Runs on each Clusterio host and handles communication with Factorio servers
 */
class InstancePlugin extends BaseInstancePlugin {
	/**
	 * Initialize plugin
	 * Called when plugin is loaded
	 */
	async init() {		
		this.logger.info("🔥 Surface Export Plugin Initialized - HOT RELOAD TEST");		this.logger.info("Surface Export plugin initializing...");
		this.validateInstanceConfiguration();
		
		// Listen for platform export completion from Factorio mod
		// The mod sends data via clusterio_api.send_json("surface_export_complete", data)
		this.instance.server.handle("surface_export_complete", this.handleExportComplete.bind(this));
		
		// Listen for import file requests from mod
		// The mod sends data via clusterio_api.send_json("surface_import_file_request", data)
		this.instance.server.handle("surface_import_file_request", this.handleImportFileRequest.bind(this));

		// Listen for import completion with validation from mod
		this.instance.server.handle("surface_export_import_complete", this.handleImportCompleteValidation.bind(this));

		// Listen for transfer requests from mod
		this.instance.server.handle("surface_transfer_request", this.handleTransferRequest.bind(this));

		// Register message handlers
		this.instance.handle(messages.ExportPlatformRequest, this.handleExportPlatformRequest.bind(this));
		this.instance.handle(messages.ImportPlatformRequest, this.handleImportPlatformRequest.bind(this));
		this.instance.handle(messages.ImportPlatformFromFileRequest, this.handleImportPlatformFromFileRequest.bind(this));
		this.instance.handle(messages.DeleteSourcePlatformRequest, this.handleDeleteSourcePlatform.bind(this));
		this.instance.handle(messages.UnlockSourcePlatformRequest, this.handleUnlockSourcePlatform.bind(this));
		this.instance.handle(messages.TransferStatusUpdate, this.handleTransferStatusUpdate.bind(this));
		
		this.logger.info("Surface Export plugin initialized");
	}
	
	/**
	 * Called when instance starts
	 */
	async onStart() {
		this.logger.info("Instance started - Surface Export plugin ready");
		await this.ensureLuaConsoleUnlocked();
		await this.sendConfigurationToLua();
	}
	
	/**
	 * Send plugin configuration to Lua
	 */
	async sendConfigurationToLua() {
		try {
			const batchSize = this.instance.config.get("surface_export.batch_size");
			const maxConcurrentJobs = this.instance.config.get("surface_export.max_concurrent_jobs");
			const showProgress = this.instance.config.get("surface_export.show_progress");
			const debugMode = this.instance.config.get("surface_export.debug_mode");
			const pauseOnValidation = this.instance.config.get("surface_export.pause_on_validation");
			
			const configScript = `/sc ` +
				`if remote.interfaces["surface_export"] and remote.interfaces["surface_export"]["configure"] then ` +
				`remote.call("surface_export", "configure", {` +
				`batch_size=${batchSize}, ` +
				`max_concurrent_jobs=${maxConcurrentJobs}, ` +
				`show_progress=${showProgress}, ` +
				`debug_mode=${debugMode}, ` +
				`pause_on_validation=${pauseOnValidation}` +
				`}) ` +
				`end`;
			
			await this.instance.sendRcon(configScript, true);
			this.logger.info(`Configuration sent to Lua: batch_size=${batchSize}, max_concurrent_jobs=${maxConcurrentJobs}, show_progress=${showProgress}, debug_mode=${debugMode}, pause_on_validation=${pauseOnValidation}`);
		} catch (err) {
			this.logger.warn(`Failed to send configuration to Lua: ${err.message}`);
		}
	}
	
	/**
	 * Called when instance stops
	 */
	async onStop() {
		this.logger.info("Instance stopped - Surface Export plugin shutting down");
	}
	
	/**
	 * Handle export completion event from Factorio mod
	 * @param {Object} data - Export data from mod
	 */
	async handleExportComplete(data) {
		this.logger.info(`🔥 handleExportComplete CALLED with data: ${JSON.stringify(data)}`);
		this.logger.info(`Platform export completed: ${data.export_id} (${data.platform_name})`);

		try {
			// Retrieve full export data from mod
			const exportData = await this.getExportData(data.export_id);

			if (!exportData) {
				this.logger.error(`Failed to retrieve export data for ${data.export_id}`);
				return;
			}

			// Send export to controller for storage
			await this.instance.sendTo("controller", new messages.PlatformExportEvent({
				exportId: data.export_id,
				platformName: data.platform_name,
				instanceId: this.instance.id,
				exportData: exportData,
				timestamp: Date.now(),
			}));

			this.logger.info(`Sent platform export ${data.export_id} to controller`);

			// Check if auto-transfer was requested (destination_instance_id in IPC data)
			if (data.destination_instance_id) {
				this.logger.info(`Auto-transfer requested: transferring to instance ${data.destination_instance_id}`);
				
				// Send transfer request to controller
				const transferResponse = await this.instance.sendTo("controller",
					new messages.TransferPlatformRequest({
						exportId: data.export_id,
						targetInstanceId: data.destination_instance_id,
					})
				);

				if (transferResponse.success) {
					this.logger.info(`Transfer initiated: ${transferResponse.transferId}`);
				} else {
					this.logger.error(`Transfer failed: ${transferResponse.error}`);
				}
				return;
			}

			// Check if this was part of a pending transfer request (legacy path)
			if (this.pendingTransfer && this.pendingTransfer.job_id === data.job_id) {
				this.logger.info(`Transfer export complete, initiating transfer to instance ${this.pendingTransfer.destination_instance_id}`);

				// Send transfer request to controller
				const transferResponse = await this.instance.sendTo("controller",
					new messages.TransferPlatformRequest({
						exportId: data.export_id,
						targetInstanceId: this.pendingTransfer.destination_instance_id,
					})
				);

				if (transferResponse.success) {
					this.logger.info(`Transfer initiated: ${transferResponse.transferId}`);
				} else {
					this.logger.error(`Transfer failed: ${transferResponse.error}`);

					// Unlock platform on failure
					await this.sendRcon(
						`/sc local SurfaceLock = require("modules/surface_export/utils/surface-lock"); ` +
						`SurfaceLock.unlock_platform("${data.platform_name}")`
					);
				}

				// Clear pending transfer
				this.pendingTransfer = null;
			}
		} catch (err) {
			this.logger.error(`Error handling export completion:\n${err.stack}`);
		}
	}

	/**
	 * Handle transfer request from Lua command
	 * @param {Object} data - Transfer request data
	 */
	async handleTransferRequest(data) {
		this.logger.info(`Transfer request: Platform ${data.platform_name} to instance ${data.destination_instance_id}`);

		try {
			// Store transfer request for when export completes
			this.pendingTransfer = {
				platform_index: data.platform_index,
				platform_name: data.platform_name,
				force_name: data.force_name,
				destination_instance_id: data.destination_instance_id,
				job_id: data.job_id,
			};

			this.logger.info(`Transfer queued: will execute after export ${data.job_id} completes`);

		} catch (err) {
			this.logger.error(`Error handling transfer request:\n${err.stack}`);
		}
	}
	
	/**
	 * Handle import file request from Factorio mod
	 * @param {Object} data - Import request data with filename, platform_name, force_name
	 */
	async handleImportFileRequest(data) {
		this.logger.info(`Received import file request: ${data.filename}`);
		
		try {
			const result = await this.importPlatformFromFile(
				data.filename,
				data.platform_name,
				data.force_name || "player"
			);
			
			if (result.success) {
				this.logger.info(`Import request completed successfully`);
			} else {
				this.logger.error(`Import request failed: ${result.error}`);
			}
		} catch (err) {
			this.logger.error(`Error handling import file request:\n${err.stack}`);
		}
	}
	
	/**
	 * Export a platform by platform index
	 * @param {number} platformIndex - Index of platform to export
	 * @param {string} forceName - Force name (default: "player")
	 * @returns {Object} Result with success status and exportId
	 */
	async exportPlatform(platformIndex, forceName = "player") {
		this.logger.info(`Exporting platform index ${platformIndex} for force "${forceName}"`);
		
		try {
			// Call mod's remote interface to export platform - this returns the export_id
			const rconResult = await this.sendRcon(
				`/sc local data, export_id = remote.call("surface_export", "export_platform", ${platformIndex}, "${forceName.replace(/"/g, '\\"')}"); rcon.print(export_id or "EXPORT_FAILED")`
			);
			this.logger.info(`Export RCON result: ${rconResult}`);
			
			if (!rconResult || rconResult === "EXPORT_FAILED" || rconResult === "nil") {
				return { success: false, error: "Export failed - no export_id returned" };
			}
			
			const exportId = rconResult.trim();
			this.logger.info(`Export completed with ID: ${exportId}`);
			
			// Retrieve full export data from mod storage
			const exportData = await this.getExportData(exportId);
			if (!exportData) {
				return { success: false, error: `Failed to retrieve export data for ${exportId}` };
			}
			
			// Parse platform name from export_id (format: platformName_tick)
			const platformName = exportId.replace(/_\d+$/, "");
			
			// Send export to controller for storage
			await this.instance.sendTo("controller", new messages.PlatformExportEvent({
				exportId: exportId,
				platformName: platformName,
				instanceId: this.instance.id,
				exportData: exportData,
				timestamp: Date.now(),
			}));
			
			this.logger.info(`Sent platform export ${exportId} to controller for storage`);
			
			return { success: true, exportId: exportId };
		} catch (err) {
			this.logger.error(`Export failed:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}
	
	/**
	 * Get export data from mod
	 * @param {string} exportId - Export ID
	 * @returns {Object|null} Export data (may be compressed format with {compressed, payload, ...}) or null if not found
	 */
	async getExportData(exportId) {
		try {
			// Call the _json version which pre-encodes the result in Lua
			const result = await this.sendRcon(
`/sc rcon.print(remote.call("surface_export", "get_export_json", "${exportId}"))`
			);
			
			if (result === "null") {
				return null;
			}
			
			const exportData = JSON.parse(result);
			
			// Log compression info if data is compressed
			if (exportData.compressed && exportData.payload) {
				const compressedSize = (exportData.payload.length / 1024).toFixed(1);
				this.logger.info(`Retrieved compressed export: ${compressedSize} KB (${exportData.compression})`);
			} else {
				const jsonSize = (JSON.stringify(exportData).length / 1024).toFixed(1);
				this.logger.info(`Retrieved uncompressed export: ${jsonSize} KB`);
			}
			
			return exportData;
		} catch (err) {
			this.logger.error(`Get export data failed:\n${err.stack}`);
			return null;
		}
	}
	
	/**
	 * List all platform exports stored in mod
	 * @returns {Array} List of export IDs
	 */
	async listExports() {
		try {
			const result = await this.sendRcon(
				'/sc rcon.print(remote.call("surface_export", "list_exports_json"))'
			);
			
			return JSON.parse(result);
		} catch (err) {
			this.logger.error(`List exports failed:\n${err.stack}`);
			return [];
		}
	}
	
	/**
	 * Import a platform from export data using chunked RCON (like inventory_sync)
	 * @param {Object} exportData - Platform export data (may be compressed format)
	 * @param {string} forceName - Force to import to (default: "player")
	 * @returns {Object} Result with success status
	 */
	async importPlatform(exportData, forceName = "player") {
		const platformName = exportData.platform_name || `Imported_${Date.now()}`;
		this.logger.info(`Importing platform "${platformName}" for force "${forceName}"`);
		
		try {
			// Keep data in its current format (compressed or uncompressed)
			// Lua side will handle decompression in queue_import
			const jsonData = JSON.stringify(exportData);
			const sizeKB = (jsonData.length / 1024).toFixed(1);
			
			if (exportData.compressed) {
				this.logger.info(`Import data size: ${sizeKB} KB (compressed with ${exportData.compression})`);
			} else {
				this.logger.info(`Import data size: ${sizeKB} KB (uncompressed)`);
			}
			
			// Use chunked approach like inventory_sync
			const chunkSize = 100000;  // 100KB chunks
			const chunks = [];
			for (let i = 0; i < jsonData.length; i += chunkSize) {
				chunks.push(jsonData.slice(i, i + chunkSize));
			}
			
			this.logger.info(`Sending import in ${chunks.length} chunks`);
			
			// Send chunks using import_platform_chunk remote interface
			for (let i = 0; i < chunks.length; i++) {
				const chunk = lib.escapeString(chunks[i]);
				const chunkNum = i + 1;
				const totalChunks = chunks.length;
				
				const result = await this.sendRcon(
					`/sc remote.call("surface_export", "import_platform_chunk", ` +
					`"${platformName}", '${chunk}', ${chunkNum}, ${totalChunks}, "${forceName}")`,
					true
				);
				
				if (i % 10 === 0 || chunkNum === totalChunks) {
					this.logger.verbose(`Sent chunk ${chunkNum}/${totalChunks}`);
				}
			}
			
			this.logger.info(`All ${chunks.length} chunks sent, import queued for async processing`);
			return { success: true };
			
		} catch (err) {
			this.logger.error(`Import failed:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}

	/**
	 * Import a platform from a file in script-output directory
	 * FACTORIO 2.0: Lua cannot read files, so Node.js reads and sends via RCON chunks
	 * @param {string} filename - Filename in script-output (e.g., "Strana Mechty_26842034.json")
	 * @param {string} platformName - Name for the imported platform (optional, defaults to original name)
	 * @param {string} forceName - Force to import to (default: "player")
	 * @returns {Object} Result with success status
	 */
	async importPlatformFromFile(filename, platformName = null, forceName = "player") {
		this.logger.info(`Importing platform from file "${filename}" for force "${forceName}"`);

		try {
			// Step 1: Node.js reads the file (Lua cannot do this in Factorio 2.0)
			const instanceDir = this.instance.config.get("instance.directory");
			const scriptOutputPath = path.join(instanceDir, "script-output", filename);

			this.logger.verbose(`Reading file from: ${scriptOutputPath}`);
			const fileContent = await fs.readFile(scriptOutputPath, "utf8");
			const exportData = JSON.parse(fileContent);

			const sizeKB = (fileContent.length / 1024).toFixed(1);
			this.logger.info(`File loaded: ${sizeKB} KB`);

			// Use the original platform name if no custom name provided
			const targetPlatformName = platformName || exportData.platform_name || `Imported_${Date.now()}`;

			// Step 2: Send to Factorio via RCON chunking
			// Use the existing import_platform_chunk remote interface
			await sendChunkedJson(
				this.instance,
				`remote.call("surface_export", "import_platform_chunk", "${targetPlatformName}", %CHUNK%, %INDEX%, %TOTAL%, "${forceName}")`,
				exportData,
				this.logger,
				100000  // 100KB chunks
			);

			this.logger.info(`Platform import chunks sent successfully`);

			// Step 3: Wait a moment for async processing to start
			await new Promise(resolve => setTimeout(resolve, 500));

			// Step 4: Verify the import was queued
			try {
				const result = await this.sendRcon(
					`/sc rcon.print('{"success":true}')`
				);
				const response = JSON.parse(result);

				if (response.success) {
					this.logger.info(`Platform import queued for async processing`);
					return { success: true };
				}
			} catch (verifyErr) {
				this.logger.warn(`Could not verify import: ${verifyErr.message}`);
			}

			return { success: true };

		} catch (err) {
			this.logger.error(`Import from file failed:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}

	/**
	 * Factorio requires the first Lua console command to be confirmed.
	 * Send a harmless command twice so subsequent RCON calls execute immediately.
	 */
	async ensureLuaConsoleUnlocked() {
		const unlockCommand = '/sc rcon.print("surface-export-ready")';
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			try {
				await this.sendRcon(unlockCommand);
				if (attempt === 1) {
					// First attempt may only trigger the confirmation prompt; always run twice.
					continue;
				}
				this.logger.info("Lua console unlocked for Surface Export automation");
				return;
			} catch (err) {
				this.logger.warn(`RCON handshake attempt ${attempt} failed: ${err.message}`);
			}
		}
		this.logger.warn("Unable to confirm Lua console unlock; subsequent exports may require a manual command rerun.");
	}

	/**
	 * Handle export platform request
	 * @param {Object} request - ExportPlatformRequest
	 * @returns {Object} Response with success status
	 */
	async handleExportPlatformRequest(request) {
		return await this.exportPlatform(request.platformIndex, request.forceName);
	}

	/**
	 * Handle import platform request
	 * @param {Object} request - ImportPlatformRequest
	 * @returns {Object} Response with success status
	 */
	async handleImportPlatformRequest(request) {
		return await this.importPlatform(request.exportData, request.forceName);
	}

	/**
	 * Handle import platform from file request
	 * @param {Object} request - ImportPlatformFromFileRequest
	 * @returns {Object} Response with success status
	 */
	async handleImportPlatformFromFileRequest(request) {
		return await this.importPlatformFromFile(request.filename, request.platformName, request.forceName);
	}

	/**
	 * Handle import completion and perform validation
	 * Called by Lua when async import completes
	 * @param {Object} data - Import completion data with validation info and metrics
	 */
	async handleImportCompleteValidation(data) {
		this.logger.info(`Import completed for ${data.platform_name}, performing validation`);

		// Extract transfer metadata from platform data
		const transferId = data.transfer_id;
		const sourceInstanceId = data.source_instance_id;
		
		// Extract metrics from IPC data
		const metrics = data.metrics || null;
		if (metrics) {
			this.logger.info(`Import metrics: ${JSON.stringify(metrics)}`);
		}

		if (!transferId || !sourceInstanceId) {
			this.logger.warn("Import completed but missing transfer metadata, skipping validation");
			return;
		}

		try {
			// Get validation data from Lua
			const validationResult = await this.sendRcon(
				`/sc rcon.print(remote.call("surface_export", "get_validation_result_json", "${data.platform_name}"))`
			);

			this.logger.info(`Validation RCON result: ${validationResult.substring(0, 200)}...`);

			// Default to failed validation - only pass if we get actual validation data
			let validation = { itemCountMatch: false, fluidCountMatch: false, entityCount: data.entity_count, mismatchDetails: "Validation data not retrieved" };
			let validationRetrieved = false;

			if (validationResult && validationResult !== "null" && validationResult.startsWith("{")) {
				try {
					validation = JSON.parse(validationResult);
					validationRetrieved = true;
				} catch (parseErr) {
					this.logger.error(`Failed to parse validation result: ${validationResult}`);
					validation.mismatchDetails = "Failed to parse validation result";
				}
			} else if (validationResult && !validationResult.startsWith("{") && validationResult !== "null") {
				this.logger.warn(`Unexpected validation result format: ${validationResult}`);
				validation.mismatchDetails = `Validation error: ${validationResult.substring(0, 100)}`;
			}

			// Send validation event to controller with metrics
			await this.instance.sendTo("controller", new messages.TransferValidationEvent({
				transferId,
				platformName: data.platform_name,
				sourceInstanceId,
				success: validation.itemCountMatch && validation.fluidCountMatch,
				validation,
				metrics,  // Forward Lua import metrics to controller
			}));

			this.logger.info(`Validation event sent for transfer ${transferId}: success=${validation.itemCountMatch && validation.fluidCountMatch}`);

		} catch (err) {
			this.logger.error(`Error during validation:\n${err.stack}`);
			
			// Send failure validation to prevent controller from hanging
			try {
				await this.instance.sendTo("controller", new messages.TransferValidationEvent({
					transferId,
					platformName: data.platform_name,
					sourceInstanceId,
					success: false,
					validation: {
						itemCountMatch: false,
						fluidCountMatch: false,
						mismatchDetails: `Validation error: ${err.message}`,
					},
				}));
				this.logger.info(`Sent failure validation for transfer ${transferId} due to error`);
			} catch (sendErr) {
				this.logger.error(`Failed to send failure validation: ${sendErr.message}`);
			}
		}
	}

	/**
	 * Handle delete source platform request
	 * @param {Object} request - DeleteSourcePlatformRequest
	 * @returns {Object} Response with success status
	 */
	async handleDeleteSourcePlatform(request) {
		this.logger.info(`Deleting source platform: ${request.platformName}`);

		try {
			const result = await this.sendRcon(
				`/sc ` +
				`local force = game.forces["${request.forceName}"]; ` +
				`local platform = nil; ` +
				`for _, p in pairs(force.platforms) do ` +
				`    if p.name == "${request.platformName}" then platform = p; break; end ` +
				`end; ` +
				`if platform then ` +
				`    platform.destroy(); ` +
				`    game.print("[Transfer Complete] Platform '${request.platformName}' transferred and deleted from source", {0, 1, 0}); ` +
				`    rcon.print("SUCCESS"); ` +
				`else ` +
				`    rcon.print("ERROR:Platform not found"); ` +
				`end`
			);

			const trimmedResult = result.trim();
			if (trimmedResult === "SUCCESS") {
				this.logger.info(`Platform ${request.platformName} deleted successfully`);
				return { success: true };
			} else {
				const error = trimmedResult.replace("ERROR:", "");
				this.logger.error(`Failed to delete platform: ${error}`);
				return { success: false, error };
			}

		} catch (err) {
			this.logger.error(`Error deleting platform:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}

	/**
	 * Handle unlock source platform request (rollback)
	 * @param {Object} request - UnlockSourcePlatformRequest
	 * @returns {Object} Response with success status
	 */
	async handleUnlockSourcePlatform(request) {
		this.logger.info(`Unlocking source platform for rollback: ${request.platformName}`);

		try {
			const result = await this.sendRcon(
				`/sc ` +
				`local success, err = remote.call("surface_export", "unlock_platform", "${request.platformName}"); ` +
				`if success then ` +
				`    rcon.print("SUCCESS"); ` +
				`else ` +
				`    rcon.print("ERROR:" .. (err or "Unknown error")); ` +
				`end`
			);

			if (result.trim() === "SUCCESS") {
				this.logger.info(`Platform ${request.platformName} unlocked successfully`);
				return { success: true };
			} else {
				const error = result.trim().replace("ERROR:", "");
				this.logger.warn(`Failed to unlock platform: ${error}`);
				return { success: false, error };
			}

		} catch (err) {
			this.logger.error(`Error unlocking platform:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}

	/**
	 * Handle transfer status update from controller
	 * Broadcasts status to all players in-game
	 * @param {Object} request - TransferStatusUpdate
	 * @returns {Object} Response with success status
	 */
	async handleTransferStatusUpdate(request) {
		this.logger.info(`Transfer status: ${request.message}`);

		try {
			// Map color names to RGB arrays for Factorio
			const colorMap = {
				"green": "{0, 1, 0}",
				"yellow": "{1, 1, 0}",
				"red": "{1, 0, 0}",
				"blue": "{0, 0.5, 1}",
				"white": "{1, 1, 1}",
			};

			const colorCode = colorMap[request.color] || "{1, 1, 1}";

			// Send message to Factorio for in-game display
			await this.sendRcon(
				`/sc game.print("${request.message}", ${colorCode})`,
				true
			);

			return { success: true };

		} catch (err) {
			this.logger.error(`Error displaying transfer status:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}

	validateInstanceConfiguration() {
		const scriptCommandsEnabled = this.instance.config.get("factorio.enable_script_commands");
		if (!scriptCommandsEnabled) {
			throw new Error("Surface Export requires factorio.enable_script_commands to be enabled");
		}
		const cacheLimit = this.instance.config.get(`${info.plugin.name}.max_export_cache_size`);
		if (typeof cacheLimit !== "number" || cacheLimit < 1) {
			throw new Error("surface_export.max_export_cache_size must be >= 1");
		}
	}
}

module.exports = InstancePlugin;
module.exports.InstancePlugin = InstancePlugin;

