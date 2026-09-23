import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { checkEnginePins } from "../../tools/shared/engine-pins.mjs";
import { REPO_ROOT, seededInstances } from "../../tools/shared/seeded-instances.mjs";

const API_DIR = "docker/seed-data/external_plugins/surface_export/scripts";
const COPIED = ["docker-compose.yml", ".github/workflows/ci.yml", ".env.example", `${API_DIR}/factorio-api-index.json`,
	`${API_DIR}/factorio-api-floor-index.json`,
	...seededInstances().map(h => `docker/seed-data/hosts/${h.host}/${h.instance}/instance.json`)];

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), "se-engine-pins-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const path of COPIED) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), readFileSync(join(REPO_ROOT, path)));
	}
	const edit = (path, change) => writeFileSync(join(root, path), change(readFileSync(join(root, path), "utf8")));
	return { root, edit };
}

test("checked-in engine pins agree with the seed instances", () => {
	const { pin, problems } = checkEnginePins();
	assert.match(pin, /^\d+\.\d+\.\d+$/);
	assert.deepEqual(problems, []);
});

test("the copied fixture is a clean control", t => {
	const { root } = fixture(t);
	assert.deepEqual(checkEnginePins(root).problems, []);
});

for (const [name, path, change, expected] of [
	["compose client tag", "docker-compose.yml", text => text.replace(/FACTORIO_CLIENT_TAG=\S+/, "FACTORIO_CLIENT_TAG=2.1.99"), /FACTORIO_CLIENT_TAG is 2\.1\.99/],
	["compose client mount", "docker-compose.yml", text => text.replace(/- factorio-client-\d+:\/opt/, "- factorio-client-2199:/opt"), /mounts client volume factorio-client-2199/],
	["compose volume declaration", "docker-compose.yml", text => text.replace(/^ {2}factorio-client-\d+:/m, "  factorio-client-2199:"), /does not declare factorio-client-\d+ as an external volume/],
	["CI client volume", ".github/workflows/ci.yml", text => text.replace(/docker volume create factorio-client-\d+/, "docker volume create factorio-client-2199"), /ci\.yml creates factorio-client-2199/],
	["example environment tag", ".env.example", text => `${text}\n# FACTORIO_CLIENT_TAG=2.1.17\n`, /\.env\.example sets FACTORIO_CLIENT_TAG/],
	["API index", `${API_DIR}/factorio-api-index.json`, text => text.replace(/"application_version":"[^"]+"/, '"application_version":"2.1.99"'), /factorio-api-index\.json is for 2\.1\.99/],
	["API floor newer than the pin", `${API_DIR}/factorio-api-floor-index.json`, text => text.replace(/"application_version":"[^"]+"/, '"application_version":"2.1.99"'), /factorio-api-floor-index\.json \(2\.1\.99/],
]) {
	test(`a drifted ${name} is reported`, t => {
		const { root, edit } = fixture(t);
		edit(path, change);
		const { problems } = checkEnginePins(root);
		assert.equal(problems.length, 1, problems.join("\n"));
		assert.match(problems[0], expected);
	});
}

test("disagreeing seed instances stop the comparison", t => {
	const { root, edit } = fixture(t);
	const [first] = seededInstances();
	edit(`docker/seed-data/hosts/${first.host}/${first.instance}/instance.json`, text => text.replace(/"factorio\.version":\s*"[^"]+"/, '"factorio.version": "2.1.99"'));
	const result = checkEnginePins(root);
	assert.equal(result.pin, null);
	assert.match(result.problems[0], /one exact version/);
});
