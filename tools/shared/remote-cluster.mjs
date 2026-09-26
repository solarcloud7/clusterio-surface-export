// requires: Docker with the development controller container; tools/clusterio/remote-clusters.local.json naming each remote cluster's controller URL and control token (or token file)
// produces: a cluster transport whose clusterioctl calls reach the named controller
// does not: print or log the token, keep it anywhere but the ignored local file and a mode-600 temporary file removed after each use, or authorize state changes
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
		throw new Error(`${shown} is missing. Create it with {"${name}": {"url": "https://controller.example/", "tokenFile": "C:/path/to/token.txt"}}; it is ignored by git.`);
	}
	let clusters;
	try { clusters = JSON.parse(read(file, "utf8")); }
	catch (error) { throw new Error(`${shown} is not valid JSON: ${error.message}`); }
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
		token = read(entry.tokenFile, "utf8").trim();
	}
	if (typeof token !== "string" || token.length === 0) {
		throw new Error(`Cluster "${name}" needs a "token" or "tokenFile" in ${shown}`);
	}
	return { url: entry.url, token };
}

export async function withCluster(name, fn, { exec = execFileSync, controller = CONTROLLER, read } = {}) {
	if (name === DEVELOPMENT) return await fn(createClusterTransport({ controller, exec }));
	const { url: controllerUrl, token } = readRemoteCluster(name, read ? { read, exists: () => true } : undefined);
	const file = `/tmp/remote-${name.replace(/[^A-Za-z0-9_-]/g, "_")}-${randomUUID()}.json`;
	const config = JSON.stringify({
		"control.controller_url": controllerUrl,
		"control.controller_token": token,
		"control.max_reconnect_delay": 60,
	});
	exec("docker", ["exec", "-i", controller, "sh", "-c", `umask 077 && cat > ${file}`],
		{ input: config, stdio: ["pipe", "ignore", "pipe"], timeout: 60_000 });
	try {
		return await fn(createClusterTransport({ controller, config: file, hosts: {}, exec }));
	} finally {
		exec("docker", ["exec", controller, "rm", "-f", file], { stdio: "ignore", timeout: 60_000 });
	}
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
