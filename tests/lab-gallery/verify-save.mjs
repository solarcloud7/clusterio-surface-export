import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REMOTE_ROOT = "/tmp/surface-export-lab-gallery-verify";
const GAME_PORT = "34977";
const RCON_PORT = "27977";
const RCON_PASSWORD = "gallery-verify-only";

export function parseArguments(argv) {
	const result = { sourceSave: null, destinationSave: null, container: "surface-export-host-2" };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--source-save") result.sourceSave = argv[++index];
		else if (argument === "--destination-save") result.destinationSave = argv[++index];
		else if (argument === "--container") result.container = argv[++index];
		else throw new Error(`unknown argument ${argument}`);
	}
	if (!result.sourceSave) throw new Error("--source-save <gallery.zip> is required");
	if (!result.destinationSave) throw new Error("--destination-save <gallery.zip> is required");
	if (!/^surface-export-host-\d+$/.test(result.container)) throw new Error(`unsupported container ${result.container}`);
	return result;
}

function assertFields(reading, expected) {
	for (const [field, value] of Object.entries(expected)) {
		try { assert.deepEqual(reading?.[field], value); }
		catch { throw new Error(`reload field ${field} is ${JSON.stringify(reading?.[field])}, expected ${JSON.stringify(value)}`); }
	}
}

export function assertSurfaceSettings(settings) {
	if (!Array.isArray(settings) || settings.length === 0) throw new Error("surface_settings is empty");
	for (const row of settings) {
		for (const field of ["generate_with_lab_tiles", "has_global_electric_network", "ignore_surface_conditions"]) {
			if (row?.[field] !== true) throw new Error(`surface ${row?.name || "<unknown>"} ${field} is not true`);
		}
	}
	return settings;
}

export function assertReloadReading(reading, role) {
	if (reading?.reachability?.exists === true && !("mining_target" in reading.reachability)) reading.reachability.mining_target = null;
	assertFields(reading, {
		version: "2.0.77", save_role: role, gallery_storage: true, index_surface: true, game_paused: false,
		transient: { jobs: 0, locks: 0, holds: 0, tombstones: 0 }, index_texts: 12, index_tags: 12,
	});
	assertSurfaceSettings(reading?.surface_settings);
	if (role === "source") {
		assertFields(reading, {
			source_belts: 16, target_belts: 16, source_quantity: 125, physical_stacks: 125,
			maximum_stack: 1, source_line_quantities: [67, 58], target_quantity: 0,
			surface_census: { total_entities: 34, total_generated_chunks: 248, surface_names: ["lab-gallery-index-v2", "nauvis", "platform-2"] },
		});
		assertFields(reading.reachability, {
			exists: true, platform_name: "lab-specialized-fluid-r1", drill_name: "electric-mining-drill",
			pressure: 0, gravity: 0, mining_target: null, live_fluidbox_count: 0, read_ok: false, write_ok: false,
		});
	} else if (role === "destination") {
		assertFields(reading, {
			source_belts: 0, target_belts: 0, source_quantity: 0, physical_stacks: 0,
			maximum_stack: 0, source_line_quantities: [0, 0], target_quantity: 0,
			surface_census: { total_entities: 0, total_generated_chunks: 92, surface_names: ["lab-gallery-index-v2", "nauvis"] },
		});
		assertFields(reading.reachability, { exists: false });
	} else throw new Error(`unsupported save role ${role}`);
	return reading;
}

function docker(arguments_, options = {}) {
	return execFileSync("docker", arguments_, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], ...options });
}

function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function verifyOne(options, role, save) {
	const config = fileURLToPath(new URL("./isolated-config.ini", import.meta.url));
	const meter = fileURLToPath(new URL("./reload-meter.cjs", import.meta.url));
	docker(["exec", options.container, "test", "!", "-e", REMOTE_ROOT]);
	docker(["exec", options.container, "mkdir", REMOTE_ROOT]);
	let launched = false;
	try {
		docker(["cp", save, `${options.container}:${REMOTE_ROOT}/gallery.zip`]);
		docker(["cp", config, `${options.container}:${REMOTE_ROOT}/config.ini`]);
		docker(["cp", meter, `${options.container}:${REMOTE_ROOT}/reload-meter.cjs`]);
		const launch = `echo $$ > ${REMOTE_ROOT}/verifier.pid; exec timeout 60 /opt/factorio/2.0.77/bin/x64/factorio --start-server ${REMOTE_ROOT}/gallery.zip --config ${REMOTE_ROOT}/config.ini --mod-directory /clusterio/data/instances/clusterio-host-2-instance-1/mods --port ${GAME_PORT} --rcon-port ${RCON_PORT} --rcon-password ${RCON_PASSWORD}`;
		docker(["exec", "-d", options.container, "setsid", "sh", "-c", launch]);
		launched = true;
		const deadline = Date.now() + 30_000;
		let output;
		while (Date.now() < deadline) {
			try { output = docker(["exec", options.container, "node", `${REMOTE_ROOT}/reload-meter.cjs`, RCON_PORT, RCON_PASSWORD]); break; }
			catch (error) {
				const detail = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
				if (!detail.includes("ECONNREFUSED") && !detail.includes("ECONNRESET")) throw error;
				await sleep(500);
			}
		}
		if (!output) throw new Error(`isolated ${role} RCON did not become ready`);
		const result = JSON.parse(output);
		return assertReloadReading(result.reading, role);
	} finally {
		if (launched) {
			try {
				const pid = docker(["exec", options.container, "cat", `${REMOTE_ROOT}/verifier.pid`]).trim();
				if (/^\d+$/.test(pid)) try { docker(["exec", options.container, "kill", "-TERM", `-${pid}`]); } catch { /* meter normally quits */ }
			} catch { /* launch may fail before pid write */ }
		}
		await sleep(500);
		docker(["exec", options.container, "rm", "-rf", "--", REMOTE_ROOT]);
	}
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	for (const path of [options.sourceSave, options.destinationSave]) if (!existsSync(path)) throw new Error(`save does not exist: ${path}`);
	const readings = {};
	for (const role of ["source", "destination"]) readings[role] = await verifyOne(options, role, options[`${role}Save`]);
	console.log(JSON.stringify({ status: "PASS", saves: { source: options.sourceSave, destination: options.destinationSave }, readings }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
