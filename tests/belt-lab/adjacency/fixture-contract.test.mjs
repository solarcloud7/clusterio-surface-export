import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
	EXPECTED_BLACK_BOX_SHA256,
	EXPECTED_REPLAY_SHA256,
	certifyAttributionFixture,
	certifyReplayFixture,
} from "./fixture-contract.mjs";
import { extractAttribution } from "./extract-dup-fixtures.mjs";

const replayPath = new URL("../fixtures/replay_payload_DUP-233855.json", import.meta.url);
const attributionPath = new URL("../fixtures/dup-233855-loss-attribution.json", import.meta.url);

test("certifies the committed replay payload hash and canonical belt counts", () => {
	const result = certifyReplayFixture(readFileSync(replayPath));
	assert.equal(EXPECTED_REPLAY_SHA256, "17d19ba522dcecdf9c259118e7bc875dc863da33042d2cd3bbd50f2fb91b9f4e");
	assert.deepEqual(result, {
		sha256: EXPECTED_REPLAY_SHA256,
		allEntities: 1359,
		beltEntities: 596,
		serializedBeltLines: 974,
		serializedBeltRows: 4247,
		serializedBeltQuantity: 15866,
	});
});

test("certifies the extracted three-endpoint attribution and parent provenance", () => {
	const result = certifyAttributionFixture(JSON.parse(readFileSync(attributionPath, "utf8")));
	assert.equal(EXPECTED_BLACK_BOX_SHA256, "a939252add39f95d1cc96fc6873453e5edef4ff300346311ca68736e50875445");
	assert.deepEqual(result.endpointKeys, ["65243:1", "65243:2", "65907:2"]);
});

test("extractor selects only the exact known-loss endpoints", () => {
	const rows = [
		{ entity_id: 65243, line_index: 1, delta: { "metallic-asteroid-chunk": -4 } },
		{ entity_id: 65243, line_index: 2, delta: { "explosive-rocket": -8 } },
		{ entity_id: 65907, line_index: 2, delta: { "explosive-rocket": -20 } },
		{ entity_id: 1, line_index: 1, delta: { "iron-plate": 3 } },
	];
	const result = extractAttribution({ engine_version: "2.0.77", restore_time_belt_lines: { rows } }, EXPECTED_BLACK_BOX_SHA256);
	assert.equal(result.rows.length, 3);
	assert.deepEqual(result.rows.map(row => `${row.entity_id}:${row.line_index}`), ["65243:1", "65243:2", "65907:2"]);
});
