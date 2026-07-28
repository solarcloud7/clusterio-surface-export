// gallery-suite — THE consolidated integration runner (owner consolidation order 2026-07-27).
//
// One-test-save doctrine, executed literally: the pads ARE the tests, the gallery platform is the
// transfer subject, and the whole suite is FIVE steps over one golden pair:
//   A. /test-run on host-1              — every pad's local capture/paste law, on the LIVE world
//   B. ONE production transfer of the whole gallery platform host-1 -> host-2 (the moving-world
//      test: the world is UNFROZEN per owner doctrine, so mid-motion capture, the in-transit
//      class, and the over-compression merge ride every run)
//   C. /test-run on host-2 against the transferred copy — destination parity for EVERY fixture
//   D. one hook-armed refusal transfer (host-2 -> host-1 with test_force_validation_failure) —
//      the 2PC contract: refusal, source preserved, black box banked
//   E. the WEB UI IMPORT feature probe — a real historical payload file without
//      item_source_positions uploads through the production door and is REFUSED loudly with the
//      server alive (the F1 server-death class, end to end)
// Finalizer (unconditional): restore the live pair, zero leftovers.
//
// Deleted standing runners and where their coverage class lives now (incident rule — deletions
// are accounted by PROBLEM CLASS, never by reachability):
//   passenger-evacuate    -> the live whole-platform transfer (B) IS the live-source test
//   gateway-transfer      -> owner law: no testing of WHEN a platform may teleport
//   name-collision-delete -> structural fix (surface index, never name) stands; owner-ruled untested
//   destination-hold      -> owner-ruled not useful
//   pad-transfer-suite    -> replaced by (B)+(C): one transfer, every fixture verified at dest
//   belt-loss-replay      -> folded in as (E) with its banked fixture.json
//   fluid-segment-law, selftests, engine-invariants -> tests/instruments/ (engine-bump
//   re-certification tools, invocable on demand, not standing gates)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBatchLifecycle } from "../../lab-gallery/batch-lifecycle.mjs";
import { loadGalleryManifest, validateGalleryManifest } from "../../lab-gallery/manifest.mjs";

const repoRootUrl = new URL("../../../", import.meta.url);
const repoRoot = fileURLToPath(repoRootUrl);
const L = createBatchLifecycle({
	goldenSourceSave: "gallery-suite-source.zip",
	goldenDestSave: "gallery-suite-dest.zip",
	markerPrefix: "gallery-suite",
});

const results = { steps: [] };
const boundaryErrors = [];
let failed = 0;
function step(name, ok, detail) {
	results.steps.push({ name, ok, detail });
	console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed++;
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex").toUpperCase();
}

function pushRoster(instanceName) {
	const out = execFileSync(process.execPath,
		[`${repoRoot}tests/lab-gallery/push-roster.mjs`, "--instance", instanceName],
		{ encoding: "utf8", timeout: 300_000 });
	if (!/echo-verify OK/.test(out)) throw new Error(`roster push to ${instanceName} failed:\n${out}`);
	return out.trim().split(/\r?\n/).at(-1);
}

// Run /test-run on a host and parse its machine-readable verdict line.
function runBoard(host) {
	const raw = L.rcon(host, "/test-run");
	const line = raw.split(/\r?\n/).find(l => l.includes("[TESTRUN-JSON]"));
	if (!line) throw new Error(`host ${host}: no TESTRUN-JSON line in /test-run output:\n${raw.slice(-800)}`);
	return JSON.parse(line.slice(line.indexOf("{")));
}

function boardOk(board, manifest) {
	const excluded = manifest.fixtures.filter(f => f.runnerExcluded).length;
	return board.failed === 0 && board.missing === 0 && board.unknown === 0
		&& board.skipped === excluded;
}

function platformIndex(host, name) {
	const r = L.lua(host, `for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then return {success=true,index=p.index} end end ` +
		`return {success=false,error='platform not found: ${name}'}`);
	if (!r.success) throw new Error(`host ${host}: ${r.error}`);
	return r.index;
}

function platformPresent(host, name) {
	const r = L.lua(host, `for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then return {success=true,present=true} end end ` +
		`return {success=true,present=false}`);
	return r.present === true;
}

async function main() {
	const manifest = loadGalleryManifest(repoRootUrl);
	validateGalleryManifest(manifest);
	const platformName = "lab-omnibus-state-v1";

	// Preflight: the banked artifacts must match the manifest pins — refuse stale/tampered saves.
	for (const roleKey of ["source", "destination"]) {
		const pin = manifest.saves[roleKey];
		const actual = sha256(`${repoRoot}${pin.artifact}`);
		if (actual !== pin.sha256) {
			throw new Error(`${roleKey} artifact SHA mismatch: ${actual} != pinned ${pin.sha256}`);
		}
	}
	console.log("preflight: both artifact SHAs match the manifest pins");

	const ids = L.instanceIds();
	try {
		await L.loadGoldenPair(manifest, "load");
		for (const host of [1, 2]) console.log(`roster: ${pushRoster(L.HOSTS[host].instance)}`);

		// A. The board on the live source world.
		const boardA = runBoard(1);
		step("board.host1", boardOk(boardA, manifest),
			`passed=${boardA.passed} failed=${boardA.failed} skipped=${boardA.skipped}`);

		// B. ONE production transfer of the whole live gallery platform.
		const index = platformIndex(1, platformName);
		const marker = L.dropMarker(2, "gallery-transfer");
		L.rcon(1, `/transfer-platform ${index} ${ids[2]}`);
		const { result } = await L.waitForImportResult(2, marker);
		step("transfer.gate", result.validation_success === true,
			`validation_success=${result.validation_success}` +
			(result.validation_result && result.validation_result.mismatchDetails
				? ` — ${result.validation_result.mismatchDetails}` : ""));
		step("transfer.sourceDeleted", !platformPresent(1, platformName),
			"two-phase commit removes the source on success");

		// C. The board on the transferred copy — destination parity for every fixture.
		const boardC = runBoard(2);
		const cOk = boardOk(boardC, manifest);
		step("board.host2.transferred", cOk,
			`passed=${boardC.passed} failed=${boardC.failed} missing=${boardC.missing} unknown=${boardC.unknown} skipped=${boardC.skipped}`);
		if (!cOk) {
			const bad = (boardC.results || []).filter(r => r.verdict !== "pass");
			console.log("  board.host2 non-pass verdicts: " +
				bad.map(r => `${r.id}=${r.verdict}${r.detail ? `(${String(r.detail).slice(0, 80)})` : ""}`).join(" | "));
		}

		// D. Hook-armed refusal transfer back (2PC contract). The hook is in FAIL_SAFE_HOOKS and
		// consumed by the import; the finally below also disarms it defensively.
		const backIndex = platformIndex(2, platformName);
		const armed = L.lua(1, `remote.call('surface_export','configure',{test_force_validation_failure=true});` +
			`return {success=true}`);
		if (!armed.success) throw new Error(`failed to arm refusal hook: ${armed.error}`);
		try {
			const marker2 = L.dropMarker(1, "refusal-transfer");
			L.rcon(2, `/transfer-platform ${backIndex} ${ids[1]}`);
			const { result: refusal } = await L.waitForImportResult(1, marker2);
			step("refusal.verdict", refusal.validation_success === false
				&& refusal.validation_result && refusal.validation_result.testForcedFailure === true,
				`validation_success=${refusal.validation_success}`);
			step("refusal.sourcePreserved", platformPresent(2, platformName),
				"fail => revert keeps the source platform");
			step("refusal.destDiscarded", !platformPresent(1, platformName),
				"the refused destination copy is discarded after black-box banking");
		} finally {
			L.lua(1, `if storage.surface_export_config then ` +
				`storage.surface_export_config.test_force_validation_failure=nil end return {success=true}`);
		}

		// E. The WEB UI IMPORT feature probe: a real historical payload without
		// item_source_positions must be REFUSED loudly with the server alive.
		const uploadName = `gallery-suite-upload-${Date.now() % 1_000_000}`;
		L.docker(["cp", `${repoRoot}tests/integration/gallery-suite/fixture.json`,
			`${L.CONTROLLER}:/tmp/gallery-suite-upload.json`], { timeout: 120_000 });
		L.ctl("surface-export", "upload-import", "/tmp/gallery-suite-upload.json",
			String(ids[2]), "player", uploadName);
		let verdict = null;
		const deadline = Date.now() + 120_000;
		while (!verdict && Date.now() < deadline) {
			await L.sleep(2000);
			const r = L.lua(2, `for id,rec in pairs(storage.async_job_results or {}) do ` +
				`if rec.type=='import' and rec.platform_name=='${uploadName}' and rec.complete then ` +
				`return {success=true,found=true,ok=(rec.validation and rec.validation.success),` +
				`stage=(rec.validation and rec.validation.failedStage),` +
				`details=(rec.validation and rec.validation.mismatchDetails)} end end ` +
				`return {success=true,found=false}`);
			if (r.found) verdict = r;
		}
		step("webImport.refusedLoudly", !!verdict && verdict.ok === false && verdict.stage === "belts"
			&& /predates captured source positions/.test(String(verdict.details)),
			verdict ? `stage=${verdict.stage}` : "job never completed (server death class?)");
		const alive = L.lua(2, "return {success=true}");
		step("webImport.serverAlive", alive.success === true, "post-upload RCON answers");
		L.lua(2, `for _,p in pairs(game.forces.player.platforms) do ` +
			`if p.valid and p.name=='${uploadName}' then ` +
			`remote.call('surface_export','unlock_platform',p.index); game.delete_surface(p.surface) end end ` +
			`return {success=true}`);
	} finally {
		await L.restoreLivePair(results, boundaryErrors);
	}

	for (const err of boundaryErrors) { console.error(err); failed++; }
	console.log(`\n=== gallery-suite: ${failed === 0 ? "ALL PASS" : failed + " FAILED"} ` +
		`(${results.steps.length} steps${results.restored ? ", live pair restored" : ""}) ===`);
	process.exit(failed === 0 ? 0 : 1);
}

main().catch(async error => {
	console.error(error.stack || error.message);
	await L.restoreLivePair(results, boundaryErrors).catch(() => {});
	for (const err of boundaryErrors) console.error(err);
	process.exit(1);
});
