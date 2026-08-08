#!/usr/bin/env node
/**
 * Every bundled image in web/assets must still match what its source art derives to.
 *
 * WHY THIS EXISTS: `web/assets/gateway-hub-128.png` is a SECOND COPY of art whose source of truth is
 * the surfexp_gateways mod. The web bundle needs it because Factorio's spritesheet only carries a
 * 32x32 atlas cell per space-location, which is a 4.7x upscale at node size — but a second copy that
 * nothing checks goes stale silently, and the failure mode is the canvas showing last month's art
 * with no error anywhere.
 *
 * The README next to the asset said "re-run the command whenever the art changes", which is a
 * request to remember rather than a check. This is the check.
 *
 * It re-derives from source IN MEMORY and demands byte equality, which is legitimate here precisely
 * because the committed file was produced by this same code path — unlike downscale-icon's
 * `--verify`, which compares against art made by an unknown external tool and therefore allows a
 * measured tolerance.
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { decodePng, downscale, encodePng } from "../../../../../tools/surface-export/downscale-icon.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const REPO = path.resolve(PLUGIN, "../../../..");

/**
 * Bundled asset -> the art it is derived from, and how.
 *
 * A new bundled image MUST be added here. That is the point: an unlisted file in web/assets is
 * reported as unchecked rather than silently trusted, so the guard cannot quietly cover less than
 * the directory it claims to cover.
 */
const DERIVED = [
	{
		asset: "web/assets/gateway-hub-128.png",
		source: "docker/seed-data/mods-src/surfexp_gateways/graphics/icons/starmap-gateway-hub.png",
		factor: 4,
	},
];

function fail(message) {
	console.error(`lint:derived-art — FAILED: ${message}`);
	process.exit(1);
}

const assetDir = path.join(PLUGIN, "web/assets");
const present = fs.existsSync(assetDir)
	? fs.readdirSync(assetDir).filter(name => /\.(png|svg|jpe?g|gif|webp)$/i.test(name))
	: [];
const declared = new Set(DERIVED.map(entry => path.basename(entry.asset)));
const unchecked = present.filter(name => !declared.has(name));
if (unchecked.length) {
	fail(`web/assets holds image(s) this guard does not cover: ${unchecked.join(", ")}. `
		+ "Add them to DERIVED (with their source art) so drift is caught.");
}

for (const entry of DERIVED) {
	const assetPath = path.join(PLUGIN, entry.asset);
	const sourcePath = path.join(REPO, entry.source);
	if (!fs.existsSync(assetPath)) {
		fail(`${entry.asset} is missing`);
	}
	if (!fs.existsSync(sourcePath)) {
		fail(`${entry.asset} declares a source that does not exist: ${entry.source}`);
	}

	const reduced = downscale(decodePng(fs.readFileSync(sourcePath), sourcePath), entry.factor);
	const expected = encodePng(reduced.width, reduced.height, reduced.pixels);
	const actual = fs.readFileSync(assetPath);

	if (!expected.equals(actual)) {
		fail(
			`${entry.asset} is STALE — it no longer matches ${entry.source} reduced by ${entry.factor}x.\n`
			+ "         Regenerate it:\n"
			+ `           node tools/surface-export/downscale-icon.mjs \\\n`
			+ `             ${entry.source} \\\n`
			+ `             docker/seed-data/external_plugins/surface_export/${entry.asset} --factor=${entry.factor}`,
		);
	}
}

console.log(`lint:derived-art — OK (${DERIVED.length} bundled image(s) match their source art)`);
