// requires: Docker with the development controller container; tools/clusterio/remote-clusters.local.json naming each remote cluster's controller URL and a control token, token file or copied control config
// produces: a cluster transport whose clusterioctl calls reach the named controller
// does not: print or log the token, echo configuration content in errors, keep it anywhere but the ignored local file and a mode-600 temporary file that one container shell creates and removes (also on interrupt), or authorize state changes
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { CONTROLLER, createClusterTransport } from "./cluster-transport.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
export const REMOTE_CLUSTERS_FILE = path.resolve(HERE, "../clusterio/remote-clusters.local.json");
export const DEVELOPMENT = "dev";

export function readRemoteCluster(name, { file = REMOTE_CLUSTERS_FILE, read = readFileSync, exists = existsSync } = {}) {
	const shown = path.relative(process.cwd(), file) || file;
	if (!exists(file)) {
		throw new Error(`${shown} is missing. Create it with {"${name}": {"url": "https://controller.example/", "controlConfig": "C:/path/to/config-control.json"}}; it is ignored by git.`);
	}
	let clusters;
	try { clusters = JSON.parse(read(file, "utf8")); }
	catch (error) { throw new Error(`${shown} is not valid JSON`, { cause: error }); }
	const entry = clusters?.[name];
	if (!entry || typeof entry !== "object") {
		throw new Error(`No cluster "${name}" in ${shown}. Known: ${Object.keys(clusters || {}).join(", ") || "none"}`);
	}
	if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) {
		throw new Error(`Cluster "${name}" needs an http(s) "url" in ${shown}`);
	}
	let token = entry.token;
	if (token === undefined && typeof entry.tokenFile === "string") {
		if (!exists(entry.tokenFile)) throw new Error(`Cluster "${name}" tokenFile does not exist: ${entry.tokenFile}`);
		token = read(entry.tokenFile, "utf8").replace(/^﻿/, "").trim();
	}
	if (token === undefined && typeof entry.controlConfig === "string") {
		if (!exists(entry.controlConfig)) throw new Error(`Cluster "${name}" controlConfig does not exist: ${entry.controlConfig}`);
		let control;
		try { control = JSON.parse(read(entry.controlConfig, "utf8").replace(/^﻿/, "")); }
		catch (error) { throw new Error(`Cluster "${name}" controlConfig is not valid JSON`, { cause: error }); }
		token = control?.["control.controller_token"];
	}
	if (typeof token !== "string" || token.length === 0) {
		throw new Error(`Cluster "${name}" needs a "token", "tokenFile" or "controlConfig" in ${shown}`);
	}
	return { url: entry.url, token };
}

export const REMOTE_CONFIG_PLACEHOLDER = "<remote-control-config>";
export const REMOTE_SCRIPT = "umask 077; f=$(mktemp) || exit 1; trap 'rm -f \"$f\"' EXIT INT TERM HUP; "
	+ "cat > \"$f\" && npx clusterioctl --log-level error --config \"$f\" \"$@\"";

export function remoteExec(exec, controller, config) {
	return (program, args, options = {}) => {
		const configIndex = args.indexOf(REMOTE_CONFIG_PLACEHOLDER);
		if (program !== "docker" || args[0] !== "exec" || configIndex < 0) return exec(program, args, options);
		const rest = args.slice(configIndex + 1);
		return exec("docker", ["exec", "-i", controller, "sh", "-c", REMOTE_SCRIPT, "sh", ...rest],
			{ ...options, input: config, stdio: ["pipe", "pipe", "pipe"] });
	};
}

export async function withCluster(name, fn, { exec = execFileSync, controller = CONTROLLER, read } = {}) {
	if (name === DEVELOPMENT) return await fn(createClusterTransport({ controller, exec }));
	const { url: controllerUrl, token } = readRemoteCluster(name, read ? { read, exists: () => true } : undefined);
	const config = JSON.stringify({
		"control.controller_url": controllerUrl,
		"control.controller_token": token,
		"control.max_reconnect_delay": 60,
	});
	return await fn(createClusterTransport({ controller, config: REMOTE_CONFIG_PLACEHOLDER, hosts: {}, exec: remoteExec(exec, controller, config) }));
}

export function parseInstanceList(output) {
	const lines = String(output).split(/\r?\n/).filter(line => line.includes("|"));
	const header = lines.shift()?.split("|").map(cell => cell.trim());
	if (!header?.includes("name") || !header.includes("status")) return [];
	return lines.filter(line => !/^[-\s|]+$/.test(line)).map(line => {
		const cells = line.split("|").map(cell => cell.trim());
		return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
	}).filter(row => row.name);
}
