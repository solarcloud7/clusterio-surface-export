import test from "node:test";
import assert from "node:assert/strict";
import { createClusterTransport } from "../../tools/shared/cluster-transport.mjs";

test("transport honors target, request timeout and output bounds without shell interpolation", () => {
	const calls = [];
	const transport = createClusterTransport({ controller: "isolated-controller", config: "/private/control.json",
		hosts: { 1: { instance: "isolated-world" } }, requestTimeoutMs: 240_000, maxBufferBytes: 64 * 1024 * 1024,
		exec: (...args) => { calls.push(args); return 'log\n{"success":true,"count":2}\n'; } });
	assert.deepEqual(transport.lua(1, "return {success=true,count=2}"), { success: true, count: 2 });
	const [program, args, options] = calls[0];
	assert.equal(program, "docker");
	assert.deepEqual(args.slice(0, -1), ["exec", "isolated-controller", "npx", "clusterioctl", "--log-level", "error",
		"--config", "/private/control.json", "instance", "send-rcon", "isolated-world"]);
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
	assert.throws(() => createClusterTransport({ exec: () => "missing output" }).lua(1, "return {}"), /Invalid Lua JSON/);
	assert.deepEqual(createClusterTransport({ exec: () => '{"success":false,"error":"rejected"}' }).lua(1, "return {}"),
		{ success: false, error: "rejected" });
});

test("instance discovery resolves configured hosts and rejects missing identities", () => {
	const transport = createClusterTransport({ hosts: { 7: { instance: "named world" } }, exec: () => "id | name\n123 | checkpoint.zip\n" });
	assert.deepEqual(transport.instanceIds(), { 7: 123 });
	assert.throws(() => createClusterTransport({ exec: () => "no saves" }).instanceIds(), /Could not resolve/);
});
