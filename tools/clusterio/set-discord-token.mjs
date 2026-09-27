#!/usr/bin/env node
// requires: DISCORD_BOT_TOKEN (and optionally DISCORD_CHANNEL_ID or DISCORD_CHANNEL) in the repository .env; a reachable cluster (dev, or a remote named in tools/clusterio/remote-clusters.local.json) running the discord_bridge plugin
// produces: discord_bridge.bot_token (and discord_bridge.channel_id when a channel is set) on that cluster's controller; prints only the token length and the outcome
// does not: print, log or copy the token anywhere else, create the Discord bot, or check that Discord accepts the token
import { readFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import { DEVELOPMENT, withCluster } from "../shared/remote-cluster.mjs";

const ENV_FILE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", ".env");

export function readEnvValue(text, key) {
	for (const line of String(text).split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!match || match[1] !== key) continue;
		const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
		return value === "" ? null : value;
	}
	return null;
}

function scrub(text, secret) {
	return String(text).split(secret).join("<redacted>");
}

const USAGE = "usage: node tools/clusterio/set-discord-token.mjs [--cluster dev|<name>]";

function report(stream, message, error, secret, code) {
	const detail = error?.stderr || error?.code || error?.message || error;
	stream.write(`${message}: ${scrub(detail, secret || "\u0000").trim()}\n`);
	return code;
}

export function parseArgs(argv) {
	const options = { cluster: DEVELOPMENT, help: false };
	let clusterGiven = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		let value;
		if (arg === "--help" || arg === "-h") { options.help = true; continue; }
		if (arg === "--cluster") value = argv[++index];
		else if (arg.startsWith("--cluster=")) value = arg.slice("--cluster=".length);
		else throw new Error(`unsupported argument: ${arg}`);
		if (clusterGiven) throw new Error("--cluster was given more than once");
		if (!value || value.startsWith("-")) throw new Error("--cluster needs a name");
		clusterGiven = true;
		options.cluster = value;
	}
	return options;
}

export async function main(argv, { out = process.stdout, err = process.stderr, envText, run = withCluster } = {}) {
	let options;
	try { options = parseArgs(argv); }
	catch (error) { return report(err, USAGE, error, null, 2); }
	if (options.help) { out.write(`${USAGE}\n`); return 0; }
	const { cluster } = options;
	let text = envText;
	if (text === undefined) {
		try { text = readFileSync(ENV_FILE, "utf8"); }
		catch (error) { return report(err, `cannot read ${ENV_FILE}`, error, null, 2); }
	}
	const token = readEnvValue(text, "DISCORD_BOT_TOKEN");
	if (!token) { err.write("DISCORD_BOT_TOKEN is not set in .env\n"); return 2; }
	const channel = readEnvValue(text, "DISCORD_CHANNEL_ID") ?? readEnvValue(text, "DISCORD_CHANNEL");
	if (channel !== null && !/^\d+$/.test(channel)) { err.write("DISCORD_CHANNEL_ID (or DISCORD_CHANNEL) must be the channel's numeric id\n"); return 2; }
	try {
		await run(cluster, transport => {
			transport.ctl("controller", "config", "set", "discord_bridge.bot_token", token);
			if (channel) transport.ctl("controller", "config", "set", "discord_bridge.channel_id", channel);
		});
	} catch (error) {
		return report(err, `setting the Discord bridge on ${cluster} failed`, error, token, 1);
	}
	out.write(`discord_bridge.bot_token set on ${cluster} (length ${token.length})${channel ? `; channel_id ${channel}` : ""}\n`);
	return 0;
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
