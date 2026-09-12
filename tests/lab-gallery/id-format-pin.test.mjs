import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, canonicalTransferId, makeExportJobId, sanitizePlatformName } from "./batch-lifecycle.mjs";

const repoRoot = REPO_ROOT || fileURLToPath(new URL("../../", import.meta.url));
const pluginRoot = path.join(repoRoot, "docker", "seed-data", "external_plugins", "surface_export");

function readProducer(...parts) {
	const file = path.join(pluginRoot, ...parts);
	if (!fs.existsSync(file)) {
		throw new Error(`ID-format producer is missing: ${file}. This test cannot pass by finding nothing — `
			+ "if the file moved, repoint this pin and the duplicated templates in batch-lifecycle.mjs.");
	}
	return fs.readFileSync(file, "utf8");
}

test("the Lua producer namespaces new job ids with the startup epoch", () => {
	const source = readProducer("module", "core", "export-pipeline.lua");
	assert.match(source, /\.export_job_id\(job_counter, safe_name\)/);
	assert.match(readProducer("module", "core", "source-recovery.lua"),
		/string\.format\("%03d_%s_%s", counter, name, storage\.source_recovery_epoch\)/);
	assert.equal(makeExportJobId(1, "test", "boot-a"), "001_test_boot-a");
	assert.notEqual(makeExportJobId(1, "test", "boot-a"), makeExportJobId(1, "test", "boot-b"));
	assert.match(source, /platform\.name:gsub\("\[\^%w%-\]",\s*"-"\)/,
		"export-pipeline.lua no longer sanitizes the platform name with gsub(\"[^%w%-]\", \"-\"). "
		+ "sanitizePlatformName in batch-lifecycle.mjs mirrors this character class exactly.");
	assert.match(source, /storage\.async_job_id_counter\s*=\s*storage\.async_job_id_counter\s*\+\s*1/,
		"the counter must still pre-increment, or the preflight's window starts at the wrong offset");
});

test("the TS producer still qualifies a job id as <instanceId>:<jobId>", () => {
	const source = readProducer("shared", "utils.ts");
	assert.match(source, /return\s+`\$\{sourceInstanceId\}:\$\{jobId\}`/,
		"makeCanonicalTransferId no longer returns `${sourceInstanceId}:${jobId}`. "
		+ "canonicalTransferId in batch-lifecycle.mjs mirrors this.");
});

test("the mirrors reproduce the producers on the shapes that actually occur", () => {
	assert.equal(makeExportJobId(1, "test"), "001_test");
	assert.equal(makeExportJobId(44, "test"), "044_test");
	assert.equal(makeExportJobId(1785604898997, "lab-omnibus-state-v1"), "1785604898997_lab-omnibus-state-v1");

	assert.equal(sanitizePlatformName("lab-omnibus-state-v1"), "lab-omnibus-state-v1");
	assert.equal(sanitizePlatformName("my platform #1"), "my-platform--1");
	assert.equal(sanitizePlatformName("a_b.c"), "a-b-c");
	assert.equal(sanitizePlatformName("é"), "--", "é is 2 UTF-8 bytes → 2 dashes (per-BYTE, not per-character)");
	assert.equal(sanitizePlatformName("café"), "caf--");
	assert.equal(sanitizePlatformName("🚀pad"), "----pad", "a 4-byte emoji → 4 dashes");

	assert.equal(canonicalTransferId(2, "001_test"), "2:001_test");
});
