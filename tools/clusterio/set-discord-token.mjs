#!/usr/bin/env node
// requires: DISCORD_BOT_TOKEN (and optionally DISCORD_CHANNEL_ID) in the repository .env; a reachable cluster (dev, or a remote named in tools/clusterio/remote-clusters.local.json) running the discord_bridge plugin
// produces: discord_bridge.bot_token (and discord_bridge.channel_id when DISCORD_CHANNEL_ID is set) on that cluster's controller; prints only the token length and the outcome
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

export async function main(argv, { out = process.stdout, err = process.stderr, envText, run = withCluster } = {}) {
	const index = argv.indexOf("--cluster");
	const cluster = index >= 0 ? argv[index + 1] : DEVELOPMENT;
	if (!cluster) { err.write(`${USAGE}\n`); return 2; }
	let text = envText;
	if (text === undefined) {
		try { text = readFileSync(ENV_FILE, "utf8"); }
		catch (error) { err.write(`cannot read ${ENV_FILE}: ${error.code || error.message}\n`); return 2; }
	}
	const token = readEnvValue(text, "DISCORD_BOT_TOKEN");
	if (!token) { err.write("DISCORD_BOT_TOKEN is not set in .env\n"); return 2; }
	const channel = readEnvValue(text, "DISCORD_CHANNEL_ID");
	if (channel !== null && !/^\d+$/.test(channel)) { err.write("DISCORD_CHANNEL_ID must be the channel's numeric id\n"); return 2; }
	try {
		await run(cluster, transport => {
			transport.ctl("controller", "config", "set", "discord_bridge.bot_token", token);
			if (channel) transport.ctl("controller", "config", "set", "discord_bridge.channel_id", channel);
		});
	} catch (error) {
		err.write(`setting the Discord bridge on ${cluster} failed: ${scrub(error?.stderr || error?.message || error, token).trim()}\n`);
		return 1;
	}
	out.write(`discord_bridge.bot_token set on ${cluster} (length ${token.length})${channel ? `; channel_id ${channel}` : ""}\n`);
	return 0;
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
