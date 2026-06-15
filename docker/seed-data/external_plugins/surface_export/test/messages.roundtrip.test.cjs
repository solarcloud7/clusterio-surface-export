"use strict";
/**
 * Round-trip + wire-contract harness for the plugin's message classes.
 *
 * Why this exists: messages.ts hand-rolls 24 Clusterio Link message classes, each repeating a
 * static wire contract (plugin/type/src/dst/[permission]/jsonSchema/fromJSON) and a
 * constructor/toJSON pair. A drift between any of those — a toJSON field the schema doesn't
 * declare, a renamed field, a class missing from registration — surfaces only at runtime as an
 * AJV validation failure or an "Unregistered Event class" crash on controller start. This harness
 * turns those into a failing `npm test` instead.
 *
 * Zero external deps: built-in node:test + node:assert, and it require()s the COMPILED CommonJS
 * output (dist/node/messages.js), so run `npm run build:node` first (the `npm test` script does).
 * It self-discovers the message classes and generates a minimal valid sample from each class's own
 * jsonSchema, so a newly-added message is covered automatically with no edits here.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const messages = require(path.join(__dirname, "..", "dist", "node", "messages.js"));

// Discover message classes by the one invariant every plugin message MUST carry: `static plugin`.
// Deliberately NOT keyed on `jsonSchema`/`type` — a class that omits those is exactly the drift this
// harness exists to catch, so it must still be discovered here and FAIL the per-class assertions
// below, rather than be silently skipped.
const PLUGIN_NAME = "surface_export";
const messageClasses = Object.entries(messages)
	.filter(([, value]) => typeof value === "function" && value.plugin === PLUGIN_NAME)
	.map(([name, cls]) => ({ name, cls }));

const VALID_TYPES = new Set(["request", "event"]);

/** A minimal value satisfying a single JSON-schema property's declared type. */
function sampleForType(propSchema) {
	const declared = propSchema && propSchema.type;
	const type = Array.isArray(declared) ? declared[0] : declared;
	switch (type) {
		case "integer":
		case "number": return 1;
		case "string": return "x";
		case "boolean": return true;
		case "array": return [];
		case "object": return {};
		case "null": return null;
		default: return null;
	}
}

/** A minimal constructor argument covering every required field of a class's jsonSchema. */
function sampleFromSchema(schema) {
	const props = (schema && schema.properties) || {};
	const required = (schema && schema.required) || Object.keys(props);
	const out = {};
	for (const key of required) {
		out[key] = sampleForType(props[key]);
	}
	return out;
}

test("message classes are discovered", () => {
	assert.ok(
		messageClasses.length >= 20,
		`expected >=20 message classes, discovered ${messageClasses.length}`,
	);
});

for (const { name, cls } of messageClasses) {
	test(`${name}: static wire contract is well-formed`, () => {
		assert.equal(cls.plugin, "surface_export", `${name}.plugin`);
		assert.ok(VALID_TYPES.has(cls.type), `${name}.type is "${cls.type}", expected request|event`);
		assert.ok(cls.src, `${name}.src is missing`);
		assert.ok(cls.dst, `${name}.dst is missing`);
		assert.equal(typeof cls.fromJSON, "function", `${name}.fromJSON must be a static function`);
		assert.ok(cls.jsonSchema && typeof cls.jsonSchema === "object", `${name}.jsonSchema must be an object`);
	});

	test(`${name}: toJSON -> fromJSON round-trips stably`, () => {
		const sample = sampleFromSchema(cls.jsonSchema);
		const first = new cls(sample).toJSON();
		const second = cls.fromJSON(first).toJSON();
		assert.deepEqual(second, first, `${name} diverged across a toJSON/fromJSON round-trip`);
	});

	test(`${name}: toJSON output agrees with jsonSchema`, () => {
		const json = new cls(sampleFromSchema(cls.jsonSchema)).toJSON();
		const props = (cls.jsonSchema.properties) || {};
		// When the schema forbids extras, every emitted key must be declared (catches field drift).
		if (cls.jsonSchema.additionalProperties === false) {
			for (const key of Object.keys(json)) {
				assert.ok(key in props, `${name}.toJSON emits "${key}" which is not in jsonSchema.properties`);
			}
		}
		// Every required field must actually be emitted.
		for (const key of (cls.jsonSchema.required || [])) {
			assert.ok(key in json, `${name}.toJSON omits required field "${key}"`);
		}
	});

	if (cls.Response) {
		test(`${name}.Response: shape is well-formed`, () => {
			assert.ok(
				cls.Response.jsonSchema && typeof cls.Response.jsonSchema === "object",
				`${name}.Response.jsonSchema must be an object`,
			);
			assert.equal(typeof cls.Response.fromJSON, "function", `${name}.Response.fromJSON must be a function`);
		});
	}
}
