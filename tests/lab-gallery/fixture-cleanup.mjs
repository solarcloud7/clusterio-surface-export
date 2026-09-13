import { readFileSync } from "node:fs";

const unlock = readFileSync(new URL("./fixture-unlock.lua", import.meta.url), "utf8").replace(/\s+/g, " ").trim();

export function fixtureUnlockLua(platformExpression) {
	return `assert((function() ${unlock} end)()(${platformExpression})) `;
}
