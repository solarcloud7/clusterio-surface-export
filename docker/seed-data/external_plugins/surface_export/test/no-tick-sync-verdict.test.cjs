"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const luaparse = require("../scripts/vendor/luaparse.cjs");

const pluginDir = path.join(__dirname, "..");
const selftestPath = path.join(pluginDir, "module", "interfaces", "remote", "no-tick-sync-selftest.lua");
const source = fs.readFileSync(selftestPath, "utf8");
const ast = luaparse.parse(source, { luaVersion: "5.2" });

const CHIP_NAMED_ASSERTIONS = ["held_item_intentional_restore", "validation_success"];

function stringOf(node) {
	assert.equal(node.type, "StringLiteral", `expected a string literal, got ${node.type}`);
	return node.raw.slice(1, -1);
}

function topLevelLocal(name) {
	return ast.body.find(node => node.type === "LocalStatement"
		&& node.variables.some(variable => variable.name === name));
}

function stringListLocal(name) {
	const statement = topLevelLocal(name);
	assert.ok(statement, `no-tick-sync-selftest.lua must declare ${name} — the status verdict has to be `
		+ "derived from a list of fields enumerated at the emitter, not from a constant");
	const constructor = statement.init.find(node => node.type === "TableConstructorExpression");
	assert.ok(constructor, `${name} must be a table constructor of field-name string literals`);
	return constructor.fields.map(field => {
		assert.equal(field.type, "TableValue", `${name} must be a plain array of field-name strings`);
		return stringOf(field.value);
	});
}

function runLabBody() {
	const declaration = ast.body.find(node => node.type === "FunctionDeclaration"
		&& node.identifier && node.identifier.name === "run_lab");
	assert.ok(declaration, "run_lab must exist in no-tick-sync-selftest.lua");
	return declaration.body;
}

function measuredResultConstructor() {
	const body = runLabBody();
	const local = body.find(node => node.type === "LocalStatement"
		&& node.variables.some(variable => variable.name === "result")
		&& node.init.some(init => init.type === "TableConstructorExpression"));
	if (local) {
		return local.init.find(init => init.type === "TableConstructorExpression");
	}
	const returned = body.filter(node => node.type === "ReturnStatement"
		&& node.arguments.length === 1 && node.arguments[0].type === "TableConstructorExpression");
	assert.ok(returned.length > 0, "run_lab must emit its measured result as a table");
	return returned[returned.length - 1].arguments[0];
}

function measuredResultFields() {
	const fields = new Map();
	for (const field of measuredResultConstructor().fields) {
		assert.equal(field.type, "TableKeyString", "run_lab's measured result must use plain identifier keys");
		fields.set(field.key.name, field.value);
	}
	return fields;
}

function evidenceKeys() {
	const statement = topLevelLocal("LAB_VERDICT_EVIDENCE");
	if (!statement) {
		return [];
	}
	const constructor = statement.init.find(node => node.type === "TableConstructorExpression");
	assert.ok(constructor, "LAB_VERDICT_EVIDENCE must be a table constructor");
	return constructor.fields.map(field => {
		assert.equal(field.type, "TableKeyString", "LAB_VERDICT_EVIDENCE must be keyed by plain field names");
		return field.key.name;
	});
}

function luaToString(value) {
	if (value === undefined || value === null) {
		return "nil";
	}
	return String(value);
}

function labVerdict(result, { verdictFields, observationFields, evidence = {} }) {
	const verdictSet = new Set(verdictFields);
	const observationSet = new Set(observationFields);

	const unenumerated = [];
	for (const key of Object.keys(result)) {
		if (result[key] === undefined) {
			continue;
		}
		if (!verdictSet.has(key) && !observationSet.has(key)) {
			unenumerated.push(key);
		}
	}
	if (unenumerated.length > 0) {
		unenumerated.sort();
		return {
			status: "unenumerated",
			reason: `result fields classified as neither verdict nor observation: ${unenumerated.join(", ")}`,
		};
	}

	const failures = [];
	for (const field of verdictFields) {
		if (result[field] !== true) {
			const detail = evidence[field] ? ` [${evidence[field](result)}]` : "";
			failures.push(`${field}=${luaToString(result[field])}${detail}`);
		}
	}
	if (failures.length > 0) {
		return { status: "failed", reason: failures.join("; ") };
	}

	return { status: "passed", reason: undefined };
}

function lists() {
	return {
		verdictFields: stringListLocal("LAB_VERDICT_FIELDS"),
		observationFields: stringListLocal("LAB_OBSERVATION_FIELDS"),
	};
}

function allTrue(verdictFields) {
	const result = { surface: "no-tick-sync-lab-1", restored: 1, failed: 0 };
	for (const field of verdictFields) {
		result[field] = true;
	}
	return result;
}

test("run_lab's status is derived from its result fields, not emitted as a constant", () => {
	const status = measuredResultFields().get("status");
	if (status === undefined) {
		return;
	}
	const constant = status.type === "StringLiteral" ? stringOf(status) : null;
	assert.ok(constant === null,
		`run_lab emits status = "${constant}" as a constant of its measured result, so every field it measures is `
		+ `ignored: a result carrying ${CHIP_NAMED_ASSERTIONS.map(field => `${field} = false`).join(" and ")} `
		+ `still reports status "${constant}", and the batch runner (tests/instruments/selftests/run-tests.mjs) `
		+ "reads only status — a vacuous green");
});

test("the verdict list names the assertions the lab actually makes", () => {
	const { verdictFields } = lists();
	for (const field of CHIP_NAMED_ASSERTIONS) {
		assert.ok(verdictFields.includes(field),
			`${field} is an assertion this lab makes; dropping it from LAB_VERDICT_FIELDS returns the selftest `
			+ "to a vacuous green");
	}
	assert.ok(verdictFields.includes("validation_called"),
		"validation_called claims the validator ran; it must gate the verdict too");
});

test("every field run_lab emits is classified exactly once, and neither list names a field it does not emit", () => {
	const { verdictFields, observationFields } = lists();
	const emitted = measuredResultFields();

	const overlap = verdictFields.filter(field => observationFields.includes(field));
	assert.deepEqual(overlap, [], "a field cannot be both a verdict and an observation");

	for (const field of emitted.keys()) {
		assert.ok(verdictFields.includes(field) || observationFields.includes(field),
			`run_lab emits ${field} but neither list classifies it — a field added later must be declared a `
			+ "verdict or explicitly declared a non-verdict observation");
	}
	for (const field of [...verdictFields, ...observationFields]) {
		assert.ok(emitted.has(field),
			`${field} is enumerated but run_lab no longer emits it — a stale name silently stops being checked`);
	}
	assert.ok(!emitted.has("reason"),
		"reason is the verdict's own output; emitting it alongside the measurement would escape the enumeration");
});

test("every verdict field true reports passed", () => {
	const { verdictFields, observationFields } = lists();
	const verdict = labVerdict(allTrue(verdictFields), { verdictFields, observationFields });
	assert.equal(verdict.status, "passed");
	assert.equal(verdict.reason, undefined);
});

test("each verdict field, forced false alone, demotes the status and names itself", () => {
	const { verdictFields, observationFields } = lists();
	const evidence = Object.fromEntries(verdictFields.map(field => [field, () => "<evidence>"]));

	for (const forced of verdictFields) {
		const result = allTrue(verdictFields);
		result[forced] = false;

		const verdict = labVerdict(result, { verdictFields, observationFields, evidence });
		assert.notEqual(verdict.status, "passed",
			`${forced} = false must not report a passed status`);
		assert.equal(verdict.status, "failed");
		assert.ok(verdict.reason.includes(`${forced}=false`),
			`the reason must name ${forced}; the batch runner prints only status and reason`);
		for (const other of verdictFields) {
			if (other !== forced) {
				assert.ok(!verdict.reason.includes(`${other}=`),
					`${forced} must be caught on its own, not proxied through ${other}`);
			}
		}
	}
});

test("a verdict field that goes missing entirely cannot report passed", () => {
	const { verdictFields, observationFields } = lists();
	for (const dropped of verdictFields) {
		const result = allTrue(verdictFields);
		delete result[dropped];
		assert.notEqual(labVerdict(result, { verdictFields, observationFields }).status, "passed",
			`an absent ${dropped} is not a satisfied assertion`);
	}
});

test("an unclassified field fails loud instead of riding along", () => {
	const { verdictFields, observationFields } = lists();
	const result = allTrue(verdictFields);
	result.some_field_added_later = false;

	const verdict = labVerdict(result, { verdictFields, observationFields });
	assert.equal(verdict.status, "unenumerated");
	assert.ok(verdict.reason.includes("some_field_added_later"));
});

test("diagnostic evidence is attached only to fields that carry the verdict", () => {
	const { verdictFields } = lists();
	for (const key of evidenceKeys()) {
		assert.ok(verdictFields.includes(key),
			`LAB_VERDICT_EVIDENCE explains ${key}, which is not a verdict field`);
	}
});

test("the Lua verdict is shaped as transcribed here", () => {
	assert.match(source, /function\s+lab_verdict\s*\(\s*result\s*\)/,
		"the verdict must be computed by one named function over the measured result");
	assert.match(source, /for\s+key\s+in\s+pairs\s*\(\s*result\s*\)/,
		"the enumeration check must sweep the emitted result, so an unclassified field cannot hide");
	assert.match(source, /if\s+result\s*\[\s*field\s*\]\s*~=\s*true\s+then/,
		"a verdict field passes only when it is true; nil and false must both demote");
	assert.match(source, /for\s+_\s*,\s*field\s+in\s+ipairs\s*\(\s*LAB_VERDICT_FIELDS\s*\)/,
		"the failure sweep must walk LAB_VERDICT_FIELDS itself");
	assert.match(source, /result\.status\s*,\s*result\.reason\s*=\s*lab_verdict\s*\(\s*result\s*\)/,
		"run_lab must publish the derived verdict as its status and reason");
});

test("the leak audit still demotes only a status that is otherwise passed", () => {
	assert.match(source, /if\s+#leaks\s*>\s*0\s+and\s+result\.status\s*==\s*"passed"\s+then/,
		"a run that fails an assertion must keep its own status and reason; the leak audit demotes a pass, "
		+ "it does not overwrite a failure");
	assert.match(source, /result\.status\s*=\s*"leaked"/,
		"a leaked scratch surface must still demote a passing run");
});
