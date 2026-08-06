"use strict";

/**
 * The append-only transfer audit ledger.
 *
 * Two properties here are the whole reason the ledger exists, and both are the OPPOSITE of how the
 * detail store behaves today:
 *
 *  - Damage is survivable. In `surface_export_transaction_logs.json` a single bad byte makes the
 *    loader surface zero history AND makes the writer refuse every future write until a human
 *    intervenes. Here a torn line costs exactly that line.
 *  - A terminal row outranks a start row regardless of file position, because transfer IDs are
 *    reused and position-last-wins would let a stale start row bury a finished transfer's verdict.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const distNode = path.join(__dirname, "..", "dist", "node");
const {
	buildAuditRow,
	appendAuditRow,
	loadAuditLedger,
	foldAuditRows,
	countRevisions,
	AUDIT_ERROR_MAX_CHARS,
} = require(path.join(distNode, "lib", "audit-ledger.js"));

function ledgerPath(label) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `surface-export-${label}-`));
	return path.join(dir, "surface_export_transaction_audit.jsonl");
}

function row(transferId, overrides = {}) {
	return buildAuditRow({
		transferId,
		rowKind: overrides.rowKind || "terminal",
		savedAt: overrides.savedAt ?? 1_000,
		eventCount: overrides.eventCount ?? 2,
		lastEventAt: overrides.lastEventAt ?? 1_010,
		info: {
			platformName: "pad",
			operationType: "transfer",
			sourceInstanceId: 1,
			targetInstanceId: 2,
			status: overrides.status || "completed",
			startedAt: overrides.savedAt ?? 1_000,
			...(overrides.info || {}),
		},
	});
}

test("rows round-trip through append and load", async () => {
	const file = ledgerPath("roundtrip");
	await appendAuditRow(file, row("1:001"));
	await appendAuditRow(file, row("1:002"));

	const { rows, skipped } = await loadAuditLedger(file);
	assert.equal(skipped.length, 0);
	assert.deepEqual(rows.map(r => r.transferId), ["1:001", "1:002"]);
	assert.equal(rows[0].status, "completed");
	assert.equal(rows[0].rowKind, "terminal");
});

test("an absent ledger is empty, not an error", async () => {
	const { rows, skipped } = await loadAuditLedger(ledgerPath("absent"));
	assert.deepEqual(rows, []);
	assert.deepEqual(skipped, []);
});

test("a torn final line costs that line and nothing else", async () => {
	// The realistic power-loss shape: the last append did not finish. Every earlier transfer must
	// still be readable, and the damage must be reported precisely enough to find by hand.
	const file = ledgerPath("torn");
	await appendAuditRow(file, row("1:001"));
	await appendAuditRow(file, row("1:002"));
	await fsp.appendFile(file, '{"transferId":"1:003","rowKi', "utf8");

	const { rows, skipped } = await loadAuditLedger(file);

	assert.deepEqual(rows.map(r => r.transferId), ["1:001", "1:002"], "earlier rows must survive");
	assert.equal(skipped.length, 1);
	assert.equal(skipped[0].lineNumber, 3);
	assert.ok(Number.isInteger(skipped[0].byteOffset) && skipped[0].byteOffset > 0,
		"a byte offset is what makes the damage findable in a 7 MB file");
});

test("damage in the MIDDLE is also survivable, not just at the tail", async () => {
	// A tail-only tolerance would be a happy-path assumption: disk corruption does not promise to
	// land on the last line.
	const file = ledgerPath("middle");
	await appendAuditRow(file, row("1:001"));
	await fsp.appendFile(file, "{ this is not json }\n", "utf8");
	await appendAuditRow(file, row("1:003"));

	const { rows, skipped } = await loadAuditLedger(file);

	assert.deepEqual(rows.map(r => r.transferId), ["1:001", "1:003"], "rows after the damage must load");
	assert.equal(skipped.length, 1);
	assert.equal(skipped[0].lineNumber, 2);
});

test("a well-formed line that is not an audit row is rejected, not half-loaded", async () => {
	const file = ledgerPath("notarow");
	await appendAuditRow(file, row("1:001"));
	await fsp.appendFile(file, '{"hello":"world"}\n', "utf8");

	const { rows, skipped } = await loadAuditLedger(file);
	assert.deepEqual(rows.map(r => r.transferId), ["1:001"]);
	assert.equal(skipped[0].reason, "not an audit row");
});

test("a terminal row beats a start row in EITHER file order", () => {
	// Both directions, because a rule that only holds one way is an accident of the fixture.
	const start = row("1:001", { rowKind: "start", savedAt: 2_000, status: "awaiting_validation" });
	const terminal = row("1:001", { rowKind: "terminal", savedAt: 1_000, status: "completed" });

	assert.equal(foldAuditRows([terminal, start]).get("1:001").status, "completed",
		"a late start row must not bury a finished verdict");
	assert.equal(foldAuditRows([start, terminal]).get("1:001").status, "completed",
		"and the normal order must agree");
});

test("between two terminal rows the later one wins", () => {
	// This is what makes a recycled transfer ID show its newest outcome rather than its first.
	const first = row("1:001", { savedAt: 1_000, status: "failed" });
	const second = row("1:001", { savedAt: 2_000, status: "completed" });
	assert.equal(foldAuditRows([first, second]).get("1:001").status, "completed");
});

test("revisions count terminal rows only", () => {
	const rows = [
		row("1:001", { rowKind: "start", status: "awaiting_validation" }),
		row("1:001", { status: "failed" }),
		row("1:001", { status: "completed" }),
		row("1:002"),
	];
	const counts = countRevisions(rows);
	assert.equal(counts.get("1:001"), 2, "two verdicts, and the start row is not one of them");
	assert.equal(counts.get("1:002"), 1);
});

test("a long error is truncated and says so", async () => {
	// handleValidationFailure joins up to three error strings, so this field is not bounded by any
	// single message. An untruncated one would defeat the point of a slim row.
	const long = "x".repeat(AUDIT_ERROR_MAX_CHARS + 500);
	const built = row("1:001", { info: { error: long } });

	assert.ok(built.error.length <= AUDIT_ERROR_MAX_CHARS + 1, "must be capped");
	assert.equal(built.errorTruncated, true);

	const short = row("1:002", { info: { error: "brief" } });
	assert.equal(short.error, "brief");
	assert.equal(short.errorTruncated, undefined, "the flag must not appear when nothing was cut");
});

test("a row carries no count maps — the reason it can be kept forever", () => {
	// The detail entry is ~9.3 KB because it embeds item/fluid count maps up to three times. A ledger
	// row that grew those would make "keep every transfer" unaffordable, which is the requirement
	// this whole file exists to serve.
	const built = row("1:001", { info: { error: "e" } });
	const serialized = JSON.stringify(built);
	assert.ok(serialized.length < 1024, `a row must stay small; got ${serialized.length} bytes`);
	for (const [key, value] of Object.entries(built)) {
		// `typeof null === "object"`, so null has to be allowed explicitly — several row fields are
		// legitimately null (no completedAt on a failure, no error on a success).
		assert.ok(value === null || typeof value !== "object", `${key} must be a scalar or null`);
	}
});

// ── Rotation ─────────────────────────────────────────────────────────────────
// Rotation is the ONLY thing in this design that can delete audit history, so these are written
// around what must survive it rather than around the renaming.

const {
	rotateIfNeeded,
	generationPath,
	DEFAULT_LEDGER_MAX_BYTES,
	DEFAULT_LEDGER_MAX_FILES,
} = require(path.join(distNode, "lib", "audit-ledger.js"));

test("no rotation below the threshold, and none for an absent file", async () => {
	const file = ledgerPath("no-rotate");
	assert.equal(await rotateIfNeeded(file, { maxBytes: 1024 }), false, "absent file must not rotate");
	await appendAuditRow(file, row("1:001"));
	assert.equal(await rotateIfNeeded(file, { maxBytes: 1024 * 1024 }), false);
	const { rows } = await loadAuditLedger(file);
	assert.equal(rows.length, 1);
});

test("ROTATED ROWS ARE STILL LOADED — the property rotation must never break", async () => {
	// A loader that read only the live file would drop every rotated transfer out of the index:
	// silently deleting the history this ledger exists to keep. That is the whole risk of rotation.
	const file = ledgerPath("rotate-load");
	await appendAuditRow(file, row("1:001"), { maxBytes: 1 });   // forces a rotation on the NEXT append
	await appendAuditRow(file, row("1:002"), { maxBytes: 1 });
	await appendAuditRow(file, row("1:003"), { maxBytes: 1 });

	assert.ok(fs.existsSync(generationPath(file, 1)), "a rotated generation must exist");
	const { rows } = await loadAuditLedger(file);
	assert.deepEqual(rows.map(r => r.transferId), ["1:001", "1:002", "1:003"],
		"every transfer must load, in chronological order, across the rotation boundary");
});

test("generations shift down and the oldest beyond the cap is dropped", async () => {
	const file = ledgerPath("rotate-shift");
	for (const id of ["1:001", "1:002", "1:003", "1:004"]) {
		await appendAuditRow(file, row(id), { maxBytes: 1, maxFiles: 2 });
	}

	assert.ok(!fs.existsSync(generationPath(file, 3)), "nothing may be kept beyond maxFiles");
	const { rows } = await loadAuditLedger(file, { maxFiles: 2 });
	// maxFiles=2 means live + 2 generations; the oldest row has aged out by design.
	assert.ok(rows.length >= 3 && rows.length <= 4);
	assert.equal(rows[rows.length - 1].transferId, "1:004", "the newest row is always present");
});

test("a damaged line in a ROTATED generation is reported with the file it is in", async () => {
	// A byte offset alone is ambiguous once more than one file exists.
	const file = ledgerPath("rotate-damage");
	await appendAuditRow(file, row("1:001"), { maxBytes: 1 });
	await appendAuditRow(file, row("1:002"), { maxBytes: 1 });
	fs.appendFileSync(generationPath(file, 1), "{ not json }\n");

	const { rows, skipped } = await loadAuditLedger(file);
	assert.ok(rows.some(r => r.transferId === "1:002"), "undamaged rows still load");
	assert.equal(skipped.length, 1);
	assert.match(skipped[0].file, /\.1\.jsonl$/, "the report must name which generation is damaged");
});

test("the default ceiling is stated, not implicit", async () => {
	// Rotation deletes history at the boundary, so the bound is asserted rather than left to a comment.
	assert.equal(DEFAULT_LEDGER_MAX_BYTES, 32 * 1024 * 1024);
	assert.equal(DEFAULT_LEDGER_MAX_FILES, 8);
	const ceilingBytes = DEFAULT_LEDGER_MAX_BYTES * (DEFAULT_LEDGER_MAX_FILES + 1);
	// ~614 bytes per row measured on a real store.
	assert.ok(ceilingBytes / 614 > 400_000, "the default ceiling must hold hundreds of thousands of transfers");
});
