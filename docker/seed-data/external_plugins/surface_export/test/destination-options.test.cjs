const { test } = require("node:test");
const assert = require("node:assert/strict");
const { destinationOptions, canSelectDestination } = require("../dist/node/shared/destination-options.js");

const instance = (instanceId, instanceName, overrides = {}) => ({
	instanceId, instanceName, gamePort: null, connected: true, status: "running", ...overrides,
});
const tree = {
	hosts: [{ instances: [instance(1, "Source", { gamePort: 34100 }), instance(2, "Stopped", { status: "stopped" })] }],
	unassignedInstances: [instance(3, "Available"), instance(4, "Disconnected", { connected: false })],
};

test("import and transfer share availability rules, but transfer excludes its source", () => {
	const imports = destinationOptions(tree);
	const transfers = destinationOptions(tree, 1);
	assert.deepEqual(imports.map(option => option.label), ["Available", "Disconnected", "Source :34100", "Stopped"]);
	assert.deepEqual(transfers, imports.filter(option => option.value !== 1));
	for (const options of [imports, transfers]) {
		assert.equal(canSelectDestination(options, 3), true);
		for (const id of [2, 4, 99, null]) assert.equal(canSelectDestination(options, id), false);
	}
	assert.equal(canSelectDestination(transfers, 1), false);
});

test("a selected destination becomes unavailable on disconnect, removal, or missing tree", () => {
	assert.equal(canSelectDestination(destinationOptions(tree), 3), true);
	for (const updated of [null, { hosts: [], unassignedInstances: [] },
		{ hosts: [], unassignedInstances: [instance(3, "Available", { connected: false })] }]) {
		assert.equal(canSelectDestination(destinationOptions(updated), 3), false);
	}
});
