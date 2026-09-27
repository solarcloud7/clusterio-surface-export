// requires: a reachable Clusterio controller container and one instance assigned to each seeded host
// produces: bounded CLI/RCON responses without retries, addressed by the instance ID assigned to each host,
//           and each instance's host data directory matched by instance.id
// does not: grant platform ownership, manage Docker resource lifecycles, or address instances by seed name
import { execFileSync } from "node:child_process";
import { createInstanceResolver, INSTANCE_DIRS_SCRIPT } from "./cluster-instances.mjs";
import { seededHosts } from "./seeded-instances.mjs";

export const CONTROLLER = "surface-export-controller";
export const CTL_CONFIG = "/clusterio/tokens/config-control.json";
export const HOSTS = seededHosts();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const lastLine = value => String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";

export function createClusterTransport({ controller = CONTROLLER, config = CTL_CONFIG, hosts = HOSTS,
	exec = execFileSync, dockerTimeoutMs = 60_000, requestTimeoutMs = 180_000,
	maxBufferBytes = 32 * 1024 * 1024, instances } = {}) {
	const docker = (args, options = {}) => exec("docker", args, {
		encoding: "utf8", timeout: dockerTimeoutMs, stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: maxBufferBytes, ...options,
	});
	const request = (args, options = {}) => docker(["exec", controller, "npx", "clusterioctl",
		"--log-level", "error", "--config", config, ...args], { timeout: requestTimeoutMs, ...options });
	const ctl = (...args) => request(args);
	const resolver = instances ?? createInstanceResolver({ hosts, list: () => ctl("instance", "list"),
		readDirs: container => docker(["exec", container, "sh", "-c", INSTANCE_DIRS_SCRIPT]) });
	const locate = (host, { override } = {}) => {
		if (override !== undefined && override !== null && override !== "") return resolver.byNameOrId(override);
		if (Object.hasOwn(hosts, host)) return resolver.forHost(Number(host));
		throw new Error(`Unknown host ${host}`);
	};
	const instance = host => {
		if (Object.hasOwn(hosts, host)) return String(locate(host).id);
		if (typeof host === "string" && host.length) return host;
		throw new Error(`Unknown host ${host}`);
	};
	const instanceName = host => locate(host).name;
	const instanceDir = host => resolver.dataDir(typeof host === "object" ? host : locate(host));
	const rcon = (host, command, options) => request(["instance", "send-rcon", instance(host), command], options).trim();
	const lua = (host, body, options) => {
		const command = `/sc local ok,result=pcall(function() ${body} end); `
			+ "if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end";
		const raw = lastLine(rcon(host, command, options));
		try { return JSON.parse(raw); }
		catch (error) { throw new Error(`Invalid Lua JSON from ${instance(host)}: ${raw.slice(0, 500)} (${error.message})`); }
	};
	const luaTable = (host, body, options) => lua(host, `local out={} local function apply() ${body} end apply() return out`, options);
	const instanceIds = () => Object.fromEntries(Object.keys(hosts).map(host => [host, locate(host).id]));
	return { docker, ctl, rcon, lua, luaTable, locate, instance, instanceName, instanceDir, instanceIds, sleep };
}

export const developmentCluster = createClusterTransport();
