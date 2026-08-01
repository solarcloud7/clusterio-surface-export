// CLI-layer pin for `testkit log`, driven through --from-file so it runs with the cluster DOWN.
//
// WHY SUBPROCESS TESTS AND NOT JUST UNIT TESTS. path-oracle.test.mjs proves the oracle's verdicts.
// It does NOT prove that cmdLog acts on them: if the `if (!result.ok) fail(...)` line were dropped,
// every oracle test would still pass and the command would exit 0 on a mistyped path — which is
// precisely the failure this whole feature exists to prevent. The exit code is the contract, so the
// exit code has to be measured from outside the process.
//
// The fixture is a REAL capture from the live controller store (two entries, trimmed), not a
// hand-written shape. A hand-written fixture would keep passing after the real schema moved, which
// is how a green test starts lying.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../tools/tests/testkit/cli.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../../tools/tests/testkit/fixtures/transaction-log-sample.json", import.meta.url));

// Zero-subject is not a pass: a vanished fixture must fail loudly, not silently skip.
assert.ok(existsSync(FIXTURE), `missing fixture ${FIXTURE} — recapture it from the controller store `
	+ "rather than hand-writing one; see the header.");

/** Run the CLI, returning { status, stdout, stderr } for BOTH success and failure. */
function run(...args) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, "log", "--from-file", FIXTURE, ...args],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { status: 0, stdout, stderr: "" };
	} catch (error) {
		return { status: error.status, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
	}
}

test("a correct path exits 0 and prints the value WITH the record it came from", () => {
	const result = run("latest", "--field", "summary.import.total_ticks");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /summary\.import\.total_ticks = \d+/);
	assert.match(result.stdout, /\(store entry \d+ of \d+\)/,
		"without the header, a right-looking value from the WRONG record is indistinguishable from "
		+ "the right answer");
});

test("THE headline claim: a camel/snake typo exits 2 and names the real path", () => {
	const result = run("latest", "--field", "summary.import.totalTicks");
	assert.equal(result.status, 2, "an empty answer for a mistyped path is the whole defect");
	assert.match(result.stderr, /summary\.import\.total_ticks/);
	assert.match(result.stderr, /re-run with:\s+--field summary\.import\.total_ticks/,
		"a diagnosis without a runnable command still costs the reader a lookup");
	assert.equal(result.stdout.trim(), "", "a miss must not print a value on stdout");
});

test("a wrong subtree exits 2 and relocates", () => {
	const result = run("latest", "--field", "summary.phaseSpans");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /summary\.import\.phaseSpans/);
});

test("an ambiguous relocation exits 2 and refuses to choose", () => {
	// summary.phases.validationMs is the CONTROLLER's wait; summary.import.validation_ms is the
	// IN-GAME gate. Same name, different clocks. Picking one for the reader would be a wrong answer
	// half the time.
	const result = run("latest", "--field", "summary.validationMs");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /summary\.phases\.validationMs/);
	assert.match(result.stderr, /summary\.import\.validation_ms/);
	assert.match(result.stderr, /Not picking for you/);
});

test("falsy values are RESOLUTIONS, not misses", () => {
	// 0 and null are answers. Treating them as absent is the same conflation the whole command
	// exists to break — and it is the easy regression, because `if (!value)` reads so naturally.
	const zero = run("latest", "--field", "summary.import.tiles_ticks");
	assert.equal(zero.status, 0, zero.stderr);
	assert.match(zero.stdout, /tiles_ticks = 0/);

	const nul = run("latest", "--field", "summary.error");
	assert.equal(nul.status, 0, nul.stderr);
	assert.match(nul.stdout, /summary\.error = null/);
});

test("an unknown transferId exits 2 and lists real ids", () => {
	const result = run("9:999_definitely-not-real", "--field", "summary.result");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /no transaction log for "9:999_definitely-not-real"/);
	assert.match(result.stderr, /the most recent/, "must show what IS there, or the reader guesses again");
});

test("a genuine absence claims nothing about the transfer", () => {
	const result = run("latest", "--field", "summary.import.neverAddedField");
	assert.equal(result.status, 2);
	assert.match(result.stderr, /PATH does not exist in THIS record/);
	assert.doesNotMatch(result.stderr, /data loss/);
});

test("--list exits 0 and says which entry `latest` resolves to", () => {
	const result = run("--list");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /transaction log entr/);
	assert.match(result.stdout, /`latest` resolves to #\d+/,
		"'latest' is ambiguous unless the tool says what it picked");
});

test("--json carries the verdict in the payload as well as the exit code", () => {
	const ok = run("latest", "--field", "summary.import.total_ticks", "--json");
	assert.equal(ok.status, 0);
	assert.equal(JSON.parse(ok.stdout).ok, true);

	const miss = run("latest", "--field", "summary.import.totalTicks", "--json");
	assert.equal(miss.status, 2);
	const parsed = JSON.parse(miss.stdout);
	assert.equal(parsed.ok, false);
	assert.deepEqual(parsed.miss.nearMisses, ["summary.import.total_ticks"]);
});

test("usage errors exit 2, never 0", () => {
	for (const args of [[], ["latest"], ["--field", "summary.result"]]) {
		assert.equal(run(...args).status, 2, `\`log ${args.join(" ")}\` must be a usage error`);
	}
});
