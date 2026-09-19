"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {LuaInterface} = require("../dist/node/lib/lua-interface.js");

function interfaceFor(response) {
	const commands = [];
	const api = new LuaInterface({sendRcon: async command => {
		commands.push(command);
		return JSON.stringify(response);
	}}, {info() {}, verbose() {}});
	return {api, commands};
}

test("planet policy accepts Lua's empty-array representation and verifies startup identity", async () => {
	const reply = {success: true, version: 1, epoch: "boot", disabledPlanets: {}, defaultPlanet: "nauvis", instanceName: "One"};
	const {api, commands} = interfaceFor(reply);
	await api.configurePlanetPolicy([], "nauvis", "One", "boot");
	assert.equal(commands.length, 1);
	assert.ok(commands[0].includes("configure_planet_policy_json"));
	assert.ok(commands[0].includes('"epoch":"boot"'));
});

test("planet policy rejects mismatched, missing and negative acknowledgements", async () => {
	const reply = {success: true, version: 1, epoch: "boot", disabledPlanets: ["gleba"], defaultPlanet: "fulgora", instanceName: "One"};
	for (const change of [{success: false, error: "invalid default"}, {version: 2}, {epoch: "old"},
		{disabledPlanets: {}}, {defaultPlanet: "nauvis"}, {instanceName: "Two"}, {disabledPlanets: null}]) {
		const {api, commands} = interfaceFor({...reply, ...change});
		await assert.rejects(api.configurePlanetPolicy(["gleba"], "fulgora", "One", "boot"));
		assert.equal(commands.length, 1, "policy failure must not replay the request");
	}
});
