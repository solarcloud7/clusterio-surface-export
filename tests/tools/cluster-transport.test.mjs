import test from "node:test";
import assert from "node:assert/strict";
import { createClusterTransport, developmentCluster, CONTROLLER, CTL_CONFIG } from "../../tools/shared/cluster-transport.mjs";
import { createBatchLifecycle } from "../lab-gallery/batch-lifecycle.mjs";

const LIST = "name | id | assignedHost | gamePort | status\n---\nDev One | 836570928 | 1 | 34100 | running\nDev Two | 902099405 | 2 | 34200 | stopped\n";
const pinned = (id, name) => ({ forHost: host => ({ id, name, host, container: `surface-export-host-${host}` }),
	byNameOrId: () => { throw new Error("no override expected"); }, dataDir: () => `/clusterio/data/instances/${name}` });

test("gallery lifecycle constructs with the shared transport before any cluster work", async () => {
	const lifecycle = createBatchLifecycle({ goldenSourceSave: "source.zip", goldenDestSave: "destination.zip", markerPrefix: "transport-test" });
	assert.equal(lifecycle.CONTROLLER, CONTROLLER);
	assert.equal(lifecycle.CTL_CONFIG, CTL_CONFIG);
	for (const method of ["docker", "ctl", "rcon", "lua", "instanceIds"]) {
		assert.equal(lifecycle[method], developmentCluster[method]);
	}
	const results = {}, errors = [];
	await lifecycle.restoreLivePair(results, errors);
	assert.deepEqual(errors, []);
	assert.deepEqual(results.restored, { skipped: "test worlds never loaded" });
});

test("transport honors target, request timeout and output bounds without shell interpolation", () => {
	const calls = [];
	const transport = createClusterTransport({ controller: "isolated-controller", config: "/private/control.json",
		hosts: { 1: { instance: "seed-name" } }, instances: pinned(4242, "isolated-world"),
		requestTimeoutMs: 240_000, maxBufferBytes: 64 * 1024 * 1024,
		exec: (...args) => { calls.push(args); return 'log\n{"success":true,"count":2}\n'; } });
	assert.deepEqual(transport.lua(1, "return {success=true,count=2}"), { success: true, count: 2 });
	const [program, args, options] = calls[0];
	assert.equal(program, "docker");
	assert.deepEqual(args.slice(0, -1), ["exec", "isolated-controller", "npx", "clusterioctl", "--log-level", "error",
		"--config", "/private/control.json", "instance", "send-rcon", "4242"]);
	assert.equal(options.timeout, 240_000);
	assert.equal(options.maxBuffer, 64 * 1024 * 1024);
	assert.equal(options.shell, undefined);
	transport.rcon("gallery", "a 'quoted' command", { timeout: 321 });
	assert.equal(calls[1][1].at(-1), "a 'quoted' command");
	assert.equal(calls[1][2].timeout, 321);
	assert.throws(() => transport.lua(99, "return {}"), /Unknown host/);
});

test("invalid JSON and transport exceptions never produce a successful result or retry", () => {
	let calls = 0;
	const error = new Error("lost reply");
	const transport = createClusterTransport({ exec: () => { calls++; throw error; } });
	assert.throws(() => transport.lua(1, "return {}"), e => e === error);
	assert.equal(calls, 1);
	assert.throws(() => createClusterTransport({ instances: pinned(1, "a"), exec: () => "missing output" }).lua(1, "return {}"), /Invalid Lua JSON/);
	assert.deepEqual(createClusterTransport({ instances: pinned(1, "a"), exec: () => '{"success":false,"error":"rejected"}' }).lua(1, "return {}"),
		{ success: false, error: "rejected" });
});

test("instances resolve by assigned host, not by seed name, and the list is read once", () => {
	const calls = [];
	const transport = createClusterTransport({ hosts: { 1: { instance: "clusterio-host-1-instance-1" }, 2: { instance: "clusterio-host-2-instance-1" } },
		exec: (program, args) => {
			calls.push(args);
			if (args.at(-1) === "list") return LIST;
			if (args[1] === "surface-export-host-2") return "/clusterio/data/instances/clusterio-host-2-instance-1/instance.json\t{\"instance.id\": 902099405}\n";
			return "ok";
		} });
	assert.deepEqual(transport.instanceIds(), { 1: 836570928, 2: 902099405 });
	assert.equal(transport.instanceName(2), "Dev Two");
	assert.equal(transport.instanceDir(2), "/clusterio/data/instances/clusterio-host-2-instance-1");
	assert.equal(transport.rcon(1, "/c 1"), "ok");
	assert.deepEqual(calls.at(-1).slice(-3), ["send-rcon", "836570928", "/c 1"]);
	assert.deepEqual(transport.locate(1, { override: "Dev Two" }), { id: 902099405, name: "Dev Two", host: 2, container: "surface-export-host-2" });
	assert.equal(calls.filter(args => args.at(-1) === "list").length, 1);
	assert.throws(() => transport.lua(3, "return {}"), /Unknown host 3/);
	assert.throws(() => createClusterTransport({ exec: () => "Error: not connected" }).instanceIds(), /no name\/id\/assignedHost column.*not connected/);
});
