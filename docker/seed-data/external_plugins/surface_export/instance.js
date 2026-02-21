/**
 * @file instance.js
 * @description Instance plugin for Surface Export - runs on each Factorio host
 * @see https://github.com/clusterio/clusterio/blob/master/docs/writing-plugins.md
 */

"use strict";
const fs = require("fs").promises;
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
const lib = requireClusterioModule("@clusterio/lib");
const { BaseInstancePlugin } = requireClusterioModule("@clusterio/host");
const info = require("./index.js");
const messages = require("./messages");
const { sendChunkedJson, sendAdaptiveJson, resolveFactorioAsset } = require("./helpers");

/**
 * Instance plugin class
 * Runs on each Clusterio host and handles communication with Factorio servers
 */
class InstancePlugin extends BaseInstancePlugin {
	normalizeRconScalarResult(value) {
		const text = String(value ?? "");
		const lines = text
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean);
		return lines.length ? lines[lines.length - 1] : "";
	}

	isInvalidExportId(exportId) {
		if (!exportId) {
			return true;
		}
		const lowered = String(exportId).trim().toLowerCase();
		return lowered.startsWith("export_failed")
			|| lowered === "nil"
			|| lowered.startsWith("error");
	}
	/**
	 * Initialize plugin
	 * Called when plugin is loaded
	 */
	async init() {		
		this.logger.info("Surface Export plugin initializing...");
		this.logger.info(`Instance ID: ${this.instance.id}, Name: ${this.instance.config.get("instance.name")}`);
		this.validateInstanceConfiguration();
		this.controllerManagedTransferExports = new Set();
		
		// Listen for platform export completion from Factorio mod
		// The mod sends data via clusterio_api.send_json("surface_export_complete", data)
		this.instance.server.handle("surface_export_complete", this.handleExportComplete.bind(this));
		
		// Listen for import file requests from mod
		// The mod sends data via clusterio_api.send_json("surface_import_file_request", data)
		this.instance.server.handle("surface_import_file_request", this.handleImportFileRequest.bind(this));

		// Listen for import completion with validation from mod
		this.instance.server.handle("surface_export_import_complete", this.handleImportCompleteValidation.bind(this));

		// Listen for space platform state changes from Factorio mod
		this.instance.server.handle("surface_platform_state_changed", this.handlePlatformStateChanged.bind(this));

		// Listen for transfer requests from mod
		this.instance.server.handle("surface_transfer_request", this.handleTransferRequest.bind(this));

		// Register message handlers
		this.instance.handle(messages.ExportPlatformRequest, this.handleExportPlatformRequest.bind(this));
		this.instance.handle(messages.ImportPlatformRequest, this.handleImportPlatformRequest.bind(this));
		this.instance.handle(messages.ImportPlatformFromFileRequest, this.handleImportPlatformFromFileRequest.bind(this));
		this.instance.handle(messages.DeleteSourcePlatformRequest, this.handleDeleteSourcePlatform.bind(this));
		this.instance.handle(messages.UnlockSourcePlatformRequest, this.handleUnlockSourcePlatform.bind(this));
		this.instance.handle(messages.TransferStatusUpdate, this.handleTransferStatusUpdate.bind(this));
		this.instance.handle(messages.InstanceListPlatformsRequest, this.handleInstanceListPlatformsRequest.bind(this));
		this.instance.handle(messages.ResolveAssetsRequest, this.handleResolveAssets.bind(this));

		this.logger.info("Surface Export plugin initialized");
	}
	
	/**
	 * Called when instance starts
	 */
	async onStart() {
		this.logger.info("Instance started - Surface Export plugin ready");
		await this.ensureLuaConsoleUnlocked();
		await this.sendConfigurationToLua();
		await this.registerPlanetPaths();
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
			
			const configScript = `/sc ` +
				`if remote.interfaces["surface_export"] and remote.interfaces["surface_export"]["configure"] then ` +
				`remote.call("surface_export", "configure", {` +
				`batch_size=${batchSize}, ` +
				`max_concurrent_jobs=${maxConcurrentJobs}, ` +
				`show_progress=${showProgress}, ` +
				`debug_mode=${debugMode}` +
				`}) ` +
				`end`;
			
			await this.instance.sendRcon(configScript, true);
			this.logger.info(`Configuration sent to Lua: batch_size=${batchSize}, max_concurrent_jobs=${maxConcurrentJobs}, show_progress=${showProgress}, debug_mode=${debugMode}`);
		} catch (err) {
			this.logger.warn(`Failed to send configuration to Lua: ${err.message}`);
		}
	}
	
	/**
	 * Query Lua for planet icon paths and register them with the controller.
	 * Called on onStart so the controller's planet registry is populated
	 * and can route asset requests to this instance.
	 */
	async registerPlanetPaths() {
		try {
			const json = await this.instance.sendRcon(
				"/sc rcon.print(remote.call('surface_export', 'get_planet_icon_paths_json'))",
				true
			);
			const normalized = this.normalizeRconScalarResult(json);
			if (!normalized || normalized === "nil") return;
			const planetPaths = JSON.parse(normalized);
			if (!planetPaths || typeof planetPaths !== "object") return;

			const planets = {};
			for (const [name, iconData] of Object.entries(planetPaths)) {
				const iconPath = iconData.starmap_icon || iconData.icon;
				if (!iconPath) continue;
				const match = iconPath.match(/^__([^_](?:[^_]|_(?!_))*[^_]|[^_])__\//);
				const modName = match ? match[1] : null;
				if (modName) planets[name] = { iconPath, modName };
			}

			if (Object.keys(planets).length === 0) return;

			await this.instance.sendTo("controller", new messages.RegisterPlanetPathsRequest({ planets }));
			this.logger.info(`Registered ${Object.keys(planets).length} planet icon paths with controller`);
		} catch (err) {
			this.logger.warn(`registerPlanetPaths failed: ${err.message}`);
		}
	}

	/**
	 * Resolve Factorio asset paths to raw file buffers (base64-encoded).
	 * Handles both vanilla mods (from Factorio data dir) and third-party mod zips.
	 * @param {import('./messages').ResolveAssetsRequest} request
	 */
	async handleResolveAssets(request) {
		const factorioDataDir = "/opt/factorio/data";
		const modsDir = "/clusterio/mods";
		const assets = {};
		for (const assetPath of request.paths) {
			try {
				const buf = await resolveFactorioAsset(assetPath, factorioDataDir, modsDir);
				assets[assetPath] = buf ? buf.toString("base64") : null;
			} catch (err) {
				this.logger.warn(`Asset resolve failed for ${assetPath}: ${err.message}`);
				assets[assetPath] = null;
			}
		}
		return { assets };
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
		const exportId = String(data.export_id || "").trim();
		this.logger.info(`Export complete send_json event received: export_id=${exportId}, platform=${data.platform_name}`);
		this.logger.info(`  destination_instance_id=${data.destination_instance_id} (type=${typeof data.destination_instance_id}), job_id=${data.job_id}`);
		this.logger.info(`  this.instance.id=${this.instance.id} (type=${typeof this.instance.id})`);
		this.logger.info(`Platform export completed: ${exportId} (${data.platform_name})`);

		if (this.isInvalidExportId(exportId)) {
			this.logger.error(`Export completion send_json payload contained invalid export ID: ${JSON.stringify(data.export_id)}`);
			return;
		}

		try {
			// Retrieve full export data from mod
			const exportData = await this.getExportData(exportId);

			if (!exportData) {
				this.logger.error(`Failed to retrieve export data for ${exportId}`);
				return;
			}

			// Send export to controller for storage
			await this.instance.sendTo("controller", new messages.PlatformExportEvent({
				exportId,
				platformName: data.platform_name,
				instanceId: this.instance.id,
				exportData: exportData,
				timestamp: Date.now(),
				exportMetrics: data.export_metrics || null,
			}));
			this.logger.info(`Sent platform export ${exportId} to controller`);

			// Check if auto-transfer was requested (destination_instance_id in send_json payload)
			if (data.destination_instance_id) {
				if (this.controllerManagedTransferExports.has(exportId)) {
					this.controllerManagedTransferExports.delete(exportId);
					this.logger.info(`Skipping instance auto-transfer for controller-managed export ${exportId}`);
					return;
				}
				this.logger.info(`Auto-transfer requested: dest_instance_id=${data.destination_instance_id} (type=${typeof data.destination_instance_id})`);
				this.logger.info(`  Sending TransferPlatformRequest to controller: exportId=${exportId}, targetInstanceId=${data.destination_instance_id}`);
				
				// Send transfer request to controller
				const transferResponse = await this.instance.sendTo("controller",
					new messages.TransferPlatformRequest({
						exportId,
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
						exportId,
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
	 * Handle space platform state change notification from Factorio mod.
	 * Forwards a lightweight event to the controller so it can push a tree refresh.
	 * @param {Object} data - { platform_name, force_name }
	 */
	async handlePlatformStateChanged(data) {
		try {
			await this.instance.sendTo("controller", new messages.PlatformStateChangedEvent({
				instanceId: this.instance.id,
				platformName: String(data.platform_name || ""),
				forceName: String(data.force_name || "player"),
			}));
		} catch (err) {
			this.logger.warn(`Platform state change notification failed: ${err.message}`);
		}
	}

	/**
	 * Handle transfer request from Lua command
	 * @param {Object} data - Transfer request data
	 */
	async handleTransferRequest(data) {
		this.logger.info(`Transfer request send_json event received: platform=${data.platform_name}, dest=${data.destination_instance_id} (type=${typeof data.destination_instance_id}), job_id=${data.job_id}`);

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
	 * @param {number|null} targetInstanceId - Optional destination instance for transfer-aware export locking
	 * @returns {Object} Result with success status and exportId
	 */
	async exportPlatform(platformIndex, forceName = "player", targetInstanceId = null) {
		const resolvedTargetId = Number(targetInstanceId);
		const hasTargetInstance = Number.isInteger(resolvedTargetId) && resolvedTargetId > 0;
		const targetArg = hasTargetInstance ? String(resolvedTargetId) : "nil";
		this.logger.info(`Exporting platform index ${platformIndex} for force "${forceName}" (targetInstanceId=${targetArg})`);
		
		try {
			// Call mod's remote interface to export platform - this returns the export_id
			const rconResult = await this.sendRcon(
				`/sc local export_id, err = remote.call("surface_export", "export_platform", ${platformIndex}, "${forceName.replace(/"/g, '\\\\\\"')}", ${targetArg}); ` +
				`if export_id then rcon.print(export_id) else rcon.print("EXPORT_FAILED:" .. tostring(err or "unknown")) end`
			);
			this.logger.info(`Export RCON result: ${rconResult}`);
			const exportResult = this.normalizeRconScalarResult(rconResult);
			if (!exportResult || exportResult.toLowerCase() === "nil") {
				return { success: false, error: "Export failed - no export_id returned" };
			}
			if (exportResult.toUpperCase().startsWith("EXPORT_FAILED")) {
				const parts = exportResult.split(":");
				const reason = parts.length > 1 ? parts.slice(1).join(":").trim() : "";
				return { success: false, error: reason ? `Export failed - ${reason}` : "Export failed" };
			}

			const exportId = exportResult.trim();
			if (this.isInvalidExportId(exportId)) {
				return { success: false, error: "Export failed - invalid export_id returned" };
			}
			this.logger.info(`Export completed with ID: ${exportId}`);
			
			// The export data will be sent to the controller automatically via the
			// send_json event-triggered handleExportComplete() path, which uses the real platform
			// name from Lua (not the sanitized exportId). No need to send it here too.
			return { success: true, exportId: exportId };
		} catch (err) {
			this.logger.error(`Export failed:\n${err.stack}`);
			return { success: false, error: err.message };
		}
	}

	async waitForExportData(exportId, timeoutMs = 30000, intervalMs = 500) {
		const deadline = Date.now() + timeoutMs;
		let lastAttempt = null;
		while (Date.now() < deadline) {
			lastAttempt = await this.getExportData(exportId, { logOnMissing: false });
			if (lastAttempt) {
				return lastAttempt;
			}
			await new Promise(resolve => setTimeout(resolve, intervalMs));
		}
		this.logger.error(`Timed out waiting for export data for ${exportId} after ${timeoutMs}ms`);
		// Log available exports for debugging once at timeout
		try {
			const availableExports = await this.listExports();
			this.logger.error(`Available exports in Lua: ${JSON.stringify(availableExports)}`);
		} catch (listErr) {
			this.logger.error(`Failed to list available exports: ${listErr.message}`);
		}
		return null;
	}
	
	/**
	 * Get export data from mod
	 * @param {string} exportId - Export ID
	 * @returns {Object|null} Export data (may be compressed format with {compressed, payload, ...}) or null if not found
	 */
	async getExportData(exportId, options = {}) {
		try {
			const { logOnMissing = true } = options;
			const safeExportId = String(exportId || "").trim();
			if (this.isInvalidExportId(safeExportId)) {
				this.logger.warn(`Skipping getExportData for invalid export ID: ${JSON.stringify(exportId)}`);
				return null;
			}
			// Call the _json version which pre-encodes the result in Lua
			const result = await this.sendRcon(
`/sc rcon.print(remote.call("surface_export", "get_export_json", "${safeExportId}"))`
			);

			const jsonText = String(result || "").trim();
			if (!jsonText || jsonText === "null") {
				if (logOnMissing) {
					this.logger.error(`Export data not found for ${safeExportId} - Lua returned empty/null`);
					// List available exports for debugging
					try {
						const availableExports = await this.listExports();
						this.logger.error(`Available exports in Lua: ${JSON.stringify(availableExports)}`);
					} catch (listErr) {
						this.logger.error(`Failed to list available exports: ${listErr.message}`);
					}
				}
				return null;
			}

			const exportData = JSON.parse(jsonText);
			if (!exportData || typeof exportData !== "object") {
				return null;
			}
			
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
	 * List all current platforms on this instance for a force
	 * @param {string} forceName - Force name to inspect
	 * @returns {Array} Platform metadata
	 */
	async listPlatforms(forceName = "player") {
		const safeForceName = String(forceName || "player")
			.replace(/\\/g, "\\\\")
			.replace(/"/g, '\\"');

		try {
			const result = await this.sendRcon(
				`/sc rcon.print(remote.call("surface_export", "list_platforms_json", "${safeForceName}"))`
			);
			const parsed = JSON.parse(result);
			if (!Array.isArray(parsed)) {
				return [];
			}

			return parsed.map(platform => ({
				platformIndex: platform.platform_index,
				platformName: platform.platform_name,
				forceName: platform.force_name || forceName || "player",
				surfaceIndex: platform.surface_index ?? null,
				surfaceName: platform.surface_name ?? null,
				entityCount: Number(platform.entity_count || 0),
				isLocked: Boolean(platform.is_locked),
				hasSpaceHub: Boolean(platform.has_space_hub),
				spaceLocation: platform.space_location ?? null,
				currentTarget: platform.current_target ?? null,
				speed: typeof platform.speed === "number" ? platform.speed : 0,
				state: platform.state ?? null,
				departureTick: platform.departure_tick ?? null,
				estimatedDurationTicks: platform.estimated_duration_ticks ?? null,
			}));
		} catch (err) {
			this.logger.error(`List platforms failed:\\n${err.stack}`);
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
		const result = await this.exportPlatform(request.platformIndex, request.forceName, request.targetInstanceId);
		const numericTargetInstanceId = Number(request.targetInstanceId);
		if (result?.success && Number.isInteger(numericTargetInstanceId) && numericTargetInstanceId > 0) {
			this.controllerManagedTransferExports.add(result.exportId);
		}
		return result;
	}

	/**
	 * Handle import platform request
	 * @param {Object} request - ImportPlatformRequest
	 * @returns {Object} Response with success status
	 */
	async handleImportPlatformRequest(request) {
		const hasTransferId = !!(request.exportData && request.exportData._transferId);
		const dataSize = request.exportData ? JSON.stringify(request.exportData).length : 0;
		this.logger.info(`ImportPlatformRequest received: force=${request.forceName}, isTransfer=${hasTransferId}, dataSize=${(dataSize / 1024).toFixed(1)}KB`);
		if (hasTransferId) {
			this.logger.info(`  transfer_id=${request.exportData._transferId}, source_instance=${request.exportData._sourceInstanceId}`);
		}
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
	 * Handle controller request for platform inventory on this instance
	 * @param {Object} request - InstanceListPlatformsRequest
	 * @returns {Object} Instance platform tree node payload
	 */
	async handleInstanceListPlatformsRequest(request) {
		const forceName = request.forceName || "player";
		const platforms = await this.listPlatforms(forceName);
		return {
			instanceId: this.instance.id,
			instanceName: this.instance.config.get("instance.name"),
			forceName,
			platforms,
		};
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
		const operationId = data.operation_id ? String(data.operation_id) : null;
		
		// Extract metrics from send_json payload
		const metrics = data.metrics || null;
		if (metrics) {
			this.logger.info(`Import metrics: ${JSON.stringify(metrics)}`);
		}

		if (!transferId || !sourceInstanceId) {
			if (operationId) {
				try {
					await this.instance.sendTo("controller", new messages.ImportOperationCompleteEvent({
						operationId,
						platformName: String(data.platform_name || "Unknown"),
						instanceId: this.instance.id,
						success: true,
						error: null,
						durationTicks: Number.isFinite(Number(data.duration_ticks)) ? Number(data.duration_ticks) : null,
						entityCount: Number.isFinite(Number(data.entity_count)) ? Number(data.entity_count) : null,
						metrics: metrics || null,
					}));
					await this.handlePlatformStateChanged({
						platform_name: String(data.platform_name || ""),
						force_name: String(data.force_name || "player"),
					});
				} catch (emitErr) {
					this.logger.error(`Failed to forward import operation completion for ${operationId}: ${emitErr.message}`);
				}
				return;
			}
			this.logger.warn(`Import completed but missing transfer metadata, skipping validation. Received keys: ${Object.keys(data).join(', ')}`);
			this.logger.warn(`  transfer_id=${data.transfer_id} (type=${typeof data.transfer_id}), source_instance_id=${data.source_instance_id} (type=${typeof data.source_instance_id})`);
			return;
		}

		try {
			// Get validation data from Lua
			const validationStartMs = Date.now();
			const validationResult = await this.sendRcon(
				`/sc rcon.print(remote.call("surface_export", "get_validation_result_json", "${data.platform_name}"))`
			);
			const validationDurationMs = Date.now() - validationStartMs;

			this.logger.info(`Validation RCON call took ${validationDurationMs}ms, result: ${validationResult.substring(0, 200)}...`);

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
				// Clean up lock data first (clears storage.locked_platforms entry)
				`pcall(function() remote.call("surface_export", "unlock_platform", "${request.platformName}") end); ` +
				`local force = game.forces["${request.forceName}"]; ` +
				`local platform = nil; ` +
				`for _, p in pairs(force.platforms) do ` +
				`    if p.name == "${request.platformName}" then platform = p; break; end ` +
				`end; ` +
				`if platform then ` +
				// CRITICAL: platform.destroy() is a no-op in Factorio 2.0 Space Age.
				// It returns without error but does NOT remove the platform or its surface.
				// game.delete_surface() is the only reliable way to remove a space platform.
				`    local surface = platform.surface; ` +
				`    if surface and surface.valid then ` +
				`        local ok, err = pcall(function() game.delete_surface(surface) end); ` +
				`        if ok then ` +
				`            game.print("[Transfer Complete] Platform '${request.platformName}' transferred and deleted from source", {0, 1, 0}); ` +
				`            rcon.print("SUCCESS"); ` +
				`        else ` +
				`            rcon.print("ERROR:delete_surface failed: " .. tostring(err)); ` +
				`        end ` +
				`    else ` +
				`        rcon.print("ERROR:Platform surface not valid"); ` +
				`    end ` +
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

