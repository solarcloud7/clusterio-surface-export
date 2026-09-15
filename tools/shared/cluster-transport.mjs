// requires: a reachable Clusterio controller container and configured instances
// produces: bounded CLI/RCON responses without retries
// does not: grant platform ownership or manage Docker resource lifecycles
import { execFileSync } from "node:child_process";
import { seededHosts } from "./seeded-instances.mjs";

export const CONTROLLER = "surface-export-controller";
export const CTL_CONFIG = "/clusterio/tokens/config-control.json";
export const HOSTS = seededHosts();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const lastLine = value => String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";

export function createClusterTransport({ controller = CONTROLLER, config = CTL_CONFIG, hosts = HOSTS,
	exec = execFileSync, dockerTimeoutMs = 60_000, requestTimeoutMs = 180_000,
	maxBufferBytes = 32 * 1024 * 1024 } = {}) {
	const docker = (args, options = {}) => exec("docker", args, {
		encoding: "utf8", timeout: dockerTimeoutMs, stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: maxBufferBytes, ...options,
	});
	const request = (args, options = {}) => docker(["exec", controller, "npx", "clusterioctl",
		"--log-level", "error", "--config", config, ...args], { timeout: requestTimeoutMs, ...options });
	const instance = host => {
		if (Object.hasOwn(hosts, host)) return hosts[host].instance;
		if (typeof host === "string" && host.length) return host;
		throw new Error(`Unknown host ${host}`);
	};
	const ctl = (...args) => request(args);
	const rcon = (host, command, options) => request(["instance", "send-rcon", instance(host), command], options).trim();
	const lua = (host, body, options) => {
		const command = `/sc local ok,result=pcall(function() ${body} end); `
			+ "if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end";
		const raw = lastLine(rcon(host, command, options));
		try { return JSON.parse(raw); }
		catch (error) { throw new Error(`Invalid Lua JSON from ${instance(host)}: ${raw.slice(0, 500)} (${error.message})`); }
	};
	const luaTable = (host, body, options) => lua(host, `local out={} local function apply() ${body} end apply() return out`, options);
	const instanceIds = () => Object.fromEntries(Object.entries(hosts).map(([host, { instance: name }]) => {
		const out = ctl("instance", "save", "list", name);
		for (const line of out.split(/\r?\n/)) {
			const id = Number(line.match(/^\s*(\d+)\s*\|/)?.[1]);
			if (Number.isSafeInteger(id) && id > 0) return [host, id];
		}
		throw new Error(`Could not resolve instance ID for ${name}`);
	}));
	return { docker, ctl, rcon, lua, luaTable, instanceIds, sleep };
}

export const developmentCluster = createClusterTransport();
