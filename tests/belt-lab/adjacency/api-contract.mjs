#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const EXPECTED_RUNTIME_API_SHA256 = "594b4ec98cc5fbee322d7380db49a388ab38b0d69c06f00ead877cffbb37f578";

const EXPECTED_ROLES = [
	"left_line",
	"right_line",
	"left_underground_line",
	"right_underground_line",
	"secondary_left_line",
	"secondary_right_line",
	"left_split_line",
	"right_split_line",
	"secondary_left_split_line",
	"secondary_right_split_line",
];

const EXPECTED_METHODS = {
	get_item_insert_specification: { parameters: ["MapPosition"], returns: ["uint32", "float"] },
	get_line_item_position: { parameters: ["defines.transport_line", "float"], returns: ["MapPosition"] },
	get_transport_line: { parameters: ["defines.transport_line"], returns: ["LuaTransportLine"] },
};

export function sha256Buffer(value) {
	return createHash("sha256").update(value).digest("hex");
}

function typeName(value) {
	return typeof value === "string" ? value : value?.complex_type || value?.type || value?.name;
}

export function certifyRuntimeApi(schema) {
	if (schema?.application_version !== "2.0.77") {
		throw new Error(`expected Factorio 2.0.77, got ${schema?.application_version}`);
	}
	const entity = schema.classes?.find(row => row.name === "LuaEntity");
	const methods = {};
	for (const [name, expected] of Object.entries(EXPECTED_METHODS)) {
		const method = entity?.methods?.find(row => row.name === name);
		if (!method) throw new Error(`missing LuaEntity.${name}`);
		const actual = {
			parameters: (method.parameters || []).map(row => typeName(row.type)),
			returns: (method.return_values || []).map(row => typeName(row.type)),
		};
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			throw new Error(`${name} signature changed: ${JSON.stringify(actual)}`);
		}
		methods[name] = actual;
	}
	const define = schema.defines?.find(row => row.name === "transport_line");
	const roles = (define?.values || []).map(row => row.name);
	for (const role of EXPECTED_ROLES) {
		if (!roles.includes(role)) throw new Error(`missing transport-line role ${role}`);
	}
	if (roles.length !== EXPECTED_ROLES.length) {
		throw new Error(`unexpected transport-line role count ${roles.length}`);
	}
	return {
		version: schema.application_version,
		behaviorScope: "signatures-only",
		methods,
		transportLineRoles: [...EXPECTED_ROLES],
	};
}

export function certifyRuntimeApiFile(path) {
	const raw = readFileSync(path);
	const sha256 = sha256Buffer(raw);
	if (sha256 !== EXPECTED_RUNTIME_API_SHA256) {
		throw new Error(`runtime API SHA-256 changed: expected ${EXPECTED_RUNTIME_API_SHA256}, got ${sha256}`);
	}
	return { sha256, ...certifyRuntimeApi(JSON.parse(raw.toString("utf8"))) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	if (!process.argv[2]) throw new Error("usage: node api-contract.mjs <runtime-api.json>");
	console.log(JSON.stringify(certifyRuntimeApiFile(process.argv[2]), null, 2));
}
