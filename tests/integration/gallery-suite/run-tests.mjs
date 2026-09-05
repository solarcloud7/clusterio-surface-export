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

function runBoard(host) {
	const raw = L.rcon(host, "/test-run");
	const line = raw.split(/\r?\n/).find(l => l.includes("[TESTRUN-JSON]"));
	if (!line) throw new Error(`host ${host}: no TESTRUN-JSON line in /test-run output:\n${raw.slice(-800)}`);
	return JSON.parse(line.slice(line.indexOf("{")));
}

function subjectPlatform(fixture) {
	return String(fixture.platformName || "").split("+")[0].trim();
}

function adjudicateBoard(board, manifest, onlyPlatform) {
	const problems = [];
	const gaps = [];
	const byId = new Map(manifest.fixtures.map(f => [f.id, f]));
	const seen = new Set();
	for (const result of board.results || []) {
		seen.add(result.id);
		const fixture = byId.get(result.id);
		if (!fixture) { problems.push(`${result.id}: on the board but absent from the manifest`); continue; }
		const inScope = !onlyPlatform || subjectPlatform(fixture) === onlyPlatform;
		const knownGap = onlyPlatform && inScope && fixture.destinationGap;
		const expected = fixture.runnerExcluded ? "skipped"
			: knownGap ? "fail" : (inScope ? "pass" : "missing");
		if (result.verdict !== expected) {
			problems.push(`${result.id}: ${result.verdict} (expected ${expected})` +
				(knownGap ? ` — KNOWN GAP NOW ${result.verdict.toUpperCase()}: ${fixture.destinationGap} ` +
					`(if this is fixed, drop destinationGap and re-pin)` : "") +
				(result.detail ? ` — ${String(result.detail).slice(0, 120)}` : ""));
		} else if (knownGap) {
			gaps.push(`${result.id}: ${fixture.destinationGap}`);
		}
	}
	for (const fixture of manifest.fixtures) {
		if (!seen.has(fixture.id)) problems.push(`${fixture.id}: rostered but never adjudicated by the board`);
	}
	if (board.unknown !== 0) problems.push(`${board.unknown} unknown pad(s) discovered on the board`);
	return { problems, gaps };
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
	const liveEngine = L.lua(1, "return {success=true, base=script.active_mods.base}").base;
	if (liveEngine !== manifest.engineVersion) {
		console.log(`WARN: golden saves banked at ${manifest.engineVersion}, running engine ${liveEngine} — loaded by forward migration; `
			+ "re-bank per docker/seed-data/lab-saves/README.md to re-measure at this pin");
	}
	const platformName = "lab-omnibus-state-v1";

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
		const counters = await L.loadGoldenPair(manifest, "load");

		const collision = L.checkTransferIdCollisions({
			candidates: [
				...L.predictCanonicalIds({ instanceId: ids[1], counter: counters[1], platformName }),
				...L.predictCanonicalIds({ instanceId: ids[2], counter: counters[2], platformName }),
			],
			summaries: L.fetchTransferSummaries({ limit: 200 }),
		});
		console.log(collision.message);
		if (collision.fatal) throw new Error(collision.message);

		for (const host of [1, 2]) console.log(`roster: ${pushRoster(L.HOSTS[host].instance)}`);

		const boardA = runBoard(1);
		const verdictA = adjudicateBoard(boardA, manifest);
		step("board.host1", verdictA.problems.length === 0,
			verdictA.problems.length ? verdictA.problems.join(" | ")
				: `every rostered fixture adjudicated: passed=${boardA.passed} skipped=${boardA.skipped}`);

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

		const boardC = runBoard(2);
		const outOfScope = manifest.fixtures.filter(f => subjectPlatform(f) !== platformName).map(f => f.id);
		const verdictC = adjudicateBoard(boardC, manifest, platformName);
		step("board.host2.transferred", verdictC.problems.length === 0,
			verdictC.problems.length ? verdictC.problems.join(" | ")
				: `every rostered fixture adjudicated: passed=${boardC.passed} skipped=${boardC.skipped}` +
					`, out-of-scope (must be missing): ${outOfScope.join(", ") || "none"}`);
		for (const gap of verdictC.gaps) console.log(`  KNOWN DESTINATION GAP — ${gap}`);

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
	await L.restoreLivePair(results, boundaryErrors)
		.catch(restoreError => console.error(`restoreLivePair itself rejected: ${restoreError.stack || restoreError.message}`));
	for (const err of boundaryErrors) console.error(err);
	process.exit(1);
});
