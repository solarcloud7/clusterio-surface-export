#!/usr/bin/env node
// requires: Node 22+ (zlib.crc32); the gateway mod source directory with info.json
// produces: a byte-reproducible Factorio mod ZIP (sorted entries, fixed timestamps and attributes) under <name>_<version>/, refusing to replace an existing ZIP of the same version with different bytes
// does not: bump the version, upload the mod, sync clients or publish to the Mod Portal
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const EXCLUDED = new Set(["README.md"]);

export function collectFiles(root, relative = "") {
	const files = [];
	for (const name of readdirSync(path.join(root, relative))) {
		const rel = relative ? `${relative}/${name}` : name;
		if (!relative && EXCLUDED.has(name)) continue;
		const full = path.join(root, rel);
		if (statSync(full).isDirectory()) files.push(...collectFiles(root, rel));
		else files.push(rel);
	}
	return files.sort();
}

export function buildZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBytes = Buffer.from(name, "utf8");
		const compressed = zlib.deflateRawSync(data, { level: 9 });
		const crc = zlib.crc32(data) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBytes, compressed);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(DOS_TIME, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + compressed.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

export function packMod(sourceDir) {
	const info = JSON.parse(readFileSync(path.join(sourceDir, "info.json"), "utf8"));
	if (!info.name || !info.version) throw new Error(`${sourceDir}/info.json needs name and version`);
	const folder = `${info.name}_${info.version}`;
	const entries = collectFiles(sourceDir).map(rel => ({ name: `${folder}/${rel}`, data: readFileSync(path.join(sourceDir, rel)) }));
	return { folder, zip: buildZip(entries) };
}

export function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

export function writeGuarded(zipPath, zip, { allowReplace = false } = {}) {
	if (existsSync(zipPath)) {
		const existing = readFileSync(zipPath);
		if (existing.equals(zip)) return "unchanged";
		if (!allowReplace) {
			throw new Error(`${path.basename(zipPath)} already exists with different bytes (existing ${sha256(existing).slice(0, 16)}, `
				+ `new ${sha256(zip).slice(0, 16)}). A version that reached a host, client or the Mod Portal must not change: bump info.json.`);
		}
	}
	writeFileSync(zipPath, zip);
	return "written";
}

function main(argv) {
	const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
	const source = value("--src");
	const outDir = value("--out-dir");
	if (!source || !outDir) {
		console.error("usage: pack-gateway-mod.mjs --src <mod source dir> --out-dir <dir> [--allow-replace]");
		return 2;
	}
	try {
		const { folder, zip } = packMod(source);
		const zipPath = path.join(outDir, `${folder}.zip`);
		const outcome = writeGuarded(zipPath, zip, { allowReplace: argv.includes("--allow-replace") });
		console.log(`${outcome}: ${zipPath} sha256=${sha256(zip)}`);
		return 0;
	} catch (error) {
		console.error(`pack-gateway-mod: ${error.message}`);
		return 1;
	}
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = main(process.argv.slice(2));
}
