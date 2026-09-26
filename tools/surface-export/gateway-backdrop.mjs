#!/usr/bin/env node
// requires: Node 20+, docs/icons/portal512.png
// produces: the gateway's equirectangular backdrop textures in the gateway mod's graphics/space directory
// does not: build the mod ZIP, sync clients or prove how the engine renders the backdrop

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { decodePng, encodePng } from "./downscale-icon.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ART = path.join(REPO, "docs/icons/portal512.png");
const OUT_DIR = path.join(REPO, "docker/seed-data/mods-src/surfexp_gateways/graphics/space");
const WIDTH = 2048;
const HEIGHT = 1024;
const DISC = 0.86;
const BACKGROUND = [26, 22, 30];

function clamp(value) {
	return Math.max(0, Math.min(1, value));
}

function sampler(art) {
	return (x, y) => {
		const ix = Math.max(0, Math.min(art.width - 1, Math.round(x)));
		const iy = Math.max(0, Math.min(art.height - 1, Math.round(y)));
		const i = (iy * art.width + ix) * 4;
		return [art.pixels[i], art.pixels[i + 1], art.pixels[i + 2], art.pixels[i + 3] / 255];
	};
}

function render(art) {
	const sample = sampler(art);
	const half = art.width / 2;
	const surface = Buffer.alloc(WIDTH * HEIGHT * 4);
	const emission = Buffer.alloc(WIDTH * HEIGHT * 4);
	const reflectivity = Buffer.alloc(WIDTH * HEIGHT * 4);
	const normal = Buffer.alloc(WIDTH * HEIGHT * 4);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const lon = ((x + 0.5) / WIDTH) * 2 * Math.PI;
			const lat = (0.5 - (y + 0.5) / HEIGHT) * Math.PI;
			const radius = Math.cos(lat);
			const px = radius * Math.cos(lon);
			const py = radius * Math.sin(lon) * (lat < 0 ? -1 : 1);
			const i = (y * WIDTH + x) * 4;
			let colour = BACKGROUND;
			let glow = [0, 0, 0];
			let shine = 40;
			if (radius < DISC) {
				const [r, g, b, a] = sample(half + (px / DISC) * half, half + (py / DISC) * half);
				colour = [r * a + BACKGROUND[0] * (1 - a), g * a + BACKGROUND[1] * (1 - a), b * a + BACKGROUND[2] * (1 - a)];
				const violet = clamp((b - Math.max(r, g) * 1.1) / 80) * a;
				const lamp = clamp((r - 180) / 60) * clamp((g - 80) / 60) * clamp((110 - b) / 60) * a;
				const weight = Math.max(violet, lamp);
				glow = [r * weight, g * weight, b * weight];
				shine = 40 + 100 * a * (1 - violet);
			}
			for (let c = 0; c < 3; c++) {
				surface[i + c] = Math.round(colour[c]);
				emission[i + c] = Math.round(glow[c]);
				reflectivity[i + c] = Math.round(shine);
			}
			normal[i] = 128;
			normal[i + 1] = 128;
			normal[i + 2] = 255;
			surface[i + 3] = emission[i + 3] = reflectivity[i + 3] = normal[i + 3] = 255;
		}
	}
	return { surface, emission, reflectivity, normal };
}

function main() {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	const textures = render(decodePng(fs.readFileSync(ART), ART));
	for (const [name, pixels] of Object.entries(textures)) {
		const file = path.join(OUT_DIR, `gateway-${name}.png`);
		fs.writeFileSync(file, encodePng(WIDTH, HEIGHT, pixels));
		console.log(`${path.relative(process.cwd(), file)} ${WIDTH}x${HEIGHT} ${fs.statSync(file).size} bytes`);
	}
	return 0;
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exit(main());
}
