"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { hasIconExport, selectIconPack } = require("../dist/node/shared/icon-pack.js");

const exported = (id, updatedAtMs = 0, extra = {}) => ({ id, name: `pack-${id}`, updatedAtMs, exportManifest: { assets: { metadata: `metadata.${id}.json` } }, ...extra });
const bare = id => ({ id, name: `pack-${id}` });

test("a pack counts as exported only when its manifest names prototype metadata and it is not deleted", () => {
	assert.equal(hasIconExport(exported(1)), true);
	assert.equal(hasIconExport(bare(1)), false);
	assert.equal(hasIconExport({ id: 1, exportManifest: { assets: { locale: "locale.json" } } }), false);
	assert.equal(hasIconExport(exported(1, 0, { isDeleted: true })), false);
	assert.equal(hasIconExport(undefined), false);
});

test("the instance's own pack wins when it has icons", () => {
	const packs = [exported(7), exported(9)];
	assert.equal(selectIconPack(9, packs[0], packs).id, 9);
});

test("an instance pack without icons falls back to the default pack, then to the newest exported pack", () => {
	const defaultBare = bare(3);
	const packs = [bare(5), defaultBare, exported(7, 100), exported(9, 200)];
	assert.equal(selectIconPack(5, exported(7, 100), packs).id, 7, "the default pack when it has icons");
	assert.equal(selectIconPack(5, defaultBare, packs).id, 9, "the newest exported pack when the default has none");
	assert.equal(selectIconPack(null, defaultBare, packs).id, 9, "an unscoped icon follows the same order");
});

test("with no exported pack at all the scoped or default pack is kept so the tooltip can name it", () => {
	assert.equal(selectIconPack(5, bare(3), [bare(5), bare(3)]).id, 5);
	assert.equal(selectIconPack(undefined, bare(3), []).id, 3);
	assert.equal(selectIconPack(undefined, undefined, []), undefined);
});

test("equally recent exported packs resolve the same way every time", () => {
	const packs = [exported(4, 50), exported(8, 50)];
	assert.equal(selectIconPack(null, undefined, packs).id, 8);
	assert.equal(selectIconPack(null, undefined, [...packs].reverse()).id, 8);
});
