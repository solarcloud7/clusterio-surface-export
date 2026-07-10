#!/usr/bin/env node
/**
 * lint-version-certification.mjs — the engine pin cannot move without re-certifying the labs.
 *
 * Paid for by a real incident: the pinned Factorio version moved 2.0.76 -> 2.0.77 and nobody re-ran
 * the labs until a campaign audit forced it — which then found REAL behavioral drift
 * (LuaSpacePlatform.destroy(0) / destroy(60) changed semantics between the two builds; measured in
 * tests/engine-repin-lab, commit 00e44c7). The written rule "a pin bump means re-run every lab" had
 * no teeth, so the bump shipped uncertified. The labs ARE the drift-detection suite; a version bump
 * that skips them is a silent bet that nothing changed — and that bet lost.
 *
 * Rule: the pinned Factorio version MUST EQUAL the certified version.
 *   - pinned version   = single source of truth = host-1 instance.json -> "factorio.version"
 *                        (the exact file + extraction the CI "Resolve & verify pinned Factorio
 *                        version" step uses).
 *   - certified version = tests/labs-certified.json -> "factorio_version", a committed record that
 *                        every tests/*-lab runner was re-run on this pin, with the evidence commits.
 * A mismatch is RED: the pin advanced without lab re-certification. There is deliberately NO escape
 * hatch — re-running the labs is the whole point, and a genuine bump always can (and must) do it.
 *
 * Run:   node scripts/lint-version-certification.mjs        (also: npm run lint:version-certification)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// scripts/ -> surface_export -> external_plugins -> seed-data -> docker -> <repo root>
const REPO_DIR = join(SCRIPT_DIR, "..", "..", "..", "..", "..");
const INSTANCE_JSON = join(
	REPO_DIR,
	"docker", "seed-data", "hosts", "clusterio-host-1", "clusterio-host-1-instance-1", "instance.json",
);
const RECORD_JSON = join(REPO_DIR, "tests", "labs-certified.json");

function fail(msg) {
	console.error("lint-version-certification: " + msg);
	process.exit(1);
}

// ---------- read the pin (same extraction as the CI workflow) ----------
let pinnedRaw;
try {
	pinnedRaw = readFileSync(INSTANCE_JSON, "utf8");
} catch (e) {
	fail(`cannot read the pin source ${INSTANCE_JSON}: ${e.message}`);
}
const pinMatch = pinnedRaw.match(/"factorio\.version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+)"/);
if (!pinMatch) {
	fail(`could not resolve "factorio.version" from ${INSTANCE_JSON} (the single source of truth for the pin).`);
}
const pinned = pinMatch[1];

// ---------- read the certification record ----------
let record;
try {
	record = JSON.parse(readFileSync(RECORD_JSON, "utf8"));
} catch (e) {
	fail(
		`cannot read/parse the certification record ${RECORD_JSON}: ${e.message}\n`
		+ "  Create tests/labs-certified.json recording that every tests/*-lab runner was re-run on the "
		+ "current pin ({ factorio_version, certified_at, evidence: [...] }).",
	);
}
const certified = record.factorio_version;
if (!certified || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(certified)) {
	fail(`tests/labs-certified.json has no valid "factorio_version" (found: ${JSON.stringify(certified)}).`);
}

// ---------- the gate ----------
if (pinned !== certified) {
	fail(
		`the engine pin moved without lab re-certification — re-run every tests/*-lab runner on the new pin `
		+ `and update tests/labs-certified.json in the same PR (the labs are the drift-detection suite; this `
		+ `rule exists because 2.0.76->2.0.77 shipped real destroy() semantics drift).\n`
		+ `  pinned  (host-1 instance.json): ${pinned}\n`
		+ `  certified (tests/labs-certified.json): ${certified}`,
	);
}

const labs = Array.isArray(record.evidence) ? record.evidence.length : 0;
console.log(`lint-version-certification: OK (pin ${pinned} == certified ${certified}; ${labs} lab evidence entr${labs === 1 ? "y" : "ies"})`);
