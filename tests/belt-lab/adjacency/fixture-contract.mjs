import { createHash } from "node:crypto";

export const EXPECTED_REPLAY_SHA256 = "17d19ba522dcecdf9c259118e7bc875dc863da33042d2cd3bbd50f2fb91b9f4e";
export const EXPECTED_BLACK_BOX_SHA256 = "a939252add39f95d1cc96fc6873453e5edef4ff300346311ca68736e50875445";

const BELT_TYPES = new Set(["transport-belt", "underground-belt", "splitter"]);
const ENDPOINTS = [
	{ key: "65243:1", name: "metallic-asteroid-chunk", delta: -4 },
	{ key: "65243:2", name: "explosive-rocket", delta: -8 },
	{ key: "65907:2", name: "explosive-rocket", delta: -20 },
];

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function certifyReplayFixture(raw) {
	const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
	const digest = sha256(buffer);
	if (digest !== EXPECTED_REPLAY_SHA256) {
		throw new Error(`replay SHA-256 changed: expected ${EXPECTED_REPLAY_SHA256}, got ${digest}`);
	}
	const payload = JSON.parse(buffer.toString("utf8"));
	const entities = Array.isArray(payload.entities) ? payload.entities : [];
	const belts = entities.filter(entity => BELT_TYPES.has(entity.type));
	const lines = belts.flatMap(entity => Array.isArray(entity.specific_data?.items) ? entity.specific_data.items : []);
	const rows = lines.flatMap(line => Array.isArray(line.items) ? line.items : []);
	const result = {
		sha256: digest,
		allEntities: entities.length,
		beltEntities: belts.length,
		serializedBeltLines: lines.length,
		serializedBeltRows: rows.length,
		serializedBeltQuantity: rows.reduce((total, row) => total + Number(row.count || 0), 0),
	};
	const expected = [1359, 596, 974, 4247, 15866];
	const actual = [result.allEntities, result.beltEntities, result.serializedBeltLines, result.serializedBeltRows, result.serializedBeltQuantity];
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`replay canonical counts changed: ${JSON.stringify(result)}`);
	}
	return result;
}

export function certifyAttributionFixture(fixture) {
	if (fixture?.schema !== "belt-adjacency-dup-attribution-v1") throw new Error("unexpected attribution schema");
	if (fixture.parent_black_box_sha256 !== EXPECTED_BLACK_BOX_SHA256) throw new Error("black-box parent SHA-256 changed");
	if (fixture.engine_version !== "2.0.77") throw new Error(`unexpected attribution engine ${fixture.engine_version}`);
	const rows = Array.isArray(fixture.rows) ? fixture.rows : [];
	const byKey = new Map(rows.map(row => [`${row.entity_id}:${row.line_index}`, row]));
	for (const endpoint of ENDPOINTS) {
		const row = byKey.get(endpoint.key);
		if (!row || Number(row.delta?.[endpoint.name]) !== endpoint.delta) {
			throw new Error(`attribution endpoint ${endpoint.key} must contain ${endpoint.name} delta ${endpoint.delta}`);
		}
	}
	if (rows.length !== ENDPOINTS.length) throw new Error(`expected exactly ${ENDPOINTS.length} attribution rows, got ${rows.length}`);
	return { endpointKeys: ENDPOINTS.map(endpoint => endpoint.key) };
}

export { BELT_TYPES, ENDPOINTS };
