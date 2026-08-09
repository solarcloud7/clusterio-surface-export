import assert from "node:assert/strict";
import test from "node:test";

import { parseTarget } from "../../tools/tests/testkit/live-probe.mjs";

test("valid targets parse to typed parts", () => {
	assert.deepEqual(parseTarget("heat-pipe@43,-13:temperature"),
		{ entity: "heat-pipe", x: 43, y: -13, path: "temperature" });
	assert.deepEqual(parseTarget("burner-inserter@15,1:burner.currently_burning.name.name").path,
		"burner.currently_burning.name.name");
});

test("everything outside the safe charsets is rejected before any Lua exists", () => {
	assert.throws(() => parseTarget("x'; game.print('pwn@1,1:temperature"), /illegal characters|must look like/);
	assert.throws(() => parseTarget("heat-pipe@1,1:burner.remaining-burning-fuel"), /dotted identifier/);
	assert.throws(() => parseTarget("heat-pipe@1,1:a']..game.print('x"), /dotted identifier/);
	assert.throws(() => parseTarget("heat-pipe@1,1:" + Array(9).fill("a").join(".")), /deeper than 8/);
	assert.throws(() => parseTarget("heat-pipe@1e999x,2:temperature"), /must look like|finite/);
});
