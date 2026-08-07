#!/usr/bin/env node
/**
 * Derive a Factorio 64px `icon` from its 512px `starmap_icon`, by the alpha-weighted area average
 * the gateway mod's README specifies.
 *
 * WHY THIS EXISTS: the four shipped `gateway-<colour>.png` files were produced out-of-band and only
 * the OUTPUTS were committed — `mods-src/surfexp_gateways/README.md` describes the method ("an exact
 * 8:1 alpha-weighted area average ... a plain non-premultiplied resize fringes the transparent rim
 * dark") but no script in the repo performed it. So the derivation was tribal knowledge that could
 * not be re-run or checked. Adding a fifth gateway forced the issue.
 *
 * WHY ALPHA-WEIGHTED: averaging raw RGB across a block treats fully transparent pixels as real
 * colour. Transparent PNG margins are usually stored as black, so a naive average drags the edge
 * toward black and the icon gets a dark halo. Weighting colour by alpha (and averaging alpha
 * separately) is the premultiplied-correct reduction.
 *
 * `--verify` is the point of the file, not a convenience: the four committed 512/64 pairs are real
 * input/output samples of the original method, so they are a ground truth this script can be checked
 * against rather than merely asserted to match.
 *
 * WHICH REDUCTION, measured 2026-08-06 against all four pairs (65,536 pixels) rather than assumed.
 * Four candidates were run, including a deliberately-wrong control so the comparison could be shown
 * to discriminate at all:
 *
 *   float alpha-weighted (this file)   max channel delta   6   4.1% of pixels differ
 *   8-bit premultiplied intermediate   max channel delta  67   5.1%
 *   linear-light (sRGB->linear->sRGB)  max channel delta  52  71.2%
 *   plain unweighted average (CONTROL) max channel delta 164   9.4%
 *
 * The control lands an order of magnitude away, so agreement here is a real signal and not a test
 * that passes on anything. The residual 6/255 on 4% of pixels is a rounding/precision artefact of
 * whatever tool produced the originals, not a different algorithm — the next-best genuine candidate
 * is eleven times worse.
 *
 * Dependency-free on purpose — Node's built-in zlib is the only thing needed, and this repo's boot
 * install prunes devDependencies, so a tool that reaches for `sharp` would work on a laptop and
 * vanish in a container.
 *
 * Handles ONLY 8-bit RGBA non-interlaced PNGs, which is what every icon in this mod is (IHDR-checked
 * for both `docs/icons/gateway512.png` and the shipped `gateway-blue.png`). Anything else exits with
 * a named error rather than guessing at a format it was never tested on.
 *
 * Usage:
 *   node tools/surface-export/downscale-icon.mjs <input.png> <output.png> [--factor 8]
 *   node tools/surface-export/downscale-icon.mjs --verify
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 4; // 8-bit RGBA, the only colour type this handles.

// ── CRC32, written out rather than taken from zlib.crc32 ────────────────────
// zlib.crc32 only exists in newer Node, and this script is meant to run wherever the repo's tooling
// runs. Twelve lines is cheaper than a version floor nobody would remember to document.
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let c = 0xffffffff;
	for (const byte of buffer) {
		c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

// ── Decode ──────────────────────────────────────────────────────────────────

/** Split a PNG into its chunks. Throws on anything that is not a PNG, rather than returning junk. */
function readChunks(buffer, label) {
	if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error(`${label}: not a PNG (bad signature)`);
	}
	const chunks = [];
	let offset = 8;
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const data = buffer.subarray(offset + 8, offset + 8 + length);
		chunks.push({ type, data });
		offset += 12 + length;
	}
	return chunks;
}

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) {
		return a;
	}
	return pb <= pc ? b : c;
}

/**
 * Reverse the per-scanline filters. All five are implemented because an encoder picks per line and
 * a decoder that only handled the common ones would silently corrupt some inputs.
 */
function unfilter(raw, width, height) {
	const stride = width * BYTES_PER_PIXEL;
	const out = Buffer.alloc(height * stride);
	let pos = 0;
	for (let y = 0; y < height; y++) {
		const filterType = raw[pos++];
		const line = raw.subarray(pos, pos + stride);
		pos += stride;
		const rowStart = y * stride;
		for (let x = 0; x < stride; x++) {
			const rawByte = line[x];
			const a = x >= BYTES_PER_PIXEL ? out[rowStart + x - BYTES_PER_PIXEL] : 0;
			const b = y > 0 ? out[rowStart - stride + x] : 0;
			const c = x >= BYTES_PER_PIXEL && y > 0 ? out[rowStart - stride + x - BYTES_PER_PIXEL] : 0;
			let value;
			switch (filterType) {
				case 0: value = rawByte; break;
				case 1: value = rawByte + a; break;
				case 2: value = rawByte + b; break;
				case 3: value = rawByte + ((a + b) >> 1); break;
				case 4: value = rawByte + paeth(a, b, c); break;
				default: throw new Error(`unsupported PNG filter type ${filterType} on row ${y}`);
			}
			out[rowStart + x] = value & 0xff;
		}
	}
	return out;
}

export function decodePng(buffer, label) {
	const chunks = readChunks(buffer, label);
	const ihdr = chunks.find(chunk => chunk.type === "IHDR");
	if (!ihdr) {
		throw new Error(`${label}: no IHDR chunk`);
	}
	const width = ihdr.data.readUInt32BE(0);
	const height = ihdr.data.readUInt32BE(4);
	const bitDepth = ihdr.data[8];
	const colourType = ihdr.data[9];
	const interlace = ihdr.data[12];

	// Refuse rather than guess: this is the one place a wrong assumption would produce a plausible
	// but wrong image, which is worse than a crash.
	if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
		throw new Error(
			`${label}: only 8-bit RGBA non-interlaced PNGs are supported `
			+ `(got bitDepth=${bitDepth}, colourType=${colourType}, interlace=${interlace})`,
		);
	}

	// A single image is routinely split across several IDAT chunks; the zlib stream spans them, so
	// they must be concatenated BEFORE inflating.
	const idat = Buffer.concat(chunks.filter(chunk => chunk.type === "IDAT").map(chunk => chunk.data));
	if (!idat.length) {
		throw new Error(`${label}: no IDAT data`);
	}
	return { width, height, pixels: unfilter(zlib.inflateSync(idat), width, height) };
}

// ── Encode ──────────────────────────────────────────────────────────────────

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData), 0);
	return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, pixels) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;  // bit depth
	ihdr[9] = 6;  // colour type: RGBA
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // interlace

	// Filter type 0 (None) on every line. Filtering exists to help compression, and at 64x64 the
	// difference is a few hundred bytes — not worth the extra decode surface in a tool whose output
	// has to be trusted.
	const stride = width * BYTES_PER_PIXEL;
	const raw = Buffer.alloc(height * (stride + 1));
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	return Buffer.concat([
		PNG_SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ── The reduction ───────────────────────────────────────────────────────────

/**
 * Average each factor x factor block, weighting colour by alpha.
 *
 * A fully transparent block has no colour to average, so it yields transparent black rather than a
 * division by zero — and because alpha is zero there, no renderer ever samples the RGB.
 */
export function downscale(source, factor) {
	const { width, height, pixels } = source;
	if (width % factor !== 0 || height % factor !== 0) {
		throw new Error(`source ${width}x${height} is not divisible by the factor ${factor}`);
	}
	const outWidth = width / factor;
	const outHeight = height / factor;
	const out = Buffer.alloc(outWidth * outHeight * BYTES_PER_PIXEL);
	const samples = factor * factor;

	for (let oy = 0; oy < outHeight; oy++) {
		for (let ox = 0; ox < outWidth; ox++) {
			let sumR = 0, sumG = 0, sumB = 0, sumA = 0;
			for (let dy = 0; dy < factor; dy++) {
				const rowStart = (oy * factor + dy) * width * BYTES_PER_PIXEL;
				for (let dx = 0; dx < factor; dx++) {
					const i = rowStart + (ox * factor + dx) * BYTES_PER_PIXEL;
					const alpha = pixels[i + 3];
					sumR += pixels[i] * alpha;
					sumG += pixels[i + 1] * alpha;
					sumB += pixels[i + 2] * alpha;
					sumA += alpha;
				}
			}
			const o = (oy * outWidth + ox) * BYTES_PER_PIXEL;
			if (sumA === 0) {
				out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
			} else {
				out[o] = Math.round(sumR / sumA);
				out[o + 1] = Math.round(sumG / sumA);
				out[o + 2] = Math.round(sumB / sumA);
				out[o + 3] = Math.round(sumA / samples);
			}
		}
	}
	return { width: outWidth, height: outHeight, pixels: out };
}

// ── Ground truth ────────────────────────────────────────────────────────────

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ICON_DIR = path.resolve(HERE, "../../docker/seed-data/mods-src/surfexp_gateways/graphics/icons");

/**
 * How far this script's output may drift from the committed icons before the method is in doubt.
 *
 * 8, not a round guess: the measured drift for the correct reduction is **6**, and the nearest wrong
 * method (8-bit premultiplied) lands at **67** — see the variant table in the file header. So
 * anything in single digits is rounding, and a genuine method change is an order of magnitude away.
 * A tighter limit would fail on art this script produced correctly; a looser one would accept the
 * 52/67 wrong answers.
 */
const AGREEMENT_LIMIT = 8;

/**
 * Compare this script's output against the four committed pairs.
 *
 * These were produced by whatever tool made the original art, so agreement is evidence the method in
 * the README is the method that was actually used. Reports the max per-channel delta rather than a
 * pass/fail on byte-identity: a delta of 1 is a rounding-mode difference on the same algorithm,
 * while a large one means the algorithm is different and any claim built on it is unfounded.
 */
function verify() {
	const colours = ["blue", "green", "orange", "purple"];
	let worst = 0;
	let failures = 0;

	for (const colour of colours) {
		const sourcePath = path.join(ICON_DIR, `starmap-gateway-${colour}.png`);
		const expectedPath = path.join(ICON_DIR, `gateway-${colour}.png`);
		if (!fs.existsSync(sourcePath) || !fs.existsSync(expectedPath)) {
			console.error(`MISSING: ${colour} — cannot verify against a pair that is not there`);
			failures += 1;
			continue;
		}
		const produced = downscale(decodePng(fs.readFileSync(sourcePath), sourcePath), 8);
		const expected = decodePng(fs.readFileSync(expectedPath), expectedPath);

		if (produced.width !== expected.width || produced.height !== expected.height) {
			console.error(`${colour}: size mismatch ${produced.width}x${produced.height} vs ${expected.width}x${expected.height}`);
			failures += 1;
			continue;
		}

		let maxDelta = 0;
		let differing = 0;
		// Compare only where the committed icon is not fully transparent. Where alpha is 0 the RGB
		// carries no visible information and encoders are free to store anything there, so counting
		// those bytes would measure the encoder's whim, not the reduction.
		for (let i = 0; i < expected.pixels.length; i += BYTES_PER_PIXEL) {
			const channels = expected.pixels[i + 3] === 0 && produced.pixels[i + 3] === 0 ? [3] : [0, 1, 2, 3];
			let pixelDiffers = false;
			for (const c of channels) {
				const delta = Math.abs(produced.pixels[i + c] - expected.pixels[i + c]);
				if (delta > maxDelta) {
					maxDelta = delta;
				}
				if (delta !== 0) {
					pixelDiffers = true;
				}
			}
			if (pixelDiffers) {
				differing += 1;
			}
		}
		worst = Math.max(worst, maxDelta);
		const total = expected.width * expected.height;
		console.log(
			`${colour.padEnd(7)} max channel delta ${String(maxDelta).padStart(3)}   `
			+ `pixels differing ${differing}/${total} (${((differing / total) * 100).toFixed(1)}%)`,
		);
	}

	console.log("");
	if (failures) {
		console.log(`VERIFY: ${failures} pair(s) could not be compared.`);
		return 1;
	}
	if (worst === 0) {
		console.log("VERIFY: byte-identical to the committed icons.");
	} else if (worst <= AGREEMENT_LIMIT) {
		console.log(`VERIFY: max channel delta ${worst}/255 — same method, different rounding (limit ${AGREEMENT_LIMIT}).`);
	} else {
		console.log(`VERIFY: max channel delta ${worst}/255 — exceeds ${AGREEMENT_LIMIT}. This is not the method that made the committed art.`);
		return 1;
	}
	return 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
	if (argv.includes("--verify")) {
		return verify();
	}
	const positional = argv.filter(arg => !arg.startsWith("--"));
	if (positional.length !== 2) {
		console.error("usage: downscale-icon.mjs <input.png> <output.png> [--factor 8]");
		console.error("       downscale-icon.mjs --verify");
		return 2;
	}
	const factorArg = argv.find(arg => arg.startsWith("--factor="));
	const factor = factorArg ? Number(factorArg.slice("--factor=".length)) : 8;
	if (!Number.isInteger(factor) || factor < 2) {
		console.error(`--factor must be an integer >= 2 (got ${factor})`);
		return 2;
	}

	const [input, output] = positional;
	const source = decodePng(fs.readFileSync(input), input);
	const reduced = downscale(source, factor);
	fs.writeFileSync(output, encodePng(reduced.width, reduced.height, reduced.pixels));
	console.log(`${input} ${source.width}x${source.height} -> ${output} ${reduced.width}x${reduced.height}`);
	return 0;
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exit(main(process.argv.slice(2)));
}
