import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { packMod, writeGuarded } from "../../tools/surface-export/pack-gateway-mod.mjs";

function readZip(buffer) {
	const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const count = buffer.readUInt16LE(end + 10);
	let offset = buffer.readUInt32LE(end + 16);
	const entries = {};
	for (let index = 0; index < count; index++) {
		const nameLength = buffer.readUInt16LE(offset + 28);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		const local = buffer.readUInt32LE(offset + 42);
		const size = buffer.readUInt32LE(offset + 20);
		const crc = buffer.readUInt32LE(offset + 16);
		const localName = buffer.readUInt16LE(local + 26);
		const localExtra = buffer.readUInt16LE(local + 28);
		const start = local + 30 + localName + localExtra;
		const data = zlib.inflateRawSync(buffer.subarray(start, start + size));
		assert.equal(zlib.crc32(data) >>> 0, crc, `${name} checksum`);
		entries[name] = data.toString("utf8");
		offset += 46 + nameLength;
	}
	return entries;
}

function fixture() {
	const dir = mkdtempSync(path.join(tmpdir(), "pack-mod-"));
	writeFileSync(path.join(dir, "info.json"), JSON.stringify({ name: "demo_mod", version: "1.2.3" }));
	writeFileSync(path.join(dir, "data.lua"), "data:extend({})\n");
	writeFileSync(path.join(dir, "README.md"), "not shipped\n");
	mkdirSync(path.join(dir, "graphics", "space"), { recursive: true });
	writeFileSync(path.join(dir, "graphics", "space", "b.png"), "B");
	writeFileSync(path.join(dir, "graphics", "a.png"), "A");
	return dir;
}

test("packing is byte-reproducible and lays out a single versioned folder without the README", () => {
	const dir = fixture();
	try {
		const first = packMod(dir);
		const second = packMod(dir);
		assert.equal(first.folder, "demo_mod_1.2.3");
		assert.ok(first.zip.equals(second.zip), "two packs of the same source are identical");
		const entries = readZip(first.zip);
		assert.deepEqual(Object.keys(entries), ["demo_mod_1.2.3/data.lua", "demo_mod_1.2.3/graphics/a.png",
			"demo_mod_1.2.3/graphics/space/b.png", "demo_mod_1.2.3/info.json"]);
		assert.equal(entries["demo_mod_1.2.3/data.lua"], "data:extend({})\n");
		writeFileSync(path.join(dir, "data.lua"), "data:extend({}) -- changed\n");
		assert.ok(!packMod(dir).zip.equals(first.zip), "changed source changes the bytes");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an existing ZIP of the same version is never silently replaced with different bytes", () => {
	const dir = fixture();
	const out = mkdtempSync(path.join(tmpdir(), "pack-out-"));
	try {
		const zipPath = path.join(out, "demo_mod_1.2.3.zip");
		const { zip } = packMod(dir);
		assert.equal(writeGuarded(zipPath, zip), "written");
		assert.equal(writeGuarded(zipPath, zip), "unchanged");
		const changed = Buffer.concat([zip, Buffer.from([0])]);
		assert.throws(() => writeGuarded(zipPath, changed), /already exists with different bytes.*bump info\.json/);
		assert.ok(readFileSync(zipPath).equals(zip), "the refused write left the original bytes");
		assert.equal(writeGuarded(zipPath, changed, { allowReplace: true }), "written");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(out, { recursive: true, force: true });
	}
});
