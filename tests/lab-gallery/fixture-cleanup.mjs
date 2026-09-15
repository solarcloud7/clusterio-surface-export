import { readFileSync } from "node:fs";

const unlock = readFileSync(new URL("./fixture-unlock.lua", import.meta.url), "utf8").replace(/\s+/g, " ").trim();
const sweep = readFileSync(new URL("./fixture-sweep.lua", import.meta.url), "utf8").replace(/\s+/g, " ").trim();
const idle = readFileSync(new URL("./fixture-idle.lua", import.meta.url), "utf8").replace(/\s+/g, " ").trim();

export function fixtureIdleLua(platformExpression) {
	return `assert((function() ${idle} end)()(${platformExpression}))`;
}

export function fixtureUnlockLua(platformExpression) {
	return `assert((function() ${unlock} end)()(${platformExpression})) `;
}

export function fixtureSweepLua(predicate) {
	return `(function() ${sweep} end)()(game.forces.player.platforms, function(q) return ${predicate} end, (function() ${unlock} end)())`;
}

export function assertFixtureCleanup(result) {
	if (result?.success !== true) throw new Error(`Fixture cleanup failed: ${JSON.stringify(result)}`);
	return result;
}
