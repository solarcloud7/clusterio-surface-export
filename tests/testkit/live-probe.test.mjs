// parseTarget is a trust boundary: its output is spliced into a Lua string, so the charset checks
// are what make injection UNREPRESENTABLE — the contract under test is "nothing outside the safe
// charsets reaches the splice", not any particular bug.
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
	// entity name: Lua-quote breakout attempt
	assert.throws(() => parseTarget("x'; game.print('pwn@1,1:temperature"), /illegal characters|must look like/);
	// path: non-identifier segment (also what a hyphenated typo looks like)
	assert.throws(() => parseTarget("heat-pipe@1,1:burner.remaining-burning-fuel"), /dotted identifier/);
	// path: quote breakout
	assert.throws(() => parseTarget("heat-pipe@1,1:a']..game.print('x"), /dotted identifier/);
	// depth cap
	assert.throws(() => parseTarget("heat-pipe@1,1:" + Array(9).fill("a").join(".")), /deeper than 8/);
	// malformed coordinates never reach Number splicing
	assert.throws(() => parseTarget("heat-pipe@1e999x,2:temperature"), /must look like|finite/);
});
