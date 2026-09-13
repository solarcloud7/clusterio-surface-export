import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import webpack from "webpack";
import configure from "../webpack.config.js";
import { publishWebAssets } from "./web-assets.mjs";

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildWeb({ destination = join(pluginDir, "dist/web"), config = configure({}, { mode: "production" }) } = {}) {
	const dist = join(pluginDir, "dist");
	await mkdir(dist, { recursive: true });
	const staging = await mkdtemp(join(dist, "web-build-"));
	try {
		const compiler = webpack({ ...config, output: { ...config.output, path: staging } });
		try {
			const stats = await new Promise((resolveBuild, reject) => compiler.run((error, result) => {
				if (error) reject(error);
				else if (result.hasErrors()) reject(new Error(result.toString({ all: false, errors: true })));
				else resolveBuild(result);
			}));
			console.log(stats.toString({ colors: false, all: false, timings: true, warnings: true }));
		} finally {
			await new Promise((resolveClose, reject) => compiler.close(error => error ? reject(error) : resolveClose()));
		}
		return await publishWebAssets(staging, destination);
	} finally {
		if (dirname(staging) !== dist || !staging.startsWith(dist + sep + "web-build-")) throw new Error("Invalid web staging directory");
		await rm(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildWeb();
