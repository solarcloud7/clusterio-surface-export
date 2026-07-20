// pad-transfer-suite — the P5 transfer orchestrator of the pad lifecycle framework.
//
// For every manifest fixture whose lifecycle act is "transfer": load the certified golden pair
// (SOURCE = the gallery snapshot-of-live on host-1, DEST = the empty destination save on host-2),
// push the roster to BOTH ends, run lifecycle_setup on the source (programmatic, write-asserted),
// then fire the PRODUCTION /transfer-platform of the namespaced scratch platform and verify:
//   * dest: the fixture's declared verify list (physical reads via the lifecycle engine)
//   * report_field checks against the dest debug_import_result JSON (grounded: they ride alongside
//     the physical reads, never alone — enforced by the manifest validator)
//   * source-after-act: the scratch platform is GONE (two-phase-commit source delete)
// Teardown is guaranteed (finally): lifecycle_teardown both ends, zero-leftover sweep
// (no se-lifecycle-scratch-* platform anywhere, no lifecycle run records), restore the live pair.
//
// The suite NEVER touches the live gallery instance: host-1/host-2 run save COPIES of the banked
// artifacts (certified single-use baked-fixture batch, docs/testing.md lifecycle). Preflight
// asserts the banked source artifact's SHA equals the manifest pin, refusing to certify a stale
// or tampered snapshot.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBatchLifecycle } from "../../lab-gallery/batch-lifecycle.mjs";
import { loadGalleryManifest, validateGalleryManifest } from "../../lab-gallery/manifest.mjs";

const repoRootUrl = new URL("../../../", import.meta.url);
const repoRoot = fileURLToPath(repoRootUrl);

const L = createBatchLifecycle({
	goldenSourceSave: "pad-transfer-source.zip",
	goldenDestSave: "pad-transfer-dest.zip",
	markerPrefix: "pad-transfer",
});

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

// Long-bracket wrap for embedding JSON in a /sc remote.call (same guard as push-roster).
function bracketWrap(text) {
	for (let level = 1; level < 10; level++) {
		const eq = "=".repeat(level);
		if (!text.includes(`]${eq}]`)) return `[${eq}[${text}]${eq}]`;
	}
	throw new Error("no safe long-bracket level for payload");
}

function pushRoster(instanceName) {
	const out = execFileSync(process.execPath,
		[`${repoRoot}tests/lab-gallery/push-roster.mjs`, "--instance", instanceName],
		{ encoding: "utf8", timeout: 300_000 });
	if (!/echo-verify OK/.test(out)) throw new Error(`roster push to ${instanceName} failed:\n${out}`);
	return out.trim().split(/\r?\n/).at(-1);
}

// Evaluate a report_field check against the dest debug_import_result JSON.
function evalReportField(check, importResult) {
	// Only "eq" is implemented; a new op must be added HERE, loudly — a silent always-fail would
	// masquerade as a real mismatch (review finding F3).
	if (check.op !== "eq") throw new Error(`report_field op "${check.op}" not implemented in the orchestrator`);
	const value = check.path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), importResult);
	const pass = value === check.expected;
	return { name: `report.${check.path}`, verdict: pass ? "pass" : "fail", detail: `actual=${JSON.stringify(value)} ${check.op} ${JSON.stringify(check.expected)}` };
}

async function runFixture(fixture, runId, destInstanceId, results) {
	const id = fixture.id;
	const checks = [];
	const setup = L.lua(1, `return remote.call('surface_export','lifecycle_setup','${id}','${runId}')`);
	if (!setup.ok) throw new Error(`${id}: lifecycle_setup failed: ${JSON.stringify(setup)}`);
	console.log(`  [${id}] setup ok — scratch ${setup.scratchName} (index ${setup.scratchIndex})`);

	const marker = L.dropMarker(2, id);
	const transferOut = L.lastLine(L.rcon(1, `/transfer-platform ${setup.scratchIndex} ${destInstanceId}`));
	console.log(`  [${id}] transfer fired: ${transferOut}`);

	const { result: importResult, path: resultPath } = await L.waitForImportResult(2, marker);
	console.log(`  [${id}] import result: ${resultPath} validation_success=${importResult.validation_success}`);

	// report_field checks (orchestrator-side, grounded by the physical reads below).
	for (const check of fixture.lifecycle.verify || []) {
		if (check.check === "report_field") checks.push(evalReportField(check, importResult));
	}

	// dest physical verify via the lifecycle engine (roster pushed on host-2 too).
	const payload = JSON.stringify({ scratchName: setup.scratchName, captured: setup.captured || {} });
	const destVerify = L.lua(2,
		`return remote.call('surface_export','lifecycle_verify','${id}','dest',${bracketWrap(payload)})`);
	if (!destVerify.ok) throw new Error(`${id}: dest lifecycle_verify errored: ${JSON.stringify(destVerify)}`);
	for (const check of destVerify.checks || []) checks.push(check);
	if (!destVerify.platformPresent) checks.push({ name: "dest.platform", verdict: "fail", detail: "scratch absent on dest" });

	// source-after-act: two-phase commit must delete the source scratch — but that delete is the
	// LAST 2PC step (dest gate -> controller round-trip -> host-1 delete, surface removal deferred
	// to tick end), so a single immediate read races it (review finding F1; same reason
	// deliver-all-fixtures polls srcGone). Poll on a deadline; false-FAIL direction only.
	let scratchGone = false;
	const deleteDeadline = Date.now() + 60_000;
	while (Date.now() < deleteDeadline) {
		const sourceAfter = L.lua(1, `return remote.call('surface_export','lifecycle_verify','${id}','source-after-act','')`);
		if (sourceAfter.scratchGone) { scratchGone = true; break; }
		await L.sleep(2000);
	}
	checks.push({ name: "source.scratchGone", verdict: scratchGone ? "pass" : "fail",
		detail: `scratchGone=${scratchGone}${scratchGone ? "" : " (still present after 60s poll)"}` });

	const failed = checks.filter(check => check.verdict === "fail");
	results.fixtures.push({ id, verdict: failed.length ? "fail" : "pass", checks });
	for (const check of checks) console.log(`  [${id}] ${check.verdict.toUpperCase()} ${check.name}: ${check.detail}`);
	return failed.length === 0;
}

async function main() {
	const manifest = loadGalleryManifest(repoRootUrl);
	validateGalleryManifest(manifest, { requireArtifacts: false });

	// SHA preflight: the banked source artifact must equal the manifest pin (design decision 1).
	const artifactSha = sha256(`${repoRoot}${manifest.saves.source.artifact}`);
	if (artifactSha !== manifest.saves.source.sha256.toUpperCase()) {
		console.error(`PREFLIGHT REFUSED: source artifact SHA ${artifactSha} != manifest pin ${manifest.saves.source.sha256}`);
		process.exit(1);
	}
	console.log(`preflight: source artifact SHA matches manifest pin (${artifactSha.slice(0, 12)}...)`);

	const transferFixtures = manifest.fixtures.filter(fixture => fixture.lifecycle?.act === "transfer");
	if (!transferFixtures.length) {
		console.log("no transfer-act fixtures in the manifest — nothing to run");
		return;
	}
	console.log(`transfer fixtures: ${transferFixtures.map(fixture => fixture.id).join(", ")}`);

	const results = { fixtures: [] };
	const boundaryErrors = [];
	const runId = Date.now().toString(36);
	let allPass = true;
	try {
		await L.loadGoldenPair(manifest, "pad-transfer preflight");
		for (const host of [1, 2]) console.log(`roster: ${pushRoster(L.HOSTS[host].instance)}`);
		for (const fixture of transferFixtures) {
			try {
				const pass = await runFixture(fixture, runId, L.instanceIds()[2], results);
				allPass = allPass && pass;
			} catch (error) {
				allPass = false;
				results.fixtures.push({ id: fixture.id, verdict: "fail", checks: [], error: error.message });
				console.error(`  [${fixture.id}] ERROR: ${error.message}`);
			} finally {
				for (const host of [1, 2]) {
					try {
						const teardown = L.lua(host, `return remote.call('surface_export','lifecycle_teardown','${fixture.id}')`);
						console.log(`  [${fixture.id}] teardown host ${host}: ${JSON.stringify(teardown)}`);
					} catch (error) { boundaryErrors.push(`teardown ${fixture.id} host ${host}: ${error.message}`); }
				}
			}
		}
		// Zero-leftover sweep on the golden pair BEFORE restore (scratch platforms + run records).
		for (const host of [1, 2]) {
			const leftovers = L.lua(host, `return remote.call('surface_export','lifecycle_leftovers')`);
			if ((leftovers.leftovers || []).length || leftovers.records) {
				allPass = false;
				boundaryErrors.push(`host ${host} leftovers: ${JSON.stringify(leftovers)}`);
			}
		}
	} finally {
		await L.restoreLivePair(results, boundaryErrors);
	}

	console.log("\n=== pad-transfer-suite summary ===");
	for (const fixture of results.fixtures) console.log(`  ${fixture.verdict.toUpperCase()} ${fixture.id}${fixture.error ? ` (${fixture.error})` : ""}`);
	for (const error of boundaryErrors) console.error(`  BOUNDARY: ${error}`);
	if (results.restored?.zeroLeftovers) console.log("  restore: live pair restored, zero leftovers");
	if (!allPass || boundaryErrors.length) process.exit(1);
	console.log("ALL PASS");
}

await main();
