import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REMOTE_ROOT = "/tmp/surface-export-lab-gallery-verify";
const GAME_PORT = "34977";
const RCON_PORT = "27977";
const RCON_PASSWORD = "gallery-verify-only";

export function parseArguments(argv) {
	const result = { save: null, container: "surface-export-host-2" };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--save") result.save = argv[++index];
		else if (argument === "--container") result.container = argv[++index];
		else throw new Error(`unknown argument ${argument}`);
	}
	if (!result.save) throw new Error("--save <gallery.zip> is required");
	if (!/^surface-export-host-\d+$/.test(result.container)) throw new Error(`unsupported container ${result.container}`);
	return result;
}

export function assertReloadReading(reading) {
	const expected = {
		version: "2.0.77", gallery_storage: true, index_surface: true,
		source_belts: 16, target_belts: 16, source_quantity: 125,
		physical_stacks: 125, maximum_stack: 1,
		source_line_quantities: [67, 58], target_quantity: 0,
		index_texts: 12, source_texts: 3, index_tags: 12, source_tags: 2,
	};
	for (const [field, value] of Object.entries(expected)) {
		try { assert.deepEqual(reading?.[field], value); }
		catch { throw new Error(`reload field ${field} is ${JSON.stringify(reading?.[field])}, expected ${JSON.stringify(value)}`); }
	}
	return reading;
}

function docker(arguments_, options = {}) {
	return execFileSync("docker", arguments_, {
		encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], ...options,
	});
}

function sleep(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (!existsSync(options.save)) throw new Error(`save does not exist: ${options.save}`);
	const config = fileURLToPath(new URL("./isolated-config.ini", import.meta.url));
	const meter = fileURLToPath(new URL("./reload-meter.cjs", import.meta.url));

	docker(["exec", options.container, "test", "!", "-e", REMOTE_ROOT]);
	docker(["exec", options.container, "mkdir", REMOTE_ROOT]);
	let launched = false;
	try {
		docker(["cp", options.save, `${options.container}:${REMOTE_ROOT}/gallery.zip`]);
		docker(["cp", config, `${options.container}:${REMOTE_ROOT}/config.ini`]);
		docker(["cp", meter, `${options.container}:${REMOTE_ROOT}/reload-meter.cjs`]);
		const launch = `echo $$ > ${REMOTE_ROOT}/verifier.pid; exec timeout 60 /opt/factorio/2.0.77/bin/x64/factorio --start-server ${REMOTE_ROOT}/gallery.zip --config ${REMOTE_ROOT}/config.ini --mod-directory /clusterio/data/instances/clusterio-host-2-instance-1/mods --port ${GAME_PORT} --rcon-port ${RCON_PORT} --rcon-password ${RCON_PASSWORD}`;
		docker(["exec", "-d", options.container, "setsid", "sh", "-c", launch]);
		launched = true;

		const deadline = Date.now() + 30_000;
		let output;
		while (Date.now() < deadline) {
			try {
				output = docker(["exec", options.container, "node", `${REMOTE_ROOT}/reload-meter.cjs`, RCON_PORT, RCON_PASSWORD]);
				break;
			} catch (error) {
				const detail = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
				if (!detail.includes("ECONNREFUSED")) throw error;
				await sleep(500);
			}
		}
		if (!output) throw new Error("isolated Factorio RCON did not become ready within 30 seconds");
		const result = JSON.parse(output);
		assertReloadReading(result.reading);
		console.log(JSON.stringify({ status: "PASS", save: options.save, ...result }, null, 2));
	} finally {
		if (launched) {
			try {
				const pid = docker(["exec", options.container, "cat", `${REMOTE_ROOT}/verifier.pid`]).trim();
				if (!/^\d+$/.test(pid)) throw new Error(`invalid verifier pid ${pid}`);
				try { docker(["exec", options.container, "kill", "-TERM", `-${pid}`]); } catch { /* Meter normally quits first. */ }
			} catch { /* Launch may have failed before writing its pid. */ }
		}
		await sleep(500);
		docker(["exec", options.container, "rm", "-rf", "--", REMOTE_ROOT]);
		docker(["exec", options.container, "test", "!", "-e", REMOTE_ROOT]);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}
