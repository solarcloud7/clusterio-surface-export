import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	EXIT_GENERATED_WORLD, EXIT_OK,
	decideSeededBoot, exitCodeFor, parseSaveList, runSeededBootCheck, seedExpectations,
} from "../../tools/clusterio/ci-verify-seeded-boot.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST1 = "clusterio-host-1-instance-1";
const HOST2 = "clusterio-host-2-instance-1";

const SOURCE_SAVE = "lab-gallery-source.zip";
const DESTINATION_SAVE = "lab-gallery-destination.zip";

const expectations = [
	{ instance: HOST1, seededSaves: [SOURCE_SAVE] },
	{ instance: HOST2, seededSaves: [DESTINATION_SAVE] },
];

const booted = name => ({ loaded: [name] });
const verdictFor = (decision, instance) => decision.results.find(r => r.instance === instance).verdict;

test("the expectations come from docker/seed-data, and every seeded instance ships a save", () => {
	const discovered = seedExpectations(repoRoot);
	assert.deepEqual(discovered.map(e => e.instance).sort(), [HOST1, HOST2]);
	assert.deepEqual(discovered.find(e => e.instance === HOST1).seededSaves, [SOURCE_SAVE]);
	assert.deepEqual(discovered.find(e => e.instance === HOST2).seededSaves, [DESTINATION_SAVE]);
});

test("both instances on their seeded saves passes", () => {
	const decision = decideSeededBoot(expectations, { [HOST1]: booted(SOURCE_SAVE), [HOST2]: booted(DESTINATION_SAVE) });
	assert.equal(decision.ok, true);
	assert.equal(exitCodeFor(decision.category), EXIT_OK);
});

test("host-2 on the world.zip Clusterio generated is the boot-race signature", () => {
	const decision = decideSeededBoot(expectations, { [HOST1]: booted(SOURCE_SAVE), [HOST2]: booted("world.zip") });
	assert.equal(decision.ok, false);
	assert.equal(decision.category, "generated-world");
	assert.equal(exitCodeFor(decision.category), EXIT_GENERATED_WORLD);
	assert.equal(verdictFor(decision, HOST1), "seeded");
	const failed = decision.results.find(r => r.verdict === "generated-world");
	assert.match(failed.detail, /booted world\.zip/);
	assert.match(failed.detail, /lab-gallery-destination\.zip/);
});

test("extra saves alongside the seeded one do not fire the signature — only what BOOTED counts", () => {
	const decision = decideSeededBoot(expectations, {
		[HOST1]: booted(SOURCE_SAVE),
		[HOST2]: booted(DESTINATION_SAVE),
	});
	assert.equal(decision.ok, true);
	const withExtras = decideSeededBoot([{ instance: HOST2, seededSaves: [DESTINATION_SAVE] }], {
		[HOST2]: { loaded: [DESTINATION_SAVE] },
	});
	assert.equal(withExtras.ok, true);
});

test("a docker failure is UNKNOWN, never a pass and never the retry signature", () => {
	const decision = decideSeededBoot(expectations, {
		[HOST1]: booted(SOURCE_SAVE),
		[HOST2]: { error: "Error: No such container: surface-export-controller" },
	});
	assert.equal(verdictFor(decision, HOST2), "unknown");
	assert.equal(decision.category, "ok");
	assert.match(decision.results.find(r => r.verdict === "unknown").detail, /readiness gate decides/);
});

test("no loaded save is UNKNOWN — the check never guesses from an unstarted instance", () => {
	const decision = decideSeededBoot(expectations, { [HOST1]: booted(SOURCE_SAVE), [HOST2]: { loaded: [] } });
	assert.equal(verdictFor(decision, HOST2), "unknown");
	assert.equal(exitCodeFor(decision.category), EXIT_OK);
});

test("two saves reporting loaded is UNKNOWN rather than a coin flip", () => {
	const decision = decideSeededBoot(expectations, {
		[HOST1]: booted(SOURCE_SAVE),
		[HOST2]: { loaded: [DESTINATION_SAVE, "world.zip"] },
	});
	assert.equal(verdictFor(decision, HOST2), "unknown");
});

test("a generated world on one instance fires even while the other is UNKNOWN", () => {
	const decision = decideSeededBoot(expectations, {
		[HOST1]: { error: "timed out" },
		[HOST2]: booted("world.zip"),
	});
	assert.equal(decision.category, "generated-world");
	assert.equal(exitCodeFor(decision.category), EXIT_GENERATED_WORLD);
});

test("a missing listing is UNKNOWN, and no instances at all cannot report a generated world", () => {
	assert.equal(verdictFor(decideSeededBoot(expectations, { [HOST1]: booted(SOURCE_SAVE) }), HOST2), "unknown");
	assert.equal(decideSeededBoot([], {}).category, "ok");
});

test("the clusterioctl save-list table yields the loaded save name", () => {
	const raw = [
		"instanceId | type | name                        | size    | loaded | loadByDefault",
		"------------------------------------------------------------------------------",
		"2065254638 | file | lab-gallery-destination.zip | 1714202 | false  | false",
		"2065254638 | file | world.zip                   | 1180038 | true   | false",
	].join("\n");
	assert.deepEqual(parseSaveList(raw).loaded, ["world.zip"]);
});

test("output that is not a save-list table is an error, not an empty loaded set", () => {
	const parsed = parseSaveList("Error: instance clusterio-host-2-instance-1 does not exist");
	assert.ok(parsed.error, "an unparseable reply must not read as 'nothing is loaded'");
	assert.equal(parsed.loaded, undefined);
});

test("runSeededBootCheck reports one line per instance and returns the decision", () => {
	const lines = [];
	const decision = runSeededBootCheck({
		expectations,
		list: () => ({ [HOST1]: booted(SOURCE_SAVE), [HOST2]: booted("world.zip") }),
		log: line => lines.push(line),
	});
	assert.equal(decision.category, "generated-world");
	assert.equal(lines.filter(l => l.includes("PASS")).length, 1);
	assert.equal(lines.filter(l => l.includes("FAIL")).length, 1);
});
