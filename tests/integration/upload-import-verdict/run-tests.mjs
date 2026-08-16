#!/usr/bin/env node
// upload-import-verdict — the controller transaction row for a NON-TRANSFER upload import carries the
// destination's own verdict: an import the destination REFUSED reads failed with its failure stage, an
// import the destination completed still reads completed
//
// requires: a running surface-export cluster (host-1 builds and exports the probe payload, host-2
//           receives every upload); `clusterioctl surface-export upload-import`, the same controller
//           request the web UI's Import button sends, and `list-transfers`, the same records the web
//           Transaction Logs list is built from
// produces: a REAL export payload taken off a throwaway host-1 platform (a chest of items plus a belt
//           carrying items), uploaded to host-2 three ways — unmutated (control), with
//           belt_side_groups stripped (an export that predates captured source positions: the
//           destination refuses the belt restore), and transfer-shaped with an inflated verification
//           count (the exact gate fails and discards the destination) — each graded on the controller
//           transaction row's status and error text AND on a physical destination read
// does not: assert item/fluid FIDELITY (no exact gate runs on a plain non-transfer import — the
//           suite's config-attrs / gallery-suite runs are the fidelity control); perform a real
//           cross-instance transfer; read the browser DOM (status and error are asserted at the
//           controller record the list renders, not at the rendered pixels); sweep the transaction
//           rows the arms create (they persist by design, like every transfer)

import { execFileSync } from "node:child_process";
import { lua as luaRaw, ctl, docker, sleep, lastLine, instanceIds, instancePath,
	fetchTransferSummaries, CONTROLLER, HOSTS } from "../../lab-gallery/batch-lifecycle.mjs";

const SOURCE_HOST = 1;
const DEST_HOST = 2;
const TAG = Date.now().toString(36);
const PREFIX = "upverdict-";
const PROBE = `${PREFIX}src-${TAG}`;
const ARM_OK = `${PREFIX}ok-${TAG}`;
const ARM_BELTS = `${PREFIX}belts-${TAG}`;
const ARM_GATE = `${PREFIX}gate-${TAG}`;
const CRAFTED_TRANSFER_ID = `${PREFIX}${TAG}`;
const DUMP_FILE = `${PREFIX}${TAG}.json`;
const EXPORT_WAIT_MS = 120_000;
const ROW_WAIT_MS = 180_000;
const CHEST_ITEMS = 77;
const BELT_ITEM = "iron-plate";
const PHANTOM_ITEM = "copper-plate";
const PHANTOM_COUNT = 5000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "error", "cleanup_failed"]);

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
		+ "  if e.valid then plates = plates + e.get_item_count('" + BELT_ITEM + "') end\n"
		+ "end\n"
		+ "local belt_items = 0\n"
		+ "for _, e in pairs(target.surface.find_entities_filtered{ type = 'transport-belt' }) do\n"
		+ "  if e.valid then\n"
		+ "    for li = 1, e.get_max_transport_line_index() do\n"
		+ "      local line = e.get_transport_line(li)\n"
		+ "      if line and line.valid then belt_items = belt_items + #line.get_detailed_contents() end\n"
		+ "    end\n"
		+ "  end\n"
		+ "end\n"
		+ "return { success = true, present = true, paused = target.paused == true, held = held,\n"
		+ "  activatable = activatable, plates = plates, belt_items = belt_items,\n"
		+ "  entities = #target.surface.find_entities_filtered{} }");
}

async function waitForRow(platformName, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let row = null;
	while (Date.now() < deadline) {
		const rows = fetchTransferSummaries({ limit: 200 });
		row = Array.isArray(rows) ? rows.find(entry => entry.platformName === platformName) ?? null : null;
		if (row && TERMINAL_STATUSES.has(String(row.status))) return row;
		await sleep(3000);
	}
	return row;
}

const describeRow = (row) => (row
	? `status=${row.status} error=${JSON.stringify(row.error)}`
	: "(no transaction row)");

async function uploadArm({ label, platformName, payload, destInstanceId }) {
	const containerPath = `/tmp/${PREFIX}${label}-${TAG}.json`;
	putFileInController(containerPath, JSON.stringify(payload));
	const attempt = ctlAttempt("surface-export", "upload-import", containerPath,
		String(destInstanceId), "player", platformName);
	say(`  upload-import [${label}] exit=${attempt.status}: ${lastLine(attempt.output)}`);
	const row = await waitForRow(platformName, ROW_WAIT_MS);
	const arrival = readArrival(DEST_HOST, platformName);
	say(`  transaction row [${label}]: ${describeRow(row)}`);
	return { attempt, row, arrival, containerPath };
}

say(`=== upload-import-verdict: the transaction row reports the destination's verdict (${TAG}) ===`);

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
		+ `if chest then chest.insert{ name = '${BELT_ITEM}', count = ${CHEST_ITEMS} } end\n`
		+ "local ins = s.create_entity{ name = 'inserter', position = { 8.5, 2.5 }, force = force }\n"
		+ "local belt = s.create_entity{ name = 'transport-belt', position = { 10.5, 2.5 }, force = force,\n"
		+ "  direction = defines.direction.east }\n"
		+ "local seeded = 0\n"
		+ "if belt then\n"
		+ "  for li = 1, belt.get_max_transport_line_index() do\n"
		+ "    local line = belt.get_transport_line(li)\n"
		+ "    if line and line.valid then\n"
		+ "      for _, at in ipairs({ 0.15, 0.35, 0.55, 0.75 }) do\n"
		+ `        if line.insert_at(at, { name = '${BELT_ITEM}' }) then seeded = seeded + 1 end\n`
		+ "      end\n"
		+ "    end\n"
		+ "  end\n"
		+ "end\n"
		+ "local on_belt = 0\n"
		+ "if belt then\n"
		+ "  for li = 1, belt.get_max_transport_line_index() do\n"
		+ "    local line = belt.get_transport_line(li)\n"
		+ "    if line and line.valid then on_belt = on_belt + #line.get_detailed_contents() end\n"
		+ "  end\n"
		+ "end\n"
		+ "return { success = true, index = p.index,\n"
		+ "  chest = (chest ~= nil and chest.valid), inserter = (ins ~= nil and ins.valid),\n"
		+ "  belt = (belt ~= nil and belt.valid), seeded = seeded, on_belt = on_belt,\n"
		+ `  plates = (chest and chest.get_item_count('${BELT_ITEM}')) or 0,\n`
		+ "  entities = #s.find_entities_filtered{} }");
	probeIndex = setup.index;
	check(setup.chest === true && setup.inserter === true && setup.belt === true,
		`probe fixture built on host ${SOURCE_HOST}: chest + inserter + belt on platform ${PROBE}`,
		`entities=${setup.entities} plates=${setup.plates}`);
	check(setup.plates === CHEST_ITEMS,
		`probe chest holds ${CHEST_ITEMS} ${BELT_ITEM}, so the payload carries a non-empty item census`,
		`plates=${setup.plates}`);
	check(setup.on_belt > 0,
		"the probe belt is CARRYING items at export time — without them the payload has no belt data "
		+ "and the stripped-payload arm below could not fail",
		`inserted=${setup.seeded} onBelt=${setup.on_belt}`);

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

	say("\n=== PRECONDITIONS: what each uploaded payload carries into the destination ===");
	const beltBearingEntities = (Array.isArray(base.entities) ? base.entities : []).filter(entity => {
		const lines = entity && entity.specific_data && entity.specific_data.items;
		return Array.isArray(lines) && lines.some(line => line && line.line !== undefined
			&& Array.isArray(line.items) && line.items.length > 0);
	});
	check(Array.isArray(base.belt_side_groups) && base.belt_side_groups.length > 0,
		"the real export payload carries belt_side_groups (captured source positions), so deleting that "
		+ "key is the only difference in the BELTS arm",
		`sideGroups=${Array.isArray(base.belt_side_groups) ? base.belt_side_groups.length : "(absent)"}`);
	check(beltBearingEntities.length > 0,
		"the payload's entity data carries belt items on a line — the exact predicate "
		+ "import-completion uses to refuse a payload with no belt_side_groups",
		`beltBearingEntities=${beltBearingEntities.length}`);
	check(!!base.verification && typeof base.verification.item_counts === "object"
		&& typeof base.verification.fluid_counts === "object",
		"the payload carries verification.item_counts and verification.fluid_counts, so the GATE arm's "
		+ "inflated count is compared by the real exact gate",
		`itemKeys=${Object.keys(base.verification?.item_counts ?? {}).length}`);
	const schedule = base.platform && base.platform.schedule;
	check(!!schedule && typeof schedule.records === "object" && typeof schedule.interrupts === "object",
		"the payload's platform.schedule satisfies validate_transfer_payload, so the transfer-shape "
		+ "intake refusals cannot be what stops the GATE arm",
		`schedule=${JSON.stringify(schedule ?? null).slice(0, 120)}`);
	check(base._transferId === undefined && base._sourceInstanceId === undefined,
		"the export payload carries no _transferId or _sourceInstanceId of its own (the GATE arm injects "
		+ "only the first, which is what routes its completion through the operationId branch)");

	const okPayload = { ...base, platform_name: ARM_OK };
	const beltsPayload = { ...base, platform_name: ARM_BELTS };
	delete beltsPayload.belt_side_groups;
	const gatePayload = {
		...base,
		platform_name: ARM_GATE,
		_transferId: CRAFTED_TRANSFER_ID,
		verification: {
			...base.verification,
			item_counts: { ...base.verification.item_counts, [PHANTOM_ITEM]: PHANTOM_COUNT },
		},
	};

	say(`\n=== CONTROL: an import the destination COMPLETED must still read completed ===`);
	const ok = await uploadArm({ label: "ok", platformName: ARM_OK, payload: okPayload,
		destInstanceId: ids[DEST_HOST] });
	containerPaths.push(ok.containerPath);
	check(ok.attempt.status === 0, "upload-import accepts the unmutated export payload",
		ok.attempt.output.trim().slice(-300));
	check(ok.arrival.present === true && ok.arrival.plates === CHEST_ITEMS
		&& ok.arrival.belt_items > 0,
		`PHYSICAL: '${ARM_OK}' arrived on host ${DEST_HOST} with its ${CHEST_ITEMS} ${BELT_ITEM} and its `
		+ "belt items restored",
		`present=${ok.arrival.present} plates=${ok.arrival.plates} `
		+ `beltItems=${ok.arrival.belt_items} entities=${ok.arrival.entities}`);
	check(ok.arrival.activatable > 0 && ok.arrival.held === 0,
		"PHYSICAL: no activatable entity on the successful arrival is held by disabled_by_script",
		`held=${ok.arrival.held}/${ok.arrival.activatable}`);
	check(ok.row !== null && ok.row.status === "completed" && (ok.row.error ?? null) === null,
		"the transaction row for a SUCCESSFUL upload reads completed with no error — the Lua event omits "
		+ "the success key entirely on this path, so a reader that demands success===true would flip "
		+ "every good upload to failed",
		describeRow(ok.row));

	say("\n=== BELTS: the destination REFUSED the belt restore and printed [Import FAILED] ===");
	const belts = await uploadArm({ label: "belts", platformName: ARM_BELTS, payload: beltsPayload,
		destInstanceId: ids[DEST_HOST] });
	containerPaths.push(belts.containerPath);
	check(belts.attempt.status === 0,
		"upload-import ACCEPTS the payload (nothing refuses it at intake — the refusal happens at the "
		+ "destination, after the platform exists)",
		belts.attempt.output.trim().slice(-300));
	check(belts.arrival.present === true && belts.arrival.belt_items === 0,
		`PHYSICAL: '${ARM_BELTS}' arrived and is KEPT, with ZERO items on its belts — the destination `
		+ "refused the belt restore it could not perform",
		`present=${belts.arrival.present} beltItems=${belts.arrival.belt_items} `
		+ `plates=${belts.arrival.plates}`);
	check(belts.row !== null && belts.row.status === "failed",
		"the transaction row for the REFUSED import reads failed (on the unfixed code this row reads "
		+ "status=completed with error=null, while the destination printed [Import FAILED])",
		describeRow(belts.row));
	check(belts.row !== null && typeof belts.row.error === "string" && belts.row.error.includes("belts"),
		"the row's error names the failure stage the destination reported (belts)",
		describeRow(belts.row));

	say("\n=== GATE: a transfer-shaped upload whose exact gate FAILS and whose destination is DISCARDED ===");
	const gate = await uploadArm({ label: "gate", platformName: ARM_GATE, payload: gatePayload,
		destInstanceId: ids[DEST_HOST] });
	containerPaths.push(gate.containerPath);
	check(gate.attempt.status === 0,
		"upload-import accepts the transfer-shaped payload (it carries verification and a valid "
		+ "schedule, so the intake refusals do not fire)",
		gate.attempt.output.trim().slice(-300));
	check(gate.arrival.present === false,
		`PHYSICAL: no platform '${ARM_GATE}' exists on host ${DEST_HOST} — the failed gate discarded the `
		+ "destination, so a row that reads completed would be describing a platform that is gone",
		`present=${gate.arrival.present}`);
	check(gate.row !== null && gate.row.status === "failed",
		"the transaction row for the FAILED gate reads failed (on the unfixed code this row reads "
		+ "status=completed with error=null: the payload carries no _sourceInstanceId, so its completion "
		+ "takes the same operationId branch as every upload)",
		describeRow(gate.row));
	check(gate.row !== null && typeof gate.row.error === "string" && gate.row.error.includes("items"),
		`the row's error names the failure stage the gate reported (items — ${PHANTOM_COUNT} `
		+ `${PHANTOM_ITEM} were expected and none exist)`,
		describeRow(gate.row));
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
		docker(["exec", HOSTS[DEST_HOST].container, "sh", "-c",
			`rm -f ${instancePath(DEST_HOST, `script-output/failure_black_box_${PREFIX}*`)}`]);

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
		lua(DEST_HOST, "if storage.validation_results then\n"
			+ `  storage.validation_results['${CRAFTED_TRANSFER_ID}'] = nil\n`
			+ "end\n"
			+ "return { success = true }");

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
			+ "local verdicts = 0\n"
			+ "for key in pairs(storage.validation_results or {}) do\n"
			+ `  if type(key) == 'string' and key:sub(1, ${PREFIX.length}) == '${PREFIX}' then verdicts = verdicts + 1 end\n`
			+ "end\n"
			+ (exportJobId
				? `local cached = (storage.platform_exports and storage.platform_exports['${exportJobId}']) ~= nil\n`
				: "local cached = false\n")
			+ "local sessions = 0\n"
			+ "for key in pairs(storage.chunked_imports or {}) do\n"
			+ `  if key:sub(1, ${PREFIX.length}) == '${PREFIX}' then sessions = sessions + 1 end\n`
			+ "end\n"
			+ "return { success = true, surfaces = surfaces, platforms = platforms, locks = locks,\n"
			+ "  verdicts = verdicts, cached = cached, sessions = sessions }");
		for (const host of [SOURCE_HOST, DEST_HOST]) {
			const left = residue(host);
			const surfaces = Array.isArray(left.surfaces) ? left.surfaces : Object.values(left.surfaces || {});
			check(surfaces.length === 0 && left.platforms === 0 && left.locks === 0
				&& left.verdicts === 0 && left.cached === false && left.sessions === 0,
				`zero leftovers on host ${host}: no ${PREFIX} surface, platform, lock record, stored `
				+ "verdict, export cache entry or stranded chunked-import session",
				`surfaces=${surfaces.join(",") || "(none)"} platforms=${left.platforms} `
				+ `locks=${left.locks} verdicts=${left.verdicts} exportCached=${left.cached} `
				+ `chunkSessions=${left.sessions}`);
		}
	} catch (sweepError) {
		failures += 1;
		process.exitCode = 1;
		console.error(`  FAIL  cleanup threw: ${sweepError && sweepError.message ? sweepError.message : sweepError}`);
		console.error(`  hand-clean with: tools/tests/cleanup-test-surfaces.ps1 (prefix ${PREFIX} is in its sweep list)`);
	}
}

if (failures) {
	say(`=== upload-import-verdict: ${failures} FAILURE(S) ===`);
	process.exit(1);
}
say("=== upload-import-verdict: ALL PASS ===");
