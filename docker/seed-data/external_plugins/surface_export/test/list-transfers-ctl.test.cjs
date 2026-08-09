"use strict";


const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Module = require("node:module");
const originalLoad = Module._load;

const registered = [];
class FakeCommand {
	constructor(options) {
		this.definition = options.definition;
		this.handler = options.handler;
		registered.push(this);
	}
}
class FakeCommandTree {
	constructor(options) { this.name = options.name; this.children = []; }
	add(command) { this.children.push(command); }
}
class NoopMetric {
	labels() { return this; }
	inc() {}
	observe() {}
}

Module._load = function patchedLoad(request, parent, isMain) {
	if (request === "@clusterio/lib") {
		return {
			Command: FakeCommand,
			CommandTree: FakeCommandTree,
			escapeString: (value) => String(value),
			safeOutputFile: async (file, data) => fs.writeFileSync(file, data),
			wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			Counter: NoopMetric,
			Histogram: NoopMetric,
		};
	}
	if (request === "@clusterio/ctl") {
		return { BaseCtlPlugin: class {} };
	}
	return originalLoad.call(this, request, parent, isMain);
};

const distNode = path.join(__dirname, "..", "dist", "node");
require(path.join(distNode, "control.js"));
const messages = require(path.join(distNode, "messages.js"));

const command = registered.find(c => String(c.definition[0]).startsWith("list-transfers"));

async function invoke(args, summaries = []) {
	const sent = [];
	const printed = [];
	const originalLog = console.log;
	console.log = (line) => printed.push(line);
	try {
		await command.handler(args, {
			sendTo: async (target, message) => { sent.push({ target, message }); return summaries; },
		});
	} finally {
		console.log = originalLog;
	}
	return { sent, printed };
}

test("the command is registered on the surface-export tree with an optional limit", () => {
	assert.ok(command, "list-transfers must be registered — without it nothing outside the web UI can "
		+ "reach ListTransactionLogsRequest");
	assert.match(command.definition[0], /^list-transfers \[limit\]$/,
		"limit is an OPTIONAL POSITIONAL: YargsLike (control.ts:11) declares only `positional`, and the "
		+ "optional-positional-with-default idiom is the verified precedent in this file");
});

test("it sends ListTransactionLogsRequest with the parsed limit", async () => {
	const { sent } = await invoke({ limit: 200 });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].target, "controller");
	assert.ok(sent[0].message instanceof messages.ListTransactionLogsRequest,
		"must reuse the existing message, not invent a parallel one");
	assert.equal(sent[0].message.limit, 200);
});

test("it defaults to 50 when no limit is given", async () => {
	const { sent } = await invoke({});
	assert.equal(sent[0].message.limit, 50);
});

test("it prints exactly one JSON-parsable line carrying the array", async () => {
	const summaries = [
		{ transferId: "2:001_alpha", status: "completed", registrySource: "active" },
		{ transferId: "2:002_beta", status: "failed", registrySource: "persisted" },
	];
	const { printed } = await invoke({ limit: 10 }, summaries);
	assert.equal(printed.length, 1, "more than one line and a caller taking 'the last line' gets a fragment");
	assert.deepEqual(JSON.parse(printed[0]), summaries);
});

test("an out-of-range or non-integer limit THROWS instead of silently becoming 50", async () => {
	for (const bad of [0, -1, 501, 1.5, "abc", NaN]) {
		await assert.rejects(() => invoke({ limit: bad }), /limit must be an integer between 1 and 500/,
			`limit=${JSON.stringify(bad)} must be refused loudly`);
	}
	for (const good of [1, 500, "250"]) {
		const { sent } = await invoke({ limit: good });
		assert.equal(sent[0].message.limit, Number(good));
	}
});
