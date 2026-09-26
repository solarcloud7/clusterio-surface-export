#!/usr/bin/env node
// requires: Node 20+
// produces: the gateway's equirectangular backdrop textures in the gateway mod's graphics/space directory
// does not: build the mod ZIP, sync clients or prove how the engine renders the backdrop

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { encodePng } from "./downscale-icon.mjs";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, "../../docker/seed-data/mods-src/surfexp_gateways/graphics/space");
const WIDTH = 2048;
const HEIGHT = 1024;

function hash(x, y, z, seed) {
	let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function smooth(t) {
	return t * t * (3 - 2 * t);
}

function valueNoise(x, y, z, seed) {
	const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
	const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
	const lerp = (a, b, t) => a + (b - a) * t;
	const corner = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz, seed);
	return lerp(
		lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), xf), lerp(corner(0, 1, 0), corner(1, 1, 0), xf), yf),
		lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), xf), lerp(corner(0, 1, 1), corner(1, 1, 1), xf), yf),
		zf,
	);
}

function fbm(x, y, z, seed, octaves) {
	let sum = 0, amplitude = 0.5, frequency = 1, total = 0;
	for (let i = 0; i < octaves; i++) {
		sum += amplitude * valueNoise(x * frequency, y * frequency, z * frequency, seed + i);
		total += amplitude;
		amplitude *= 0.5;
		frequency *= 2.03;
	}
	return sum / total;
}

const RIM_LIGHTS = 12;

function sample(u, v) {
	const lon = u * 2 * Math.PI;
	const lat = (0.5 - v) * Math.PI;
	const px = Math.cos(lat) * Math.cos(lon), py = Math.cos(lat) * Math.sin(lon), pz = Math.sin(lat);
	const r = Math.cos(Math.abs(lat));
	const fraction = value => value - Math.floor(value);

	const grime = fbm(px * 14, py * 14, pz * 14, 17, 3);
	const plates = fbm(px * 3 + 11, py * 3 + 7, pz * 3 + 5, 3, 4);
	const vein = 1 - Math.abs(2 * fbm(px * 6 + 31, py * 6 + 29, pz * 6 + 23, 41, 5) - 1);

	let surface, emission, reflectivity;
	if (r < 0.7) {
		const depth = Math.max(0, Math.min(1, (r - 0.06) / 0.64));
		const spiral = Math.pow(0.5 + 0.5 * Math.cos(7 * lon + 9 * Math.log(Math.max(r, 0.02))), 10);
		const web = Math.pow(vein, 22) * 1.2;
		const glow = Math.min(1, (spiral * 0.9 + web) * depth + Math.pow(Math.max(0, (r - 0.6) / 0.1), 3));
		const core = 1 - depth;
		surface = [18 + 30 * depth, 8 + 12 * depth, 40 + 60 * depth];
		emission = [150 * glow + 60 * glow * glow, 70 * glow + 60 * glow * glow, 255 * glow];
		emission = emission.map(value => value * (1 - core * 0.85));
		reflectivity = 30;
	} else if (r < 0.84) {
		const band = (r - 0.7) / 0.14;
		const metal = 58 + plates * 30 + grime * 16 - (Math.abs(band - 0.5) > 0.44 ? 22 : 0);
		surface = [metal * 1.05, metal * 0.95, metal * 0.85];
		const light = Math.abs(fraction(lon / (2 * Math.PI) * RIM_LIGHTS) - 0.5) < 0.035 && Math.abs(band - 0.5) < 0.12 ? 1 : 0;
		emission = [255 * light, 140 * light, 40 * light];
		reflectivity = 110 + plates * 60;
	} else {
		const seam = Math.abs(fraction(u * 48) - 0.5) > 0.46 ? 1 : 0;
		const metal = 30 + plates * 24 + grime * 10 - seam * 12;
		surface = [metal * 0.95, metal * 0.9, metal * 1.05];
		emission = [0, 0, 0];
		reflectivity = seam ? 20 : 60;
	}
	return {surface, emission, reflectivity};
}

function render() {
	const surface = Buffer.alloc(WIDTH * HEIGHT * 4);
	const emission = Buffer.alloc(WIDTH * HEIGHT * 4);
	const reflectivity = Buffer.alloc(WIDTH * HEIGHT * 4);
	const normal = Buffer.alloc(WIDTH * HEIGHT * 4);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const i = (y * WIDTH + x) * 4;
			const texel = sample((x + 0.5) / WIDTH, (y + 0.5) / HEIGHT);
			for (let c = 0; c < 3; c++) {
				surface[i + c] = Math.max(0, Math.min(255, Math.round(texel.surface[c])));
				emission[i + c] = Math.max(0, Math.min(255, Math.round(texel.emission[c])));
				reflectivity[i + c] = Math.round(texel.reflectivity);
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
	const textures = render();
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
