#!/usr/bin/env node
// Rig-wave replay baker — import a banked belt payload ONCE onto the LIVE gallery instance, let it
// settle, then FREEZE it into a static reference rig. Used for the two replay rigs of the 2026-07-19
// rig wave:
//   A4  lab-rig-dup233855-v1        tests/belt-lab/evidence/replay_payload_DUP-233855.json
//   A5  lab-rig-belt-loss-replay-v1 tests/integration/belt-loss-replay/fixture.json
//
//   node tests/lab-gallery/rig-wave-replay.mjs --payload=<path> --name=<rig> [--item=<name>]
//
// Mechanics (modelled on tests/belt-lab/run-r14-dup-kill.mjs, retargeted to surface-export-lab-gallery):
// copy payload into the gallery instance's script-output, /plugin-import-file <file> <rig> (chunked
// upload path, names the platform directly), poll storage.async_jobs to zero, then in ONE execution
// pause the platform and freeze every entity (active=false on non-belt-graph, destructible=false on
// all; belt-class transport-belt/underground-belt/splitter REJECT active writes per BELT-R13 so their
// active flag is skipped-and-logged — plat.paused + destructible=false is their freeze). Then census.
// The gallery is NEVER stopped/restarted (owner is live on it); the platform-scoped pause/flags leave
// the owner's session untouched and persist into the checkpoint save.

import { execFileSync } from "node:child_process";
import { basename } from "node:path";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const GALLERY = "surface-export-lab-gallery";
const GALLERY_CONTAINER = "surface-export-host-2";
const INSTANCE_DIR = `/clusterio/data/instances/${GALLERY}`;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function docker(args, timeout = 120_000) {
	return execFileSync("docker", args, {
		encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
	});
}

function rcon(command, timeout = 300_000) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", GALLERY, command, "--config", CTL_CONFIG], timeout).trim();
}

function luaJson(body, timeout = 300_000) {
	const raw = rcon(`/sc local out={} local ok,err=pcall(function() ${body} end) ` +
		`if not ok then out={success=false,error=tostring(err)} end rcon.print(helpers.table_to_json(out))`, timeout);
	const last = raw.split(/\r?\n/).filter(Boolean).at(-1) || "";
	try { return JSON.parse(last); }
	catch (error) { throw new Error(`unparseable Lua JSON (${error.message}): ${last.slice(0, 500)}`); }
}

function findBody(name) {
	return `local plat for _,p in pairs(game.forces.player.platforms) do ` +
		`if p.valid and p.name=='${name}' then plat=p end end `;
}

async function waitForImport(name, timeoutMs = 600_000) {
	// Atomic completion-pause (run-r14 pattern): the same execution that sees jobs==0 pauses the
	// platform, bounding the post-activation live window to one poll interval.
	const deadline = Date.now() + timeoutMs;
	let last = {};
	while (Date.now() < deadline) {
		const state = luaJson(findBody(name) + `
			local function n(t) local c=0 for _ in pairs(t or {}) do c=c+1 end return c end
			local jobs=n(storage.async_jobs)
			if plat and jobs==0 then plat.paused=true out.done=true else out.done=false end
			out.jobs=jobs out.plat=plat~=nil out.success=true`, 120_000);
		last = state;
		if (state.done) return state;
		await sleep(1500);
	}
	throw new Error(`import did not complete in time (last=${JSON.stringify(last)})`);
}

function freezeBody(name) {
	return findBody(name) + `
		if not plat then out.success=false out.error='platform ${name} missing' return end
		plat.paused=true
		local s=plat.surface
		local ents=s.find_entities_filtered{}
		local belt_reject={['transport-belt']=true,['underground-belt']=true,['splitter']=true}
		local active_set=0 local active_skip=0 local destr_set=0 local active_reject=0
		for _,e in ipairs(ents) do if e.valid then
			pcall(function() e.destructible=false end)
			if e.destructible==false then destr_set=destr_set+1 end
			if belt_reject[e.type] then
				active_skip=active_skip+1
			else
				pcall(function() e.active=false end)
				if e.active==false then active_set=active_set+1 else active_reject=active_reject+1 end
			end
		end end
		out.total_entities=#ents out.active_set=active_set out.active_skipped=active_skip
		out.active_rejected=active_reject out.destructible_set=destr_set
		out.paused=plat.paused==true out.success=true`;
}

function censusBody(name, item) {
	return findBody(name) + `
		if not plat then out.success=false out.error='platform ${name} missing' return end
		local s=plat.surface
		local belts=s.find_entities_filtered{type={'transport-belt','underground-belt','splitter'}}
		out.belt_count=#belts
		local seen={} local total=0 local oversized=0 local maxstack=0 local lines=0
		for _,e in ipairs(belts) do for li=1,e.get_max_transport_line_index() do
			lines=lines+1
			for _,it in ipairs(e.get_transport_line(li).get_detailed_contents()) do
				local id=tostring(it.unique_id)
				if not seen[id] then seen[id]=true
					total=total+it.stack.count
					if it.stack.count>4 then oversized=oversized+1 end
					if it.stack.count>maxstack then maxstack=it.stack.count end
				end
			end
		end end
		out.belt_line_count=lines out.belt_item_total=total
		out.oversized_stacks=oversized out.max_stack=maxstack
		out.total_entities=#s.find_entities_filtered{}
		${item ? `
		local named=0
		for _,e in ipairs(belts) do for li=1,e.get_max_transport_line_index() do
			named=named+e.get_transport_line(li).get_item_count('${item}') end end
		local hub=plat.hub and plat.hub.get_inventory(defines.inventory.hub_main).get_item_count('${item}') or 0
		local ground=0
		for _,e in ipairs(s.find_entities_filtered{type='item-entity'}) do
			if e.stack and e.stack.valid_for_read and e.stack.name=='${item}' then ground=ground+e.stack.count end end
		out.item='${item}' out.item_belt=named out.item_hub=hub out.item_ground=ground out.item_total=named+hub+ground` : ``}
		out.paused=plat.paused==true out.success=true`;
}

async function main() {
	let payload, name, item;
	for (const arg of process.argv.slice(2)) {
		if (arg.startsWith("--payload=")) payload = arg.slice(10);
		else if (arg.startsWith("--name=")) name = arg.slice(7);
		else if (arg.startsWith("--item=")) item = arg.slice(7);
		else throw new Error(`unknown arg ${arg}`);
	}
	if (!payload || !name) throw new Error("need --payload=<path> --name=<rig>");
	const remoteName = basename(payload);
	const out = { name, payload, started: new Date().toISOString() };

	// Preflight: refuse a hostile lease (existing job/lock, or the rig name already present).
	const pre = luaJson(findBody(name) + `
		local function n(t) local c=0 for _ in pairs(t or {}) do c=c+1 end return c end
		out.jobs=n(storage.async_jobs) out.locks=n(storage.locked_platforms)
		out.name_present=plat~=nil out.success=true`, 60_000);
	if (pre.jobs !== 0 || pre.locks !== 0) throw new Error(`preflight refused: ${JSON.stringify(pre)}`);
	if (pre.name_present) throw new Error(`rig ${name} already present on gallery — refusing to double-import`);

	// Import.
	docker(["cp", payload, `${GALLERY_CONTAINER}:${INSTANCE_DIR}/script-output/${remoteName}`], 180_000);
	out.importCommand = rcon(`/plugin-import-file ${remoteName} ${name}`, 120_000).split(/\r?\n/).at(-1);
	out.importDone = await waitForImport(name);

	// Belt-summary log line (the plugin logs "<n> belts" during a belt-heavy import).
	try {
		out.beltLog = docker([ "exec", GALLERY_CONTAINER, "sh", "-c",
			`grep -aE '[0-9]+ belts' ${INSTANCE_DIR}/factorio-current.log | tail -1` ]).trim();
	} catch { out.beltLog = null; }

	// Freeze, then census.
	out.freeze = luaJson(freezeBody(name));
	if (!out.freeze.success) throw new Error(`freeze failed: ${out.freeze.error}`);
	out.census = luaJson(censusBody(name, item));
	if (!out.census.success) throw new Error(`census failed: ${out.census.error}`);

	// Remove the payload from script-output (no stray upload artifact left behind).
	docker(["exec", GALLERY_CONTAINER, "sh", "-c", `rm -f '${INSTANCE_DIR}/script-output/${remoteName}'`]);

	// Post-freeze leftover check on the gallery.
	out.leftovers = luaJson(`local function n(t) local c=0 for _ in pairs(t or {}) do c=c+1 end return c end
		out.jobs=n(storage.async_jobs) out.locks=n(storage.locked_platforms) out.holds=n(storage.destination_holds)
		out.paused=game.tick_paused==true out.success=true`, 60_000);
	out.finished = new Date().toISOString();
	console.log(JSON.stringify(out, null, 2));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
