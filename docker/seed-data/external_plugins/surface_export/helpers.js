/**
 * @file helpers.js
 * @description Helper functions for chunked RCON data transfer with hybrid escaping
 */

"use strict";
const fs = require("fs").promises;
const path = require("path");
const lib = require("@clusterio/lib");

/**
 * Send JSON data to Factorio using optimal escaping method
 * Automatically chooses between [[...]] (fast) and '...' (safe) based on content
 *
 * @param {Object} instance - Clusterio instance
 * @param {string} luaFunction - Full Lua function call (e.g., "surface_export.receive_data")
 * @param {Object} data - Data to send
 * @param {Object} logger - Logger instance
 */
async function sendJsonToFactorio(instance, luaFunction, data, logger) {
	const json = JSON.stringify(data);

	// Check for ]] sequence (common in equipment grids with nested arrays)
	if (json.includes(']]')) {
		logger.verbose(
			`Data contains ]], using escaped string (${json.length} bytes)`
		);
		const escaped = lib.escapeString(json);
		await instance.sendRcon(
			`/sc ${luaFunction}('${escaped}')`,
			true
		);
	} else {
		// Fast path: raw string literal (no escaping overhead)  Potential savings of 10% less file size. 
		// TODO: Real world test on sendJsonToFactorio() file size between escaped and string literal
		await instance.sendRcon(
			`/sc ${luaFunction}([[${json}]])`,
			true
		);
	}
}

/**
 * Split data into chunks for RCON transfer
 *
 * @param {number} chunkSize - Size of each chunk in bytes
 * @param {string} data - Data to chunk
 * @returns {Array<string>} Array of chunks
 */
function chunkify(chunkSize, data) {
	const chunks = [];
	for (let i = 0; i < data.length; i += chunkSize) {
		chunks.push(data.slice(i, i + chunkSize));
	}
	return chunks;
}

/**
 * Send large JSON data in chunks with progress reporting
 *
 * Template placeholders:
 *   %CHUNK% - replaced with chunk data (escaped or raw)
 *   %INDEX% - replaced with chunk index (1-based)
 *   %TOTAL% - replaced with total chunk count
 *
 * @param {Object} instance - Clusterio instance
 * @param {string} luaTemplate - Lua command template with placeholders
 * @param {Object} data - Data to send
 * @param {Object} logger - Logger instance
 * @param {number} chunkSize - Chunk size in bytes (default 100KB)
 *
 * @example
 * await sendChunkedJson(
 *   instance,
 *   'remote.call("MyMod", "import_chunk", %CHUNK%, %INDEX%, %TOTAL%)',
 *   data,
 *   logger,
 *   100000
 * );
 */
async function sendChunkedJson(instance, luaTemplate, data, logger, chunkSize = 100000) {
	const json = JSON.stringify(data);
	const needsEscaping = json.includes(']]');

	logger.info(
		`Sending ${json.length} bytes in ${chunkSize} byte chunks ` +
		`(escaping: ${needsEscaping ? 'yes' : 'no'})`
	);

	const chunks = chunkify(chunkSize, json);
	const startTime = Date.now();

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const index = i + 1;
		const total = chunks.length;

		let chunkString;
		if (needsEscaping) {
			const escaped = lib.escapeString(chunk);
			chunkString = `'${escaped}'`;
		} else {
			chunkString = `[[${chunk}]]`;
		}

		// Replace template placeholders
		const command = luaTemplate
			.replace(/%CHUNK%/g, chunkString)
			.replace(/%INDEX%/g, index.toString())
			.replace(/%TOTAL%/g, total.toString());

		await instance.sendRcon(`/sc ${command}`, true);

		// Progress reporting every 10 chunks
		if (i % 10 === 0 || index === total) {
			const percent = ((index / total) * 100).toFixed(1);
			logger.verbose(`Sent chunk ${index}/${total} (${percent}%)`);
		}
	}

	const duration = Date.now() - startTime;
	const throughput = (json.length / 1024 / (duration / 1000)).toFixed(2);
	logger.info(
		`All ${chunks.length} chunks sent successfully ` +
		`(${duration}ms, ${throughput} KB/s)`
	);
}

/**
 * Send data with adaptive chunking based on size
 * Small data: Send directly
 * Medium data: 50KB chunks
 * Large data: 100KB chunks
 *
 * @param {Object} instance - Clusterio instance
 * @param {string} directFunction - Lua function for direct receive (receives json_string)
 * @param {string} chunkFunction - Lua function for chunked receive (receives chunk, index, total)
 * @param {Object} data - Data to send
 * @param {Object} logger - Logger instance
 */
async function sendAdaptiveJson(instance, directFunction, chunkFunction, data, logger) {
	const json = JSON.stringify(data);
	const sizeKB = json.length / 1024;

	if (sizeKB < 50) {
		// Small data: send directly
		logger.info(`Sending ${sizeKB.toFixed(1)}KB directly (below chunking threshold)`);
		await sendJsonToFactorio(instance, directFunction, data, logger);
	} else if (sizeKB < 1024) {
		// Medium data: 50KB chunks
		logger.info(`Sending ${sizeKB.toFixed(1)}KB in 50KB chunks`);
		await sendChunkedJson(instance, chunkFunction, data, logger, 50000);
	} else {
		// Large data: 100KB chunks
		logger.info(`Sending ${sizeKB.toFixed(1)}KB in 100KB chunks`);
		await sendChunkedJson(instance, chunkFunction, data, logger, 100000);
	}
}

// Mod names bundled with the Factorio executable (no zip file on disk)
const VANILLA_MODS = new Set(["base", "core", "space-age", "quality", "elevated-rails"]);

/**
 * Extract a single file from a mod zip using yauzl (non-blocking, stream-based).
 * Stops as soon as the target entry is found — never loads the full zip into memory.
 *
 * @param {string} zipPath - Absolute path to the .zip file
 * @param {string} modName - Mod name (zip root folder may be "modName" or "modName_version")
 * @param {string} filePath - Path inside the mod, relative to mod root (e.g. "graphics/icons/planet.png")
 * @returns {Promise<Buffer|null>} File contents, or null if not found
 */
function extractFromModZip(zipPath, modName, filePath) {
	const yauzl = require("yauzl");
	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (err, zipFile) => {
			if (err) return reject(err);
			zipFile.readEntry();
			zipFile.on("entry", entry => {
				const parts = entry.fileName.split("/");
				const root = parts[0];
				const rest = parts.slice(1).join("/");
				// Zip root folder is either "modname" or "modname_version"
				const rootMatches = root === modName || root.startsWith(modName + "_");
				if (rootMatches && rest === filePath) {
					zipFile.openReadStream(entry, (streamErr, stream) => {
						if (streamErr) return reject(streamErr);
						const chunks = [];
						stream.on("data", chunk => chunks.push(chunk));
						stream.on("end", () => resolve(Buffer.concat(chunks)));
						stream.on("error", reject);
					});
				} else {
					zipFile.readEntry();
				}
			});
			zipFile.on("end", () => resolve(null));
			zipFile.on("error", reject);
		});
	});
}

/**
 * Resolve a Factorio asset path ("__modname__/path/to/file.png") to a Buffer.
 * Vanilla mod files are read from the Factorio data directory.
 * Third-party mod files are extracted from the mod zip in the mods directory.
 *
 * @param {string} assetPath - Factorio asset path, e.g. "__space-age__/graphics/icons/planet/aquilo.png"
 * @param {string} factorioDataDir - Path to Factorio data directory (e.g. "/opt/factorio/data")
 * @param {string} modsDir - Path to mods directory (e.g. "/clusterio/mods")
 * @returns {Promise<Buffer|null>} File contents as a Buffer, or null if not found
 */
async function resolveFactorioAsset(assetPath, factorioDataDir, modsDir) {
	// Parse __modname__/path/to/file from the Factorio asset path format
	const match = assetPath.match(/^__([^_](?:[^_]|_(?!_))*[^_]|[^_])__\/(.+)$/);
	if (!match) return null;
	const modName = match[1];
	const filePath = match[2];

	if (VANILLA_MODS.has(modName)) {
		// Vanilla mods: read directly from Factorio data directory
		try {
			return await fs.readFile(path.join(factorioDataDir, modName, filePath));
		} catch {
			return null;
		}
	}

	// Third-party mod: find the zip file and extract from it
	let modFiles;
	try {
		modFiles = await fs.readdir(modsDir);
	} catch {
		return null;
	}
	const zipFile = modFiles.find(f => f.startsWith(modName + "_") && f.endsWith(".zip"));
	if (!zipFile) return null;

	try {
		return await extractFromModZip(path.join(modsDir, zipFile), modName, filePath);
	} catch {
		return null;
	}
}

module.exports = {
	sendJsonToFactorio,
	chunkify,
	sendChunkedJson,
	sendAdaptiveJson,
	resolveFactorioAsset,
	extractFromModZip,
};
