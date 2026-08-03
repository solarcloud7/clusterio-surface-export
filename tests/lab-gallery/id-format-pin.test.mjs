// Pins the canonical transfer-ID format against its two REAL producers.
//
// WHY A SOURCE-TEXT TEST AND NOT AN IMPORT. batch-lifecycle.mjs duplicates the ID templates so the
// collision preflight can predict what a run is about to generate. Importing the real implementations
// instead would be better in principle and impossible in practice: the Lua half only exists inside a
// running Factorio save, and the TS half compiles to dist/node, which is gitignored and absent from
// the container where the plugin's own test/*.test.cjs run. A test that depends on a build artifact
// is a test that reports the artifact's staleness, not the source's truth.
//
// So the duplication is deliberate and this is the seam that keeps it honest: if either producer
// changes its format, this fails and points at the copy that must follow. A silent drift here would
// make the preflight predict IDs that no run ever generates — a check that can only ever say "clear",
// which is worse than no check at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, canonicalTransferId, makeExportJobId, sanitizePlatformName } from "./batch-lifecycle.mjs";

const repoRoot = REPO_ROOT || fileURLToPath(new URL("../../", import.meta.url));
const pluginRoot = path.join(repoRoot, "docker", "seed-data", "external_plugins", "surface_export");

/** Read a producer, failing LOUD when it is missing — a vanished file must never read as "no drift". */
function readProducer(...parts) {
	const file = path.join(pluginRoot, ...parts);
	if (!fs.existsSync(file)) {
		throw new Error(`ID-format producer is missing: ${file}. This test cannot pass by finding nothing — `
			+ "if the file moved, repoint this pin and the duplicated templates in batch-lifecycle.mjs.");
	}
	return fs.readFileSync(file, "utf8");
}

test("the Lua producer still builds job ids as %03d_<sanitized name>", () => {
	const source = readProducer("module", "core", "export-pipeline.lua");
	assert.match(source, /string\.format\("%03d_%s",\s*job_counter,\s*safe_name\)/,
		"export-pipeline.lua no longer formats the job id as `%03d_%s` of (counter, safe_name). "
		+ "makeExportJobId in batch-lifecycle.mjs mirrors this and must be updated with it.");
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
	// Zero-padding below 1000 and NO truncation above it — the wall-clock floor makes every real
	// counter 13 digits, so a mirror that assumed three would silently predict wrong IDs forever.
	assert.equal(makeExportJobId(1, "test"), "001_test");
	assert.equal(makeExportJobId(44, "test"), "044_test");
	assert.equal(makeExportJobId(1785604898997, "lab-omnibus-state-v1"), "1785604898997_lab-omnibus-state-v1");

	// The sanitizer's character class: alphanumerics and hyphen survive, everything else becomes "-",
	// one dash per character (gsub is per-character, not per-run).
	assert.equal(sanitizePlatformName("lab-omnibus-state-v1"), "lab-omnibus-state-v1");
	assert.equal(sanitizePlatformName("my platform #1"), "my-platform--1");
	assert.equal(sanitizePlatformName("a_b.c"), "a-b-c");

	assert.equal(canonicalTransferId(2, "001_test"), "2:001_test");
});
