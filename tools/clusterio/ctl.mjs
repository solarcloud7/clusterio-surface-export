#!/usr/bin/env node
// requires: Docker with the development controller container; for --cluster <name> other than dev, an entry in tools/clusterio/remote-clusters.local.json
// produces: clusterioctl output from the development cluster or a named remote cluster
// does not: run a command outside the read-only list unless --write is given, print tokens, or bypass the controller's own permissions
import url from "node:url";
import { DEVELOPMENT, withCluster } from "../shared/remote-cluster.mjs";

const READ_ONLY = [
	["instance", "list"],
	["instance", "config", "list"],
	["instance", "config", "get"],
	["instance", "save", "list"],
	["host", "list"],
	["mod-pack", "list"],
	["mod-pack", "show"],
	["mod", "list"],
	["mod", "show"],
	["controller", "config", "list"],
	["user", "list"],
	["user", "show"],
	["role", "list"],
];

export function isReadOnly(args) {
	return READ_ONLY.some(prefix => prefix.every((word, index) => args[index] === word));
}

export function parseArgs(argv) {
	const options = { cluster: DEVELOPMENT, write: false, help: false, args: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (options.args.length === 0 && arg === "--cluster") options.cluster = argv[++index];
		else if (options.args.length === 0 && arg.startsWith("--cluster=")) options.cluster = arg.slice("--cluster=".length);
		else if (options.args.length === 0 && arg === "--write") options.write = true;
		else if (options.args.length === 0 && (arg === "--help" || arg === "-h")) options.help = true;
		else options.args.push(arg);
	}
	if (!options.cluster) throw new Error("--cluster needs a name");
	return options;
}

const USAGE = `usage: node tools/clusterio/ctl.mjs [--cluster dev|<name>] [--write] <clusterioctl arguments>

Runs clusterioctl against the development cluster (default) or a remote cluster listed in
tools/clusterio/remote-clusters.local.json. Without --write only these are allowed:
${READ_ONLY.map(words => `  ${words.join(" ")}`).join("\n")}`;

export async function main(argv, { run = withCluster, out = process.stdout, err = process.stderr } = {}) {
	let options;
	try { options = parseArgs(argv); }
	catch (error) { err.write(`${error.message}\n${USAGE}\n`); return 2; }
	if (options.help || options.args.length === 0) { out.write(`${USAGE}\n`); return options.help ? 0 : 2; }
	if (!options.write && !isReadOnly(options.args)) {
		err.write(`Refusing "${options.args.slice(0, 3).join(" ")}" without --write: it is not on the read-only list.\n`);
		return 2;
	}
	try {
		const output = await run(options.cluster, transport => transport.ctl(...options.args));
		out.write(output.endsWith("\n") ? output : `${output}\n`);
		return 0;
	} catch (error) {
		err.write(`${options.cluster}: ${String(error.stderr || error.message).trim()}\n`);
		return 1;
	}
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
