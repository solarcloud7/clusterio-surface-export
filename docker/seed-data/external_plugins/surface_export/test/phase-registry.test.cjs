"use strict";

// Offline contract test for the import phase registry (module/utils/phase-recorder.lua).
//
// WHY THIS FILE EXISTS. The registry was introduced to make a phase declarable in ONE place
// instead of five. That makes it the file where a bad edit does the most silent damage — and it
// shipped with two defects of exactly the class it was written to prevent, caught only by review:
//
//   1. `delivery` and `queue` were returned by profiler_names() but are bracketed by nobody. A
//      LuaProfiler that is created and never started reads 0.000 ms forever, and both consumers
//      (transaction-history, transaction-dashboard) iterate every key they are handed — so the
//      phantom does not render as ABSENT, it renders as INSTANT. That would have put "0 ms" next
//      to `delivery`, routinely the longest span in the trace.
//   2. `tiles` and `entities` were silently given cross-tick profilers, mixing a different
//      quantity into a table where every other entry brackets one synchronous section.
//
// Neither is visible in a green transfer: the numbers are simply wrong, and wrong quietly. The
// live suite cannot see them either — it asserts fidelity, not that a timing label measures the
// window it names. So the guard has to be here, offline, in the shape of the invariants.
//
// Style follows census-meter.test.cjs (plain `node --test`, zero deps). IMPORT_PHASES itself is
// read as DATA via the vendored luaparse rather than by regex, so `profiled = false` and the
// from/to pairing are checked as values, not as text that happens to appear in the file.
//
// Deliberately NOT executed: there is no Lua VM in the build container (scoop's lua.exe is this
// developer's machine only), and a skip-if-absent test is the vacuous pass this repo rejects.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const luaparse = require("../scripts/vendor/luaparse.cjs");

const moduleRoot = path.join(__dirname, "..", "module");
const read = (...parts) => fs.readFileSync(path.join(moduleRoot, ...parts), "utf8");

const recorderSrc = read("utils", "phase-recorder.lua");
const pipelineSrc = read("core", "import-pipeline.lua");
const completionSrc = read("core", "import-completion.lua");
const entityCreationSrc = read("import_phases", "entity_creation.lua");

// The bracketing scan covers the IMPORT path only. export-pipeline.lua brackets a `completion`
// profiler that is deliberately not an import phase; including it would fail rule R4 forever.
const IMPORT_CALL_SITES = [
	["import-pipeline.lua", pipelineSrc],
	["import-completion.lua", completionSrc],
];

// ── Read IMPORT_PHASES as data ──────────────────────────────────────────────────────────────

/** Unwrap a luaparse literal to a JS value; returns undefined for anything else. */
function literal(node) {
	if (!node) return undefined;
	if (node.type === "StringLiteral") {
		return node.value !== undefined && node.value !== null
			? node.value
			: String(node.raw).slice(1, -1);
	}
	if (node.type === "BooleanLiteral") return node.value;
	if (node.type === "NumericLiteral") return node.value;
	return undefined;
}

function parseImportPhases(source) {
	const ast = luaparse.parse(source, { luaVersion: "5.2", comments: false });
	let table = null;
	for (const stmt of ast.body) {
		if (stmt.type !== "AssignmentStatement") continue;
		const target = stmt.variables[0];
		if (target && target.type === "MemberExpression" && target.identifier.name === "IMPORT_PHASES") {
			table = stmt.init[0];
			break;
		}
	}
	assert.ok(table && table.type === "TableConstructorExpression",
		"PhaseRecorder.IMPORT_PHASES must be a literal table assignment — this test reads it as data");

	return table.fields.map((entry, index) => {
		assert.equal(entry.value.type, "TableConstructorExpression",
			`IMPORT_PHASES[${index + 1}] must be a table literal`);
		const spec = {};
		for (const field of entry.value.fields) {
			assert.equal(field.type, "TableKeyString",
				`IMPORT_PHASES[${index + 1}] must use plain key = value fields`);
			spec[field.key.name] = literal(field.value);
		}
		return spec;
	});
}

const PHASES = parseImportPhases(recorderSrc);

/** The LuaProfiler key for a phase — `profiler` when it differs from the span name (hub/hub_restore). */
const profilerKey = (spec) => spec.profiler || spec.name;
const profiledPhases = PHASES.filter((spec) => spec.profiled !== false);

// ── The expected registry, pinned ───────────────────────────────────────────────────────────
//
// These two lists are the point of the file. They are not a restatement of the source — they are
// the shape verified on a live 2.1.11 transfer (11 profilers in the dashboard snapshot, 13 spans
// in the waterfall; `delivery` is the 14th span-capable phase and is absent on a non-chunked
// import). Adding or removing a phase must be a DELIBERATE edit here, reviewed against what the
// dashboard and the waterfall will actually show.

const EXPECTED_PROFILERS = [
	"activation", "beacons", "belts", "fluids", "held_items", "hub_restore",
	"inventories", "loss_analysis", "queue_setup", "state", "validation",
];

const EXPECTED_SPANS = [
	"delivery", "queue", "tiles", "entities", "hub", "belts", "state",
	"inventories", "held_items", "fluids", "validation", "activation", "loss_analysis",
];

test("R0: every phase has a unique name", () => {
	const names = PHASES.map((spec) => spec.name);
	for (const [i, name] of names.entries()) {
		assert.equal(typeof name, "string", `IMPORT_PHASES[${i + 1}] must declare a string name`);
	}
	assert.deepEqual(names, [...new Set(names)],
		"duplicate phase name — by_name lookup would silently resolve to the last one");
});

test("R1: profiler_names() yields exactly the phases that are meant to be profiled", () => {
	assert.deepEqual(profiledPhases.map(profilerKey).sort(), [...EXPECTED_PROFILERS].sort(),
		"the profiler set changed. A profiler nothing brackets renders as 0.000 ms (INSTANT), not as "
		+ "missing data — if this is intentional, update EXPECTED_PROFILERS and say why in the commit");
});

test("R2: a phase declaring an end boundary also declares a start (or the span is dropped)", () => {
	for (const spec of PHASES) {
		if (spec.to) {
			assert.ok(spec.from || spec.from_job,
				`phase '${spec.name}' has 'to' but neither 'from' nor 'from_job' — build_spans requires `
				+ "both boundaries, so this span would be silently omitted from every waterfall");
		}
		if (spec.from && spec.from_job) {
			assert.fail(`phase '${spec.name}' declares both 'from' and 'from_job' — build_spans prefers `
				+ "from_job, so 'from' would be dead and misleading");
		}
	}
});

test("R3: build_spans emits exactly the expected spans, in pipeline order", () => {
	const emitted = PHASES
		.filter((spec) => spec.to && (spec.from || spec.from_job))
		.map((spec) => spec.name);
	assert.deepEqual(emitted, EXPECTED_SPANS,
		"the waterfall changed shape. Order is significant (build_spans emits in IMPORT_PHASES order) "
		+ "and the web stitches these onto the transfer timeline");
});

// ── Bracketing: the defect that shipped ─────────────────────────────────────────────────────
//
// Two mechanisms bracket a profiler, and both are legitimate today:
//   PhaseRecorder.start(job, "<span name>")      — 9 phases; resolves through `profiler or name`
//   PhaseProfiler.start(job_id, "<profiler>")    — queue_setup and validation, which bracket a
//                                                  narrower region than their tick marks cover
// The union is what matters: a profiler is real if SOMETHING starts and stops it.

/** Phase names passed to PhaseRecorder.start/stop. These are SPAN names, profiled or not. */
function recorderNames(kind) {
	const re = new RegExp(String.raw`PhaseRecorder\.${kind}\s*\(\s*job\s*,\s*"([^"]+)"`, "g");
	const found = new Set();
	for (const [, source] of IMPORT_CALL_SITES) {
		for (const m of source.matchAll(re)) found.add(m[1]);
	}
	return found;
}

/** Profiler keys passed to PhaseProfiler.start/stop directly, bypassing the recorder. */
function rawProfilerKeys(kind) {
	const re = new RegExp(String.raw`PhaseProfiler\.${kind}\s*\(\s*[\w.]+\s*,\s*"([^"]+)"`, "g");
	const found = new Set();
	for (const [, source] of IMPORT_CALL_SITES) {
		for (const m of source.matchAll(re)) found.add(m[1]);
	}
	return found;
}

/** Profiler keys a phase actually gets started/stopped under, via either mechanism. */
function bracketedProfilers(kind) {
	const found = new Set(rawProfilerKeys(kind));
	for (const name of recorderNames(kind)) {
		const spec = PHASES.find((s) => s.name === name);
		if (spec && spec.profiled !== false) found.add(profilerKey(spec));
	}
	return found;
}

test("R4: every profiled phase is actually bracketed — no phantom 0.000 ms profilers", () => {
	const started = bracketedProfilers("start");
	const stopped = bracketedProfilers("stop");
	for (const spec of profiledPhases) {
		const key = profilerKey(spec);
		assert.ok(started.has(key),
			`profiler '${key}' is created by profiler_names() but nothing STARTS it. It will read `
			+ "0.000 ms forever and render as INSTANT in the dashboard, not as absent. Either bracket "
			+ `it or mark phase '${spec.name}' with profiled = false.`);
		assert.ok(stopped.has(key),
			`profiler '${key}' is started but never STOPPED — it accumulates past its own phase.`);
	}
});

test("R5: every PhaseRecorder call site names a phase the registry declares", () => {
	const declared = new Set(PHASES.map((spec) => spec.name));
	for (const kind of ["start", "stop"]) {
		for (const name of recorderNames(kind)) {
			assert.ok(declared.has(name),
				`PhaseRecorder.${kind} names '${name}', which is not in IMPORT_PHASES. spec_for only `
				+ "LOGS an unknown name (error() on the on_tick path kills a headless server), so a typo "
				+ "here records nothing and reports nothing — the phase just quietly stops existing.");
		}
	}
});

test("R6: a raw PhaseProfiler bracket names a declared profiler", () => {
	const declared = new Set(profiledPhases.map(profilerKey));
	for (const kind of ["start", "stop"]) {
		for (const key of rawProfilerKeys(kind)) {
			assert.ok(declared.has(key),
				`PhaseProfiler.${kind} brackets '${key}', which profiler_names() never creates. `
				+ "PhaseProfiler is a silent no-op on a key absent from init(), so this timing is "
				+ "collected nowhere and nothing says so.");
		}
	}
});

// ── The entity counters: measured tallies, never a subtraction ───────────────────────────────
//
// `entities_failed` used to be `job.total_entities - <created>`, which counted every deliberately
// unmapped ground item as a placement failure — it reported 106 failures on a transfer with zero,
// at exact item parity. The fix was to report the per-batch tally the create loop already had.
// Regressing to arithmetic here is invisible: the number still looks like a number.

test("R7: entity outcome counters are accumulated from measured batch tallies", () => {
	for (const counter of ["entities_created", "entities_failed", "entities_skipped"]) {
		const accumulate = new RegExp(
			String.raw`job\.metrics\.${counter}\s*=\s*\(job\.metrics\.${counter}\s*or\s*0\)\s*\+`);
		assert.match(entityCreationSrc, accumulate,
			`${counter} must accumulate the MEASURED per-batch tally in entity_creation.lua`);
	}
});

test("R8: no entity counter is reconstructed by subtraction", () => {
	const writers = [
		["import-pipeline.lua", pipelineSrc],
		["import-completion.lua", completionSrc],
		["entity_creation.lua", entityCreationSrc],
	];
	for (const [name, source] of writers) {
		const lines = source.split(/\r?\n/);
		for (const [i, line] of lines.entries()) {
			if (line.trimStart().startsWith("--")) continue;
			const assignment = /\b(entities_failed|entities_created|entities_skipped)\s*=\s*([^,\n]+)/.exec(line);
			if (!assignment) continue;
			assert.doesNotMatch(assignment[2], /-/,
				`${name}:${i + 1} derives ${assignment[1]} by subtraction. That is the defect that `
				+ "reported 106 phantom failures: a subtraction cannot tell 'not created' from "
				+ "'not indexed'. Report the measured tally.");
		}
	}
});

test("R9: entities_mapped counts entity_map membership, not placement success", () => {
	assert.match(pipelineSrc, /job\.metrics\.entities_mapped\s*=/,
		"entities_mapped must be set in import-pipeline.lua");
	assert.match(pipelineSrc, /for\s+_\s+in\s+pairs\s*\(\s*job\.entity_map[^)]*\)/,
		"entities_mapped must be counted by walking entity_map — it is an ADDRESSABILITY index. Ground "
		+ "items are placed without being mapped, which is why the old subtraction misread them as failures.");
});
