import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSeedMods, instanceEngine, readPin, releaseSupports, selectLatest, sha1 } from "../../tools/clusterio/seed-mods.mjs";

function modsDir(t, files) {
	const dir = mkdtempSync(join(tmpdir(), "seed-mods-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
	return dir;
}

const pin = {
	engine: "2.1.20",
	mods: [
		{ name: "maraxsis", version: "1.39.4", sha1: sha1("maraxsis-1.39.4") },
		{ name: "PlanetsLib", version: "2.0.1", sha1: sha1("planetslib-2.0.1") },
	],
};
const exact = { "maraxsis_1.39.4.zip": "maraxsis-1.39.4", "PlanetsLib_2.0.1.zip": "planetslib-2.0.1" };

test("the exact pinned set passes, gateway zips are exempt", t => {
	const dir = modsDir(t, { ...exact, "surfexp_gateways_0.6.8.zip": "gateway", ".gitkeep": "" });
	assert.deepEqual(checkSeedMods({ modsDir: dir, pin, engine: "2.1.20" }), []);
});

test("a pin resolved for another engine is refused", t => {
	const dir = modsDir(t, exact);
	assert.deepEqual(checkSeedMods({ modsDir: dir, pin, engine: "2.1.21" }),
		["seed-mods.json was resolved for engine 2.1.20 but instances pin 2.1.21; run refresh"]);
});

test("a pinned zip with different bytes is refused", t => {
	const dir = modsDir(t, { ...exact, "maraxsis_1.39.4.zip": "tampered" });
	assert.deepEqual(checkSeedMods({ modsDir: dir, pin, engine: "2.1.20" }),
		[`maraxsis_1.39.4.zip: sha1 ${sha1("tampered")} does not match pinned ${sha1("maraxsis-1.39.4")}`]);
});

test("a missing pinned zip is reported", t => {
	const dir = modsDir(t, { "maraxsis_1.39.4.zip": "maraxsis-1.39.4" });
	assert.deepEqual(checkSeedMods({ modsDir: dir, pin, engine: "2.1.20" }),
		["PlanetsLib_2.0.1.zip: pinned but missing; run fetch"]);
});

test("a superseded version beside the pinned one is refused", t => {
	const dir = modsDir(t, { ...exact, "maraxsis_1.34.52.zip": "old" });
	assert.deepEqual(checkSeedMods({ modsDir: dir, pin, engine: "2.1.20" }),
		["maraxsis_1.34.52.zip: superseded, maraxsis is pinned at 1.39.4"]);
});

test("a superseded version alone reports both the stale zip and the missing pin", t => {
	const dir = modsDir(t, { "maraxsis_1.34.52.zip": "old", "PlanetsLib_2.0.1.zip": "planetslib-2.0.1" });
	assert.deepEqual(checkSeedMods({ modsDir: dir, pin, engine: "2.1.20" }), [
		"maraxsis_1.34.52.zip: superseded, maraxsis is pinned at 1.39.4",
		"maraxsis_1.39.4.zip: pinned but missing; run fetch",
	]);
});

test("an unpinned third-party zip is refused", t => {
	const dir = modsDir(t, { ...exact, "Krastorio2_2.0.0.zip": "k2" });
	assert.deepEqual(checkSeedMods({ modsDir: dir, pin, engine: "2.1.20" }),
		["Krastorio2_2.0.0.zip: Krastorio2 is not pinned in seed-mods.json"]);
});

const maraxsisReleases = [
	{ version: "1.34.52", sha1: "e9a9ae14c56409b00b4ed06f26dfe770425ad078",
		info_json: { factorio_version: "2.1", dependencies: ["base >= 2.1.14", "space-age >= 2.1.9", "PlanetsLib >= 1.20.3"] } },
	{ version: "1.39.4", sha1: "18de3e1fcca2df06c8180d56b81fba09dc739bc1",
		info_json: { factorio_version: "2.1", dependencies: ["base >= 2.1.20", "space-age >= 2.1.9", "PlanetsLib >= 1.20.3"] } },
	{ version: "1.10.0", sha1: "0000000000000000000000000000000000000000",
		info_json: { factorio_version: "2.0", dependencies: ["base >= 2.0.0"] } },
];

test("latest selection respects the engine's base requirement", () => {
	assert.equal(selectLatest(maraxsisReleases, "2.1.20").version, "1.39.4");
	assert.equal(selectLatest(maraxsisReleases, "2.1.17").version, "1.34.52");
	assert.equal(selectLatest(maraxsisReleases, "2.0.77").version, "1.10.0");
	assert.equal(selectLatest(maraxsisReleases, "3.0.0"), null);
});

test("a bare base dependency and version ordering are handled numerically", () => {
	assert.equal(releaseSupports({ version: "1.11.0", info_json: { factorio_version: "2.1", dependencies: ["base"] } }, "2.1.20"), true);
	const releases = ["1.9.0", "1.10.0", "1.2.0"].map(version => ({ version, info_json: { factorio_version: "2.1", dependencies: [] } }));
	assert.equal(selectLatest(releases, "2.1.20").version, "1.10.0");
});

test("the committed pin names the engine the instances run", () => {
	assert.equal(readPin().engine, instanceEngine());
	for (const mod of readPin().mods) assert.match(mod.sha1, /^[0-9a-f]{40}$/);
});
