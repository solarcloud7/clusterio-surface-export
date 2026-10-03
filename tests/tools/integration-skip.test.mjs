import { test } from "node:test";
import assert from "node:assert/strict";

import { ciSkipFailure } from "../../tools/tests/integration-skip.mjs";

test("under CI a skipped suite fails the run and every skipped suite is named", () => {
	const failure = ciSkipFailure(["canvas-drag", "settings", "log-evidence"], { CI: "true" });
	assert.match(failure, /^3 integration suite\(s\) SKIPPED under CI, which fails the run: canvas-drag, settings, log-evidence\. /);
	assert.match(ciSkipFailure(["transfer-modal"], { CI: "1" }), /fails the run: transfer-modal\./);
});

test("a local run keeps its skip and a CI run without a skip is not failed", () => {
	for (const env of [{}, { CI: "" }, { CI: "false" }]) {
		assert.equal(ciSkipFailure(["canvas-drag"], env), null, JSON.stringify(env));
	}
	assert.equal(ciSkipFailure([], { CI: "true" }), null);
});
