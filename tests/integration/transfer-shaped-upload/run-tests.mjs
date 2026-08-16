#!/usr/bin/env node
// transfer-shaped-upload — an uploaded payload that carries _transferId but no verification block is
// refused at intake, instead of arriving as a paused platform of deactivated entities
//
// requires: a running surface-export cluster (host-1 exports the probe, host-2 receives every upload);
//           `clusterioctl surface-export upload-import`, the same controller request the web UI's
//           Import button sends
// produces: a REAL export payload taken off a throwaway host-1 platform, then uploaded to host-2 three
//           ways — unmutated (control), +_transferId -verification (the hole), and -verification alone
//           (scope control) — each graded on the ctl exit status, the controller transaction row, and a
//           PHYSICAL destination read (platform.paused, inserter.disabled_by_script, chest contents)
// does not: perform a cross-instance transfer (the real end-to-end transfer control is the suite's own
//           config-attrs / gallery-suite runs); assert item/fluid FIDELITY (no gate runs on a
//           non-transfer import); exercise the compressed wrapper shape (every arm uploads the
//           decompressed inner payload, so the three arms differ in exactly one key); sweep the
//           controller transaction rows the arms create (they persist by design, like every transfer)

import { execFileSync } from "node:child_process";
import { lua as luaRaw, ctl, docker, sleep, instanceIds, instancePath, fetchTransferSummaries,
	CONTROLLER, HOSTS } from "../../lab-gallery/batch-lifecycle.mjs";

const SOURCE_HOST = 1;
const DEST_HOST = 2;
const TAG = Date.now().toString(36);
const PREFIX = "tsupload-";
const PROBE = `${PREFIX}src-${TAG}`;
const ARM_CONTROL = `${PREFIX}ctl-${TAG}`;
const ARM_HOLE = `${PREFIX}hole-${TAG}`;
const ARM_SCOPE = `${PREFIX}scope-${TAG}`;
const DUMP_FILE = `${PREFIX}${TAG}.json`;
const EXPORT_WAIT_MS = 120_000;
const ARRIVAL_WAIT_MS = 180_000;
const REFUSED_ARRIVAL_WAIT_MS = 20_000;
const CHEST_ITEMS = 77;

// The one substring the guard's message must carry all the way to a user surface.
const REFUSAL_MARKER = "Transfer payload missing required verification counts";

let failures = 0;
const say = (...args) => console.log(...args);
const check = (ok, label, detail = "") => {
	say(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	if (!ok) { failures += 1; process.exitCode = 1; }
};
const note = (text) => say(`  NOTE  ${text}`);

function lua(host, body) {
	const result = luaRaw(host, body);
	if (result === null || typeof result !== "object") {
		throw new Error(`lua returned no object from host ${host}: ${JSON.stringify(result)}`);
	}
	if (result.success !== true) {
		throw new Error(`lua failed on host ${host}: ${result.error ?? JSON.stringify(result)}`);
	}
	return result;
}

function ctlAttempt(...args) {
	try {
		return { status: 0, output: String(ctl(...args)) };
	} catch (error) {
		const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`;
		return { status: error.status ?? 1, output };
	}
}

function putFileInController(containerPath, contents) {
	execFileSync("docker", ["exec", "-i", CONTROLLER, "sh", "-c", `cat > ${containerPath}`], {
		input: contents, encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"],
	});
}

function findPlatformIndex(host, name) {
	const result = lua(host, "local idx\n"
		+ "for _, pl in pairs(game.forces.player.platforms) do\n"
		+ `  if pl.name == '${name}' and pl.surface and pl.surface.valid then idx = pl.index end\n`
		+ "end\n"
		+ "return { success = true, index = idx }");
	return typeof result.index === "number" ? result.index : null;
}

async function waitForPlatform(host, name, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const index = findPlatformIndex(host, name);
		if (index !== null) return index;
		await sleep(3000);
	}
	return null;
}

// The physical destination read: is the arrival alive, or paused with its entities held down?
function readArrival(host, name) {
	return lua(host, "local target\n"
		+ "for _, pl in pairs(game.forces.player.platforms) do\n"
		+ `  if pl.name == '${name}' and pl.surface and pl.surface.valid then target = pl end\n`
		+ "end\n"
		+ "if not target then return { success = true, present = false } end\n"
		+ "local held, activatable = 0, 0\n"
		+ "for _, e in pairs(target.surface.find_entities_filtered{}) do\n"
		+ "  if e.valid and (e.type == 'inserter' or e.type == 'assembling-machine' or e.type == 'lab') then\n"
		+ "    activatable = activatable + 1\n"
		+ "    if e.disabled_by_script then held = held + 1 end\n"
		+ "  end\n"
		+ "end\n"
		+ "local plates = 0\n"
		+ "for _, e in pairs(target.surface.find_entities_filtered{ type = 'container' }) do\n"
		+ "  if e.valid then plates = plates + e.get_item_count('iron-plate') end\n"
		+ "end\n"
		+ "return { success = true, present = true, paused = target.paused == true, held = held,\n"
		+ "  activatable = activatable, plates = plates,\n"
		+ "  entities = #target.surface.find_entities_filtered{} }");
}

function transactionRow(platformName) {
	const rows = fetchTransferSummaries({ limit: 200 });
	if (!Array.isArray(rows)) return null;
	return rows.find(row => row.platformName === platformName) ?? null;
}

async function uploadArm({ label, platformName, payload, destInstanceId }) {
	const containerPath = `/tmp/${PREFIX}${label}-${TAG}.json`;
	putFileInController(containerPath, JSON.stringify(payload));
	const attempt = ctlAttempt("surface-export", "upload-import", containerPath,
		String(destInstanceId), "player", platformName);
	say(`  upload-import [${label}] exit=${attempt.status}: ${attempt.output.trim().split(/\r?\n/).at(-1) ?? ""}`);
	const index = await waitForPlatform(DEST_HOST, platformName,
		attempt.status === 0 ? ARRIVAL_WAIT_MS : REFUSED_ARRIVAL_WAIT_MS);
	const arrival = readArrival(DEST_HOST, platformName);
	const row = transactionRow(platformName);
	return { attempt, index, arrival, row, containerPath };
}

say(`=== transfer-shaped-upload: intake must refuse a _transferId payload with no verification (${TAG}) ===`);

const containerPaths = [];
let probeIndex = null;
let exportJobId = null;

try {
	const ids = instanceIds();
	note(`instance ids: host-${SOURCE_HOST}=${ids[SOURCE_HOST]}, host-${DEST_HOST}=${ids[DEST_HOST]}`);

	say("\n=== SOURCE: build a throwaway platform and export it through the production export path ===");
	const setup = lua(SOURCE_HOST, "local force = game.forces.player\n"
		+ `local p = force.create_space_platform{ name = '${PROBE}', planet = 'nauvis',\n`
		+ "  starter_pack = 'space-platform-starter-pack' }\n"
		+ "if not p then return { success = false, error = 'create_space_platform returned nil' } end\n"
		+ "p.apply_starter_pack()\n"
		+ "local s = p.surface\n"
		+ "local tiles = {}\n"
		+ "for x = 5, 21 do for y = 0, 10 do\n"
		+ "  tiles[#tiles + 1] = { name = 'space-platform-foundation', position = { x, y } }\n"
		+ "end end\n"
		+ "s.set_tiles(tiles)\n"
		+ "local chest = s.create_entity{ name = 'wooden-chest', position = { 6.5, 2.5 }, force = force }\n"
		+ `if chest then chest.insert{ name = 'iron-plate', count = ${CHEST_ITEMS} } end\n`
		+ "local ins = s.create_entity{ name = 'inserter', position = { 8.5, 2.5 }, force = force }\n"
		+ "return { success = true, index = p.index, chest = (chest ~= nil and chest.valid),\n"
		+ "  inserter = (ins ~= nil and ins.valid),\n"
		+ "  plates = (chest and chest.get_item_count('iron-plate')) or 0,\n"
		+ "  entities = #s.find_entities_filtered{} }");
	probeIndex = setup.index;
	check(setup.chest === true && setup.inserter === true,
		`probe fixture built on host ${SOURCE_HOST}: wooden-chest + inserter on platform ${PROBE}`,
		`entities=${setup.entities} plates=${setup.plates}`);
	check(setup.plates === CHEST_ITEMS,
		`probe chest holds ${CHEST_ITEMS} iron-plate, so the payload carries a non-empty item census`,
		`plates=${setup.plates}`);

	const queued = lua(SOURCE_HOST,
		`local jid = remote.call('surface_export', 'export_platform', ${probeIndex}, 'player')\n`
		+ `if not jid then return { success = false, error = 'export_platform refused index ${probeIndex}' } end\n`
		+ "return { success = true, job_id = jid }");
	exportJobId = queued.job_id;
	say(`  export queued: job_id=${exportJobId}`);

	const exportDeadline = Date.now() + EXPORT_WAIT_MS;
	let cached = false;
	while (Date.now() < exportDeadline) {
		await sleep(2000);
		cached = lua(SOURCE_HOST, "return { success = true, ready = (storage.platform_exports ~= nil\n"
			+ `  and storage.platform_exports['${exportJobId}'] ~= nil) }`).ready === true;
		if (cached) break;
	}
	if (!cached) throw new Error(`export ${exportJobId} never landed in storage.platform_exports`);

	const dumped = lua(SOURCE_HOST, `local e = storage.platform_exports['${exportJobId}']\n`
		+ "if not e then return { success = false, error = 'export vanished from the cache' } end\n"
		+ "local inner\n"
		+ "if e.compressed then inner = helpers.decode_string(e.payload)\n"
		+ "else inner = helpers.table_to_json(e) end\n"
		+ "if not inner then return { success = false, error = 'could not materialise the inner payload' } end\n"
		+ `helpers.write_file('${DUMP_FILE}', inner, false)\n`
		+ "return { success = true, bytes = #inner, compressed = (e.compressed == true) }");
	say(`  export payload dumped: ${dumped.bytes} bytes (source record compressed=${dumped.compressed})`);

	const dumpPath = instancePath(SOURCE_HOST, `script-output/${DUMP_FILE}`);
	let raw = null;
	const readDeadline = Date.now() + 30_000;
	while (Date.now() < readDeadline) {
		try {
			raw = docker(["exec", HOSTS[SOURCE_HOST].container, "sh", "-c", `cat ${dumpPath}`]);
			if (raw && raw.length > 0) break;
		} catch (readError) {
			console.log(`  NOTE  waiting for ${DUMP_FILE} to land on disk (${readError.message.split("\n")[0]})`);
		}
		await sleep(2000);
	}
	if (!raw) throw new Error(`script-output/${DUMP_FILE} never became readable`);
	const base = JSON.parse(raw);

	say("\n=== PRECONDITIONS: what the crafted payloads carry into intake ===");
	check(base.verification !== undefined
		&& typeof base.verification.item_counts === "object"
		&& typeof base.verification.fluid_counts === "object",
		"the real export payload carries verification.item_counts and verification.fluid_counts",
		`verification=${JSON.stringify(base.verification ?? null).slice(0, 120)}`);
	const schedule = base.platform && base.platform.schedule;
	check(!!schedule && typeof schedule.records === "object" && typeof schedule.interrupts === "object",
		"the payload's platform.schedule satisfies validate_transfer_payload, so the EARLIER transfer-shape "
		+ "refusals in import-pipeline cannot be what refuses the hole arm",
		`schedule=${JSON.stringify(schedule ?? null).slice(0, 120)}`);
	check(base._transferId === undefined,
		"the export payload carries no _transferId of its own (the hole arm injects it)");

	const controlPayload = { ...base, platform_name: ARM_CONTROL };
	const holePayload = { ...base, platform_name: ARM_HOLE, _transferId: `${PREFIX}${TAG}` };
	delete holePayload.verification;
	const scopePayload = { ...base, platform_name: ARM_SCOPE };
	delete scopePayload.verification;

	say(`\n=== CONTROL: the unmutated export payload uploads to host ${DEST_HOST} and arrives ALIVE ===`);
	const control = await uploadArm({ label: "ctl", platformName: ARM_CONTROL, payload: controlPayload,
		destInstanceId: ids[DEST_HOST] });
	containerPaths.push(control.containerPath);
	check(control.attempt.status === 0, "upload-import accepts a legitimate export-only payload",
		control.attempt.output.trim().slice(-300));
	check(control.index !== null, `'${ARM_CONTROL}' arrived on host ${DEST_HOST}`);
	check(control.arrival.present === true && control.arrival.paused === false,
		"the legitimate upload arrives UNPAUSED",
		`present=${control.arrival.present} paused=${control.arrival.paused}`);
	check(control.arrival.activatable > 0 && control.arrival.held === 0,
		"no activatable entity on the legitimate arrival is held by disabled_by_script",
		`held=${control.arrival.held}/${control.arrival.activatable}`);
	check(control.arrival.plates === CHEST_ITEMS,
		`the legitimate arrival restored the ${CHEST_ITEMS} iron-plate`,
		`plates=${control.arrival.plates}`);

	say("\n=== HOLE: the same payload with _transferId injected and verification stripped ===");
	const hole = await uploadArm({ label: "hole", platformName: ARM_HOLE, payload: holePayload,
		destInstanceId: ids[DEST_HOST] });
	containerPaths.push(hole.containerPath);
	if (hole.arrival.present === true) {
		note(`REPRODUCTION: '${ARM_HOLE}' arrived anyway — paused=${hole.arrival.paused}, `
			+ `disabled_by_script=${hole.arrival.held}/${hole.arrival.activatable} activatable entities, `
			+ `${hole.arrival.entities} entities total. A transfer-shaped payload with no verification `
			+ "skips the whole gate/activation block, so the platform lands dead.");
	}
	if (hole.row) {
		note(`transaction row for '${ARM_HOLE}': status=${hole.row.status} error=${JSON.stringify(hole.row.error)}`);
	}
	const refusalText = `${hole.attempt.output}\n${hole.row ? String(hole.row.error ?? "") : ""}`;
	check(hole.attempt.status !== 0,
		"upload-import REFUSES a transfer-shaped payload that carries no verification",
		`exit=${hole.attempt.status}`);
	check(refusalText.includes(REFUSAL_MARKER),
		"the refusal reaches a user surface (ctl output and/or the controller transaction row) with the "
		+ "intake guard's own message, so it cannot be the schedule or schema refusal",
		`ctlOutput=${hole.attempt.output.trim().slice(-200)}`);
	check(hole.row !== null && hole.row.status === "failed",
		"the controller transaction row for the refused upload is FAILED",
		`row=${hole.row ? `status=${hole.row.status}` : "(no row)"}`);
	check(hole.index === null && hole.arrival.present === false,
		`no platform '${ARM_HOLE}' exists on host ${DEST_HOST} — the refusal happens before the `
		+ "destination platform is created, so there is nothing to clean up",
		`index=${hole.index} present=${hole.arrival.present}`);

	say("\n=== SCOPE CONTROL: verification stripped but NO _transferId still imports as a plain export ===");
	const scope = await uploadArm({ label: "scope", platformName: ARM_SCOPE, payload: scopePayload,
		destInstanceId: ids[DEST_HOST] });
	containerPaths.push(scope.containerPath);
	check(scope.attempt.status === 0,
		"the guard is scoped to transfer-shaped payloads: a verification-less EXPORT upload is still accepted",
		scope.attempt.output.trim().slice(-300));
	check(scope.index !== null && scope.arrival.present === true && scope.arrival.paused === false,
		`'${ARM_SCOPE}' arrived UNPAUSED`,
		`index=${scope.index} paused=${scope.arrival.paused}`);
	check(scope.arrival.held === 0,
		"the verification-less export arrival is not held by disabled_by_script",
		`held=${scope.arrival.held}/${scope.arrival.activatable}`);
} catch (probeError) {
	failures += 1;
	process.exitCode = 1;
	console.error(`  FAIL  probe threw: ${probeError && probeError.message ? probeError.message : probeError}`);
} finally {
	say("\n=== CLEANUP ===");
	try {
		for (const path of containerPaths) {
			docker(["exec", CONTROLLER, "sh", "-c", `rm -f ${path}`]);
		}
		docker(["exec", HOSTS[SOURCE_HOST].container, "sh", "-c",
			`rm -f ${instancePath(SOURCE_HOST, `script-output/${DUMP_FILE}`)}`]);

		// Source-only, and through the production unlock: the export takes a lock keyed by PLATFORM
		// INDEX, and that index means a different platform on the other host.
		if (probeIndex !== null) {
			const unlocked = lua(SOURCE_HOST,
				`local ok, err = pcall(remote.call, 'surface_export', 'unlock_platform', ${probeIndex})\n`
				+ "return { success = true, called = ok, detail = tostring(err) }");
			say(`  host ${SOURCE_HOST}: unlock_platform(${probeIndex}) called=${unlocked.called} (${unlocked.detail})`);
		}
		if (exportJobId) {
			lua(SOURCE_HOST, "if storage.platform_exports then\n"
				+ `  storage.platform_exports['${exportJobId}'] = nil\n`
				+ "end\n"
				+ "return { success = true }");
		}

		const sweep = (host) => lua(host, "local removed = {}\n"
			+ "for _, pl in pairs(game.forces.player.platforms) do\n"
			+ `  if pl.valid and pl.name:sub(1, ${PREFIX.length}) == '${PREFIX}' and pl.surface and pl.surface.valid then\n`
			+ "    removed[#removed + 1] = pl.name\n"
			+ "    game.delete_surface(pl.surface)\n"
			+ "  end\n"
			+ "end\n"
			+ "return { success = true, removed = removed }");
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			const removed = sweep(host);
			say(`  host ${host}: delete_surface issued for ${(removed.removed || []).length} probe platform(s)`);
		}
		await sleep(3000);

		// Substring, not prefix: a platform's SURFACE name is not required to equal the platform name,
		// and a prefix test that silently matches nothing is not a leftover check.
		const residue = (host) => lua(host, "local surfaces = {}\n"
			+ "for name in pairs(game.surfaces) do\n"
			+ `  if type(name) == 'string' and string.find(name, '${PREFIX}', 1, true) then\n`
			+ "    surfaces[#surfaces + 1] = name\n"
			+ "  end\n"
			+ "end\n"
			+ "local platforms = 0\n"
			+ "for _, pl in pairs(game.forces.player.platforms) do\n"
			+ `  if pl.valid and pl.name:sub(1, ${PREFIX.length}) == '${PREFIX}' then platforms = platforms + 1 end\n`
			+ "end\n"
			+ "local locks = 0\n"
			+ "for _, lock in pairs(storage.locked_platforms or {}) do\n"
			+ `  if lock and lock.platform_name and lock.platform_name:sub(1, ${PREFIX.length}) == '${PREFIX}' then\n`
			+ "    locks = locks + 1\n"
			+ "  end\n"
			+ "end\n"
			+ (exportJobId
				? `local cached = (storage.platform_exports and storage.platform_exports['${exportJobId}']) ~= nil\n`
				: "local cached = false\n")
			+ "local sessions = 0\n"
			+ "for key in pairs(storage.chunked_imports or {}) do\n"
			+ `  if key:sub(1, ${PREFIX.length}) == '${PREFIX}' then sessions = sessions + 1 end\n`
			+ "end\n"
			+ "return { success = true, surfaces = surfaces, platforms = platforms, locks = locks,\n"
			+ "  cached = cached, sessions = sessions }");
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			const left = residue(host);
			const surfaces = Array.isArray(left.surfaces) ? left.surfaces : Object.values(left.surfaces || {});
			check(surfaces.length === 0 && left.platforms === 0 && left.locks === 0
				&& left.cached === false && left.sessions === 0,
				`zero leftovers on host ${host}: no ${PREFIX} surface, platform, lock record, export cache `
				+ "entry or stranded chunked-import session",
				`surfaces=${surfaces.join(",") || "(none)"} platforms=${left.platforms} `
				+ `locks=${left.locks} exportCached=${left.cached} chunkSessions=${left.sessions}`);
		}
	} catch (sweepError) {
		failures += 1;
		process.exitCode = 1;
		console.error(`  FAIL  cleanup threw: ${sweepError && sweepError.message ? sweepError.message : sweepError}`);
		console.error(`  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix ${PREFIX} is in its sweep list)`);
	}
}

if (failures) {
	say(`=== transfer-shaped-upload: ${failures} FAILURE(S) ===`);
	process.exit(1);
}
say("=== transfer-shaped-upload: ALL PASS ===");
