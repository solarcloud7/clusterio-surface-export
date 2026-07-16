#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ENDPOINTS, EXPECTED_BLACK_BOX_SHA256, certifyAttributionFixture } from "./fixture-contract.mjs";

export function extractAttribution(blackBox, parentSha256) {
	if (parentSha256 !== EXPECTED_BLACK_BOX_SHA256) {
		throw new Error(`black-box SHA-256 changed: expected ${EXPECTED_BLACK_BOX_SHA256}, got ${parentSha256}`);
	}
	const wanted = new Set(ENDPOINTS.map(endpoint => endpoint.key));
	const rows = (blackBox.restore_time_belt_lines?.rows || [])
		.filter(row => wanted.has(`${row.entity_id}:${row.line_index}`))
		.sort((left, right) => `${left.entity_id}:${left.line_index}`.localeCompare(`${right.entity_id}:${right.line_index}`, "en", { numeric: true }));
	const fixture = {
		schema: "belt-adjacency-dup-attribution-v1",
		parent_black_box_sha256: parentSha256,
		engine_version: blackBox.engine_version,
		rows,
	};
	certifyAttributionFixture(fixture);
	return fixture;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const [inputPath, outputPath] = process.argv.slice(2);
	if (!inputPath || !outputPath) throw new Error("usage: node extract-dup-fixtures.mjs <black-box.json> <output.json>");
	const raw = readFileSync(inputPath);
	const digest = createHash("sha256").update(raw).digest("hex");
	const fixture = extractAttribution(JSON.parse(raw.toString("utf8")), digest);
	writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
	console.log(JSON.stringify({ outputPath, parentSha256: digest, endpoints: fixture.rows.length }));
}
