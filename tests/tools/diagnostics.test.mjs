import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnosticLine } from "../../tools/shared/diagnostics.mjs";
test("structured diagnostics select useful fields and discard request headers", () => {
	const text = diagnosticLine(JSON.stringify({ timestamp: "today", message: "operation failed", stage: "upload",
		headers: { "x-access-token": "fixture-secret" }, enormous: "x".repeat(100000) }));
	assert.equal(text, "today upload operation failed");
});
test("plain and embedded credentials are redacted before the final length cap", () => {
	for (const secret of ['x-access-token: fixture-secret', 'Authorization: Bearer fixture-secret',
		'"x-access-token":"fixture-secret"', "controller_token='fixture-secret'"]) {
		const text = diagnosticLine(`error ${secret} ${"detail ".repeat(20000)}`, 120);
		assert.ok(!text.includes("fixture-secret"), text); assert.ok(text.length <= 120);
	}
});
test("valid JSON primitives and escaped request text still take the safe bounded path", () => {
	assert.equal(diagnosticLine("null"), "null");
	const text = diagnosticLine('error {\\"x-access-token\\":\\"fixture-secret\\"}');
	assert.ok(!text.includes("fixture-secret"), text);
});
