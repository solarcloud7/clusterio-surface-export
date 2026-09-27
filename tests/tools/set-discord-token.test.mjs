import test from "node:test";
import assert from "node:assert/strict";
import { main, readEnvValue } from "../../tools/clusterio/set-discord-token.mjs";

const SECRET = "MTAx.fake-token.value";

function capture() {
	const text = { out: "", err: "" };
	return { text, out: { write: s => { text.out += s; } }, err: { write: s => { text.err += s; } } };
}

test(".env values are read exactly, quoted or not, and blanks count as unset", () => {
	const env = `FACTORIO_TOKEN=abc\nDISCORD_BOT_TOKEN="${SECRET}"\n# DISCORD_CHANNEL_ID=1\nDISCORD_CHANNEL_ID= 123456789 \nEMPTY=\n`;
	assert.equal(readEnvValue(env, "DISCORD_BOT_TOKEN"), SECRET);
	assert.equal(readEnvValue(env, "DISCORD_CHANNEL_ID"), "123456789");
	assert.equal(readEnvValue(env, "EMPTY"), null);
	assert.equal(readEnvValue(env, "MISSING"), null);
});

test("the token and channel are set on the named cluster and only the length is printed", async () => {
	const calls = [];
	const io = capture();
	const code = await main(["--cluster", "vm"], { ...io, envText: `DISCORD_BOT_TOKEN=${SECRET}\nDISCORD_CHANNEL_ID=42\n`,
		run: async (cluster, fn) => fn({ ctl: (...args) => calls.push([cluster, ...args]) }) });
	assert.equal(code, 0);
	assert.deepEqual(calls, [
		["vm", "controller", "config", "set", "discord_bridge.bot_token", SECRET],
		["vm", "controller", "config", "set", "discord_bridge.channel_id", "42"],
	]);
	assert.ok(!io.text.out.includes(SECRET) && io.text.out.includes(`length ${SECRET.length}`));
});

test("a failure is reported without echoing the token", async () => {
	const io = capture();
	const code = await main([], { ...io, envText: `DISCORD_BOT_TOKEN=${SECRET}\n`,
		run: async () => { const error = new Error(`clusterioctl controller config set discord_bridge.bot_token ${SECRET} failed`); throw error; } });
	assert.equal(code, 1);
	assert.ok(!io.text.err.includes(SECRET) && io.text.err.includes("<redacted>"));
});

test("a missing token or a malformed channel id is refused before anything is sent", async () => {
	let sent = 0;
	const run = async () => { sent += 1; };
	for (const envText of ["FACTORIO_TOKEN=abc\n", `DISCORD_BOT_TOKEN=${SECRET}\nDISCORD_CHANNEL_ID=#general\n`]) {
		const io = capture();
		assert.equal(await main([], { ...io, envText, run }), 2);
		assert.ok(!io.text.err.includes(SECRET));
	}
	assert.equal(sent, 0);
});

test("DISCORD_CHANNEL is accepted when DISCORD_CHANNEL_ID is absent, and the guild id is not needed", async () => {
	const calls = [];
	const io = capture();
	const code = await main([], { ...io, envText: `DISCORD_BOT_TOKEN=${SECRET}\nDISCORD_CHANNEL=1521306605386338335\nDISCORD_GUILD=802319546387398678\n`,
		run: async (cluster, fn) => fn({ ctl: (...args) => calls.push(args) }) });
	assert.equal(code, 0);
	assert.deepEqual(calls.map(args => args[3]), ["discord_bridge.bot_token", "discord_bridge.channel_id"]);
	assert.equal(calls[1][4], "1521306605386338335");
});

test("--help prints usage without reading .env or sending anything", async () => {
	let sent = 0;
	for (const argv of [["--help"], ["-h"], ["--cluster", "vm", "--help"]]) {
		const io = capture();
		const code = await main(argv, { ...io, envText: `DISCORD_BOT_TOKEN=${SECRET}\n`, run: async () => { sent += 1; } });
		assert.equal(code, 0);
		assert.match(io.text.out, /^usage:/);
	}
	assert.equal(sent, 0);
});

test("--cluster=<name> selects that cluster", async () => {
	const clusters = [];
	const io = capture();
	const code = await main(["--cluster=vm"], { ...io, envText: `DISCORD_BOT_TOKEN=${SECRET}\n`,
		run: async (cluster, fn) => { clusters.push(cluster); fn({ ctl: () => {} }); } });
	assert.equal(code, 0);
	assert.deepEqual(clusters, ["vm"]);
});

test("unsupported, repeated or incomplete arguments are refused before any cluster is chosen", async () => {
	let sent = 0;
	const run = async () => { sent += 1; };
	for (const argv of [["--clustr", "vm"], ["vm"], ["--cluster"], ["--cluster", "--help"], ["--cluster="],
		["--cluster", "vm", "--cluster", "dev"], ["--cluster", "vm", "extra"]]) {
		const io = capture();
		assert.equal(await main(argv, { ...io, envText: `DISCORD_BOT_TOKEN=${SECRET}\n`, run }), 2, argv.join(" "));
		assert.match(io.text.err, /usage:/);
	}
	assert.equal(sent, 0);
});
