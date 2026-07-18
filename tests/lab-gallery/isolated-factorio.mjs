// Shared isolated-Factorio launch/teardown primitives for the lab-gallery drivers
// (build-save.mjs, verify-save.mjs, seed-prep.mjs). Extracted so every driver uses ONE
// implementation of the container lifecycle: exclusive remote root, pid-group launch,
// stdout capture, kill + rm -rf + zero-leftover proof at teardown.

import { execFileSync } from "node:child_process";

export function docker(arguments_, options = {}) {
	return execFileSync("docker", arguments_, {
		encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], ...options,
	});
}

export function sleep(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export const FACTORIO_BINARY = "/opt/factorio/2.0.77/bin/x64/factorio";
export const MOD_DIRECTORY = "/clusterio/data/instances/clusterio-host-2-instance-1/mods";

/**
 * Launch a bounded, detached headless Factorio on `seed` inside `container`.
 * The remote root must NOT pre-exist (exclusive-lease guard). `files` is a list of
 * [localPath, remoteName] extras (driver scripts, runtime Lua, config).
 * Returns a handle for teardownIsolatedFactorio.
 */
export function launchIsolatedFactorio({
	container, remoteRoot, seed, config, files = [],
	gamePort, rconPort, rconPassword, timeoutSeconds = 300,
}) {
	docker(["exec", container, "test", "!", "-e", remoteRoot]);
	docker(["exec", container, "mkdir", "-p", `${remoteRoot}/saves`]);
	for (const [source, destination] of [[seed, "seed.zip"], [config, "config.ini"], ...files]) {
		docker(["cp", source, `${container}:${remoteRoot}/${destination}`], { timeout: 180_000 });
	}
	const launch =
		`echo $$ > ${remoteRoot}/factorio.pid; ` +
		`exec timeout ${timeoutSeconds} ${FACTORIO_BINARY} --start-server ${remoteRoot}/seed.zip ` +
		`--config ${remoteRoot}/config.ini --mod-directory ${MOD_DIRECTORY} ` +
		`--port ${gamePort} --rcon-port ${rconPort} --rcon-password ${rconPassword} ` +
		`> ${remoteRoot}/factorio-stdout.log 2>&1`;
	docker(["exec", "-d", container, "setsid", "sh", "-c", launch]);
	return { container, remoteRoot };
}

/** Tail the isolated Factorio's stdout for failure diagnostics. */
export function tailFactorioLog({ container, remoteRoot }, lines = 120) {
	return docker(["exec", container, "tail", "-n", String(lines), `${remoteRoot}/factorio-stdout.log`]);
}

/**
 * Kill the launched process group, remove the remote root, and PROVE zero leftovers.
 * Collects boundary problems into `boundaryErrors` instead of masking the primary error.
 */
export async function teardownIsolatedFactorio(handle, boundaryErrors = []) {
	const { container, remoteRoot } = handle;
	try {
		const pid = docker(["exec", container, "cat", `${remoteRoot}/factorio.pid`]).trim();
		if (/^\d+$/.test(pid)) {
			// Shell form with `--` — a bare exec of `kill -TERM -<pid>` lets the kill binary parse
			// the negative pgid as an option and silently strand the process group (measured: a
			// stray isolated Factorio survived teardown and answered the next launch's RCON port).
			try { docker(["exec", container, "sh", "-c", `kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid}`]); } catch { /* bounded process may have exited */ }
			// PROVE death before removing the root: a survivor holding the port poisons the next
			// launch far more subtly than a failed teardown does.
			const deadline = Date.now() + 15_000;
			let alive = true;
			while (alive && Date.now() < deadline) {
				await sleep(500);
				const state = docker(["exec", container, "sh", "-c",
					`[ -d /proc/${pid} ] && awk '/^State:/{print $2}' /proc/${pid}/status || echo gone`]).trim();
				alive = state !== "gone" && state !== "Z";
			}
			if (alive) {
				docker(["exec", container, "sh", "-c", `kill -KILL -- -${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null; true`]);
				boundaryErrors.push(new Error(`isolated Factorio pgid ${pid} required SIGKILL at teardown`));
			}
		} else {
			boundaryErrors.push(new Error(`isolated Factorio pid file is invalid: ${JSON.stringify(pid)}`));
		}
	} catch (error) {
		boundaryErrors.push(new Error(`isolated Factorio pid unreadable (launch may have died early): ${error.message}`));
	}
	await sleep(500);
	docker(["exec", container, "rm", "-rf", "--", remoteRoot]);
	// Zero-leftover proof: a survived Factorio recreating its write-data after rm -rf must fail
	// HERE, not poison the next launch's exclusive-lease guard.
	docker(["exec", container, "test", "!", "-e", remoteRoot]);
}

/** Wait until the remote save file exists and its size stops changing. */
export async function waitForStableSave(container, remotePath, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let previous = null;
	do {
		try {
			const size = Number(docker(["exec", container, "stat", "-c", "%s", remotePath]).trim());
			if (size > 0 && size === previous) return size;
			previous = size;
		} catch { previous = null; }
		await sleep(500);
	} while (Date.now() < deadline);
	throw new Error(`save did not stabilize at ${remotePath}`);
}

/**
 * Invoke a runtime Lua file (runtime-driver.cjs protocol) against the isolated server,
 * tolerating connection-refused while the server boots.
 */
export function runtimeCall({ container, remoteRoot }, { rconPort, rconPassword }, request) {
	const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
	const output = docker(
		["exec", container, "node", `${remoteRoot}/runtime-driver.cjs`, rconPort, rconPassword, `${remoteRoot}/ops.lua`, encoded],
		{ timeout: 180_000 },
	);
	return JSON.parse(output.trim().split(/\r?\n/).filter(Boolean).at(-1));
}

export async function waitForRuntime(handle, ports, request, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let lastError;
	do {
		try { return runtimeCall(handle, ports, request); }
		catch (error) {
			lastError = error;
			const detail = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
			if (!detail.includes("ECONNREFUSED") && !detail.includes("ECONNRESET")) throw error;
			await sleep(500);
		}
	} while (Date.now() < deadline);
	throw new Error(`isolated Factorio RCON did not become ready: ${lastError?.message}`);
}
