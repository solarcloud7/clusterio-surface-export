import { test } from "node:test";
import assert from "node:assert/strict";

import { describeContainer, exitCodeFor, formatMiss, normalizeKey, resolvePath }
	from "../../tools/tests/testkit/path-oracle.mjs";

const ENTRY = {
	transferId: "2:001_pad",
	transferInfo: { platformName: "pad", status: "completed" },
	summary: {
		transferId: "2:001_pad",
		operationType: "transfer",
		result: "SUCCESS",
		totalDurationMs: 4200,
		phases: { transmissionMs: 120, validationMs: 454, cleanupMs: 30 },
		export: { instanceAsyncExportTicks: 10, exportedEntityCount: 542 },
		import: {
			total_ticks: 137,
			validation_ticks: 0,
			validation_ms: 0,
			entities_created: 542,
			entities_failed: 0,
			phaseSpans: [
				{ name: "delivery", startOffsetMs: 0, durationMs: 800 },
				{ name: "validation", startOffsetMs: 900, durationMs: 16 },
			],
		},
		validation: {
			itemCountMatch: true,
			cleanup_failed: false,
			fluidReconciliation: { highTempThreshold: 500, fluidPreservedPct: 100 },
			expectedItemCounts: { "iron-plate": 40, "copper-cable": 12 },
		},
		error: null,
	},
	events: [
		{ eventType: "started", message: "go", timestampMs: 1 },
		{ eventType: "import_complete", message: "done", timestampMs: 2, importMetrics: { total_ticks: 137 } },
	],
	savedAt: 99,
};

const miss = (path) => resolvePath(ENTRY, path);


test("a camel-vs-snake typo MISSES with exit 2 and names the real path", () => {
	const result = miss("summary.import.totalTicks");
	assert.equal(result.ok, false);
	assert.equal(exitCodeFor(result), 2, "must be an operational error, never a silent empty answer");
	assert.equal(result.stoppedAt, "summary.import", "stoppedAt is the last path that RESOLVED");
	assert.equal(result.failedSegment, "totalTicks");
	assert.deepEqual(result.nearMisses, ["summary.import.total_ticks"]);
	assert.match(formatMiss(result, { query: "summary.import.totalTicks" }), /--field summary\.import\.total_ticks/,
		"the message must carry a re-runnable command, not just a diagnosis");
});

test("the inverse direction too — one snake key inside a camelCase subtree", () => {
	const result = miss("summary.validation.cleanupFailed");
	assert.deepEqual(result.nearMisses, ["summary.validation.cleanup_failed"]);
});

test("it is NOT fuzzy — a near-spelling gets no suggestion", () => {
	for (const path of ["summary.import.totalTick", "summary.import.total", "summary.import.ticks"]) {
		const result = miss(path);
		assert.equal(result.ok, false);
		assert.deepEqual(result.nearMisses, [], `${path} must not produce a same-level suggestion`);
	}
});


test("a key in the wrong subtree is RELOCATED, not reported absent", () => {
	const result = miss("summary.phaseSpans");
	assert.deepEqual(result.nearMisses, []);
	assert.deepEqual(result.relocations.map(r => r.path), ["summary.import.phaseSpans"]);
});

test("relocation reaches through an array without spending a depth level", () => {
	const result = miss("summary.durationMs");
	const paths = result.relocations.map(r => r.path);
	assert.ok(paths.some(p => p.startsWith("summary.import.phaseSpans.")),
		`expected a phaseSpans element hit, got ${JSON.stringify(paths)}`);
	const hit = result.relocations.find(r => r.path.startsWith("summary.import.phaseSpans."));
	assert.match(hit.note, /present on 2 of 2 elements/,
		"a concrete index plus a presence count — a wildcard would force a second lookup");
});

test("AMBIGUOUS relocation reports every candidate and picks none", () => {
	const result = miss("summary.validationMs");
	const paths = result.relocations.map(r => r.path);
	assert.ok(paths.includes("summary.phases.validationMs"), `missing controller phase: ${paths}`);
	assert.ok(paths.includes("summary.import.validation_ms"), `missing in-game gate: ${paths}`);
	assert.match(formatMiss(result, { query: "summary.validationMs" }), /Not picking for you/);
});

test("the search does not reach into user-keyed count maps", () => {
	assert.deepEqual(miss("iron-plate").relocations.map(r => r.path), []);
	assert.deepEqual(miss("copper-cable").relocations.map(r => r.path), []);
	assert.deepEqual(resolvePath(ENTRY.summary.validation, "iron-plate").relocations.map(r => r.path),
		["expectedItemCounts.iron-plate"]);
});

test("the depth bound is EXACTLY three object levels — counted, not approximated", () => {
	assert.deepEqual(resolvePath({ a: { target: 1 } }, "target").relocations.map(r => r.path),
		["a.target"], "2 segments");
	assert.deepEqual(resolvePath({ a: { b: { target: 1 } } }, "target").relocations.map(r => r.path),
		["a.b.target"], "3 segments — the documented bound, inside it");
	assert.deepEqual(resolvePath({ a: { b: { c: { target: 1 } } } }, "target").relocations, [],
		"4 segments — OUTSIDE the bound. This is what stops a query for a quality name like `normal` "
		+ "relocating into summary.validation.expectedItemCounts, which is keyed by user data.");

	const viaArray = { a: { b: [{ target: 1 }] } };
	assert.deepEqual(resolvePath(viaArray, "target").relocations.map(r => r.path), ["a.b.0.target"],
		"array-element descent must not consume a segment of the depth budget");
	assert.equal(resolvePath(viaArray, "a.b.0.target").ok, true, "and the path it names must resolve");
});


test("falsy values RESOLVE — they are answers, not misses", () => {
	for (const [path, expected] of [
		["summary.import.entities_failed", 0],
		["summary.validation.cleanup_failed", false],
		["summary.error", null],
	]) {
		const result = resolvePath(ENTRY, path);
		assert.equal(result.ok, true, `${path} must resolve`);
		assert.equal(result.value, expected);
		assert.equal(exitCodeFor(result), 0);
	}
});

test("an array stop names the indexing fix and never lists numeric indices", () => {
	const result = miss("events.eventType");
	assert.equal(result.reason, "array-needs-index");
	assert.equal(result.container.kind, "array");
	assert.equal(result.container.count, 2);
	assert.ok(result.container.keys.includes("eventType"));
	assert.ok(result.container.keys.includes("importMetrics"),
		"element keys must be the UNION — importMetrics lives on exactly one event, and a "
		+ "first-element sample would hide it");
	assert.equal(result.container.keys.filter(k => /^\d+$/.test(k)).length, 0,
		"numeric indices are noise, never 'available keys'");
});

test("numeric indices walk, and out-of-range says so with the count", () => {
	assert.equal(resolvePath(ENTRY, "events.1.eventType").value, "import_complete");
	const result = miss("events.9999.eventType");
	assert.equal(result.reason, "index-out-of-range");
	assert.equal(result.container.count, 2);
});

test("`length` is refused rather than silently answered", () => {
	const result = miss("events.length");
	assert.equal(result.ok, false, "answering 2 here would be a plausible wrong answer to a wrong question");
	assert.match(result.detail, /JavaScript array property, not a key/);
});

test("every verdict has a strictly boolean `ok` and a defined exit code", () => {
	const queries = ["summary.import.total_ticks", "summary.import.totalTicks", "summary.phaseSpans",
		"events.eventType", "events.length", "events.9999.x", "", "a..b", "summary.error.deeper", "nope"];
	for (const query of queries) {
		const result = resolvePath(ENTRY, query);
		assert.equal(typeof result.ok, "boolean", `${JSON.stringify(query)} produced a non-boolean ok`);
		assert.ok([0, 2].includes(exitCodeFor(result)), `${JSON.stringify(query)} produced a bad exit code`);
	}
});

test("a malformed path is refused, not walked", () => {
	assert.equal(resolvePath(ENTRY, "").reason, "empty-path");
	assert.equal(resolvePath(ENTRY, "a..b").reason, "malformed-path");
	assert.equal(resolvePath(ENTRY, "summary.error.deeper").reason, "not-a-container");
});


test("a genuine absence says it is about the PATH, not about the data", () => {
	const text = formatMiss(miss("summary.import.somethingNeverAdded"),
		{ query: "summary.import.somethingNeverAdded", subject: "2:001_pad" });
	assert.match(text, /PATH does not exist in THIS record/);
	assert.doesNotMatch(text, /data loss|CANNOT survive/,
		"this module makes no claim about the transfer — that conflation is the original incident");
});


test("EVERY suggested path resolves — near-misses and relocations alike", () => {
	const queries = [
		"summary.import.totalTicks", "summary.validation.cleanupFailed", "summary.phaseSpans",
		"summary.durationMs", "summary.validationMs", "iron-plate", "events.importMetrics",
		"events.eventType", "events.entities_created", "phaseSpans", "startOffsetMs",
		"cleanup_failed", "total_ticks", "expectedItemCounts", "highTempThreshold",
	];
	let suggestionsChecked = 0;
	for (const query of queries) {
		const result = resolvePath(ENTRY, query);
		if (result.ok) continue;
		for (const suggested of [...result.nearMisses, ...result.relocations.map(r => r.path)]) {
			suggestionsChecked++;
			const round = resolvePath(ENTRY, suggested);
			assert.equal(round.ok, true,
				`query "${query}" suggested "${suggested}", which does not resolve `
				+ `(${round.reason}). Naming a path that 404s is the failure this module exists to prevent.`);
			assert.notEqual(suggested, query,
				`query "${query}" suggested ITSELF — an infinite loop of advice`);
		}
	}
	assert.ok(suggestionsChecked >= 8,
		`only ${suggestionsChecked} suggestions exercised; the invariant needs real coverage to mean anything`);
});

test("an array stop relocates to the element that actually has the key", () => {
	const result = resolvePath(ENTRY, "events.importMetrics");
	assert.deepEqual(result.nearMisses, [],
		"element keys are not addressable at the array level — offering them as same-level matches is "
		+ "what made the tool suggest the failing query back to the caller");
	assert.deepEqual(result.relocations.map(r => r.path), ["events.1.importMetrics"]);
	assert.equal(resolvePath(ENTRY, "events.1.importMetrics").ok, true);
});

test("relocation from the document root emits no doubled dots", () => {
	const result = resolvePath(ENTRY, "eventType");
	for (const hit of result.relocations) {
		assert.doesNotMatch(hit.path, /\.\./, `"${hit.path}" has a doubled dot`);
		assert.doesNotMatch(hit.path, /^\./, `"${hit.path}" has a leading dot`);
		assert.equal(resolvePath(ENTRY, hit.path).ok, true);
	}
	assert.ok(result.relocations.length > 0, "expected the events array to be searched");
});

test("normalizeKey and describeContainer behave as documented", () => {
	assert.equal(normalizeKey("total_ticks"), normalizeKey("totalTicks"));
	assert.notEqual(normalizeKey("total_tick"), normalizeKey("totalTicks"));
	assert.equal(describeContainer(null).kind, "null");
	assert.equal(describeContainer(7).kind, "number");
	assert.deepEqual(describeContainer({ a: 1, b: 2 }).keys, ["a", "b"]);
});
