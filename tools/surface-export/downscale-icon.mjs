#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 4;

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

	if (bitDepth !== 8 || colourType !== 6 || interlace !== 0) {
		throw new Error(
			`${label}: only 8-bit RGBA non-interlaced PNGs are supported `
			+ `(got bitDepth=${bitDepth}, colourType=${colourType}, interlace=${interlace})`,
		);
	}

	const idat = Buffer.concat(chunks.filter(chunk => chunk.type === "IDAT").map(chunk => chunk.data));
	if (!idat.length) {
		throw new Error(`${label}: no IDAT data`);
	}
	return { width, height, pixels: unfilter(zlib.inflateSync(idat), width, height) };
}


function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData), 0);
	return Buffer.concat([length, typeAndData, crc]);
}

export function encodePng(width, height, pixels) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

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


const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ICON_DIR = path.resolve(HERE, "../../docker/seed-data/mods-src/surfexp_gateways/graphics/icons");

const AGREEMENT_LIMIT = 8;

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
