"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	PORTAL_COLOURS,
	SERVER_DESTINATIONS_SETTING,
	parseServerDestinations,
	serverDestinationFor,
} = require("../dist/node/shared/server-destinations");

const modData = fs.readFileSync(path.join(__dirname, "../../../mods-src/surfexp_gateways/data.lua"), "utf8");

test("the palette and setting name match the gateway mod", () => {
	const colours = modData.match(/GATEWAY_COLOURS = \{([^}]*)\}/)[1].match(/"([a-z]+)"/g).map(name => name.slice(1, -1));
	assert.deepEqual([...PORTAL_COLOURS], colours);
	assert.ok(modData.includes(`settings.startup["${SERVER_DESTINATIONS_SETTING}"]`));
});

test("destinations take their colour from their position and a missing label becomes Server <id>", () => {
	assert.deepEqual(parseServerDestinations("11=Forge, 22 ,33=  Cinder  ,44=Four,55=Five"), [
		{ instanceId: 11, label: "Forge", colour: "blue" },
		{ instanceId: 22, label: "Server 22", colour: "green" },
		{ instanceId: 33, label: "Cinder", colour: "orange" },
		{ instanceId: 44, label: "Four", colour: "purple" },
		{ instanceId: 55, label: "Five", colour: "blue" },
	]);
});

test("a label keeps everything after the first equals sign, including rich text", () => {
	assert.deepEqual(parseServerDestinations("7=[planet=nauvis] Nauvis"), [
		{ instanceId: 7, label: "[planet=nauvis] Nauvis", colour: "blue" },
	]);
	assert.deepEqual(parseServerDestinations("7="), [{ instanceId: 7, label: "Server 7", colour: "blue" }]);
});

test("malformed and repeated entries are ignored and do not take a colour", () => {
	assert.deepEqual(parseServerDestinations(",,abc=Bad,0=Zero,-3=Neg,1.5=Frac,9=Nine,9=Again, =Blank,10=Ten"), [
		{ instanceId: 9, label: "Nine", colour: "blue" },
		{ instanceId: 10, label: "Ten", colour: "green" },
	]);
});

test("an absent or non-string setting has no destinations", () => {
	for (const value of [undefined, null, "", "   ", 12, { value: "1=One" }]) {
		assert.deepEqual(parseServerDestinations(value), [], JSON.stringify(value));
	}
});

test("one server's destination is found by instance id", () => {
	assert.deepEqual(serverDestinationFor("5=Five,6=Six", 6), { label: "Six", colour: "green" });
	assert.equal(serverDestinationFor("5=Five,6=Six", 7), null);
	assert.equal(serverDestinationFor(undefined, 5), null);
});
