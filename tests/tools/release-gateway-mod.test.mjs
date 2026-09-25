import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickDispatchedRun, release } from "../../tools/release/release-gateway-mod.mjs";

const zipBytes = "gateway zip bytes";
const sha256 = createHash("sha256").update(zipBytes).digest("hex");
const sha1 = createHash("sha1").update(zipBytes).digest("hex");

function repo(t) {
	const root = mkdtempSync(join(tmpdir(), "release-gateway-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "docker/seed-data/mods-src/surfexp_gateways"), { recursive: true });
	mkdirSync(join(root, "docker/seed-data/mods"), { recursive: true });
	writeFileSync(join(root, "docker/seed-data/mods-src/surfexp_gateways/info.json"), '{"version":"0.6.9"}');
	writeFileSync(join(root, "docker/seed-data/mods/surfexp_gateways_0.6.9.zip"), zipBytes);
	return root;
}

function fakeGh({ mainBlob = "blob-a", failWatch = [] } = {}) {
	const calls = [];
	const dispatches = [];
	const run = (cmd, args, { allowFailure = false } = {}) => {
		calls.push(`${cmd} ${args.join(" ")}`);
		if (cmd === "git" && args[0] === "fetch") return "";
		if (cmd === "git" && args[0] === "hash-object") return "blob-a";
		if (cmd === "git" && args[0] === "rev-parse") return mainBlob;
		if (args[0] === "workflow") { dispatches.push(args.find(a => a.startsWith("publish=")).slice(8)); return ""; }
		if (args[0] === "run" && args[1] === "list") {
			return JSON.stringify([{ databaseId: 100 + dispatches.length, createdAt: new Date().toISOString(), event: "workflow_dispatch" }]);
		}
		if (args[0] === "run" && args[1] === "watch") {
			if (failWatch.includes(Number(args[2]))) { assert.ok(allowFailure); return null; }
			return "";
		}
		throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
	};
	return { run, calls, dispatches };
}

const quiet = { sleep: async () => {}, log: () => {} };

test("without --publish only the validate-only run is dispatched and the publish command is printed", async t => {
	const gh = fakeGh();
	const lines = [];
	const result = await release({ root: repo(t), run: gh.run, ...quiet, log: l => lines.push(l) });
	assert.deepEqual(gh.dispatches, ["false"]);
	assert.equal(result.published, false);
	assert.ok(lines.some(l => l.includes(`-f version=0.6.9 -f sha256=${sha256} -f publish=true`)), lines.join("\n"));
});

test("--publish validates first, then publishes and checks the portal sha1", async t => {
	const gh = fakeGh();
	const result = await release({ root: repo(t), run: gh.run, publish: true, ...quiet,
		portalRelease: async () => ({ version: "0.6.9", sha1 }) });
	assert.deepEqual(gh.dispatches, ["false", "true"]);
	assert.equal(result.published, true);
});

test("a ZIP that differs from origin/main is refused before any dispatch", async t => {
	const gh = fakeGh({ mainBlob: "blob-b" });
	await assert.rejects(release({ root: repo(t), run: gh.run, ...quiet }), /differs from origin\/main/);
	assert.deepEqual(gh.dispatches, []);
});

test("a ZIP missing from origin/main is refused before any dispatch", async t => {
	const gh = fakeGh({ mainBlob: null });
	await assert.rejects(release({ root: repo(t), run: gh.run, ...quiet }), /is not on origin\/main/);
	assert.deepEqual(gh.dispatches, []);
});

test("a failed validate-only run stops before publishing", async t => {
	const gh = fakeGh({ failWatch: [101] });
	await assert.rejects(release({ root: repo(t), run: gh.run, publish: true, ...quiet }), /validate-only run 101 failed/);
	assert.deepEqual(gh.dispatches, ["false"]);
});

test("a portal release with different bytes is reported as a failure", async t => {
	const gh = fakeGh();
	await assert.rejects(release({ root: repo(t), run: gh.run, publish: true, ...quiet,
		portalRelease: async () => ({ version: "0.6.9", sha1: "0".repeat(40) }) }), /does not match the local ZIP/);
});

test("the dispatched run is the oldest one created after the dispatch", () => {
	const at = Date.parse("2026-09-25T00:10:00Z");
	const runs = [
		{ databaseId: 1, createdAt: "2026-09-25T00:00:00Z", event: "workflow_dispatch" },
		{ databaseId: 3, createdAt: "2026-09-25T00:10:09Z", event: "workflow_dispatch" },
		{ databaseId: 2, createdAt: "2026-09-25T00:10:02Z", event: "workflow_dispatch" },
		{ databaseId: 4, createdAt: "2026-09-25T00:10:01Z", event: "push" },
	];
	assert.equal(pickDispatchedRun(runs, at).databaseId, 2);
	assert.equal(pickDispatchedRun(runs.slice(0, 1), at), null);
});
