// Offline pin for the query-path oracle (tools/tests/testkit/path-oracle.mjs).
//
// The oracle exists because querying a transaction log with a wrong path returned an EMPTY VALUE,
// not an error — three times in one session, and once producing the false conclusion that the log
// was not being written when the log was fine and the path was a typo. So the assertions that matter
// here are all on the MISS path: a resolution is trivial, naming the real key is the product.
//
// The shape below mirrors the real store deliberately, because the hard case is real: everything the
// TypeScript controller builds is camelCase, but `summary.import` comes straight from Lua and is
// snake_case — with exactly one camelCase key (`phaseSpans`) inside it. That one subtree is where
// every wrong query in the original session landed.

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

// ── The headline claim ──────────────────────────────────────────────────────────────────────

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
	// The anti-regression against a future Levenshtein "improvement". A matcher that eventually names
	// a path that is not the caller's field destroys the only thing this tool is for.
	for (const path of ["summary.import.totalTick", "summary.import.total", "summary.import.ticks"]) {
		const result = miss(path);
		assert.equal(result.ok, false);
		assert.deepEqual(result.nearMisses, [], `${path} must not produce a same-level suggestion`);
	}
});

// ── Relocation: right key, wrong subtree ────────────────────────────────────────────────────

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
	// The strongest case for refusing to pick: summary.phases.validationMs is the CONTROLLER's wait,
	// summary.import.validation_ms is the IN-GAME gate. Same name, different clocks, different things.
	const result = miss("summary.validationMs");
	const paths = result.relocations.map(r => r.path);
	assert.ok(paths.includes("summary.phases.validationMs"), `missing controller phase: ${paths}`);
	assert.ok(paths.includes("summary.import.validation_ms"), `missing in-game gate: ${paths}`);
	assert.match(formatMiss(result, { query: "summary.validationMs" }), /Not picking for you/);
});

test("an exact key in a user-keyed map IS named — that is the real path, not garbage", () => {
	// Worth stating, because the instinct is to suppress this. `expectedItemCounts` is keyed by ITEM
	// NAME, and a query for `iron-plate` really does resolve there. Naming it is correct: the rule is
	// exact-after-normalization, so a hit is a hit regardless of whether the key came from a schema
	// or from game data. What must never happen is MANUFACTURING a path, and schema names (camelCase)
	// cannot normalize onto item names (lowercase-hyphenated), so the two spaces do not collide.
	const result = miss("iron-plate");
	assert.deepEqual(result.relocations.map(r => r.path), ["summary.validation.expectedItemCounts.iron-plate"]);
});

test("the depth bound is a defined boundary, not an accident", () => {
	// Beyond the bound the search stops rather than trawling the whole document. Pinned with a
	// synthetic shape so the assertion does not drift when the real store gains a level.
	const deep = { a: { b: { c: { d: { target: 1 } } } } };
	assert.deepEqual(resolvePath(deep, "target").relocations.map(r => r.path), [],
		"4 object levels is beyond the 3-level bound");
	const shallow = { a: { b: { target: 1 } } };
	assert.deepEqual(resolvePath(shallow, "target").relocations.map(r => r.path), ["a.b.target"],
		"3 object levels is inside it");
	// And the array-is-free rule: a.b[].target is 3 OBJECT levels, so it stays reachable.
	const viaArray = { a: { b: [{ target: 1 }] } };
	assert.equal(resolvePath(viaArray, "target").relocations.length, 1,
		"array-element descent must not consume a depth level");
});

// ── Falsy values, arrays, and the exit-0 hole ───────────────────────────────────────────────

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
	// The direct anti-regression for cli.mjs:56-80, whose tri-state flag falls through to exit 0.
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

// ── The sentence that prevents the original false conclusion ─────────────────────────────────

test("a genuine absence says it is about the PATH, not about the data", () => {
	const text = formatMiss(miss("summary.import.somethingNeverAdded"),
		{ query: "summary.import.somethingNeverAdded", subject: "2:001_pad" });
	assert.match(text, /PATH does not exist in THIS record/);
	assert.doesNotMatch(text, /data loss|CANNOT survive/,
		"this module makes no claim about the transfer — that conflation is the original incident");
});

test("normalizeKey and describeContainer behave as documented", () => {
	assert.equal(normalizeKey("total_ticks"), normalizeKey("totalTicks"));
	assert.notEqual(normalizeKey("total_tick"), normalizeKey("totalTicks"));
	assert.equal(describeContainer(null).kind, "null");
	assert.equal(describeContainer(7).kind, "number");
	assert.deepEqual(describeContainer({ a: 1, b: 2 }).keys, ["a", "b"]);
});
