#!/usr/bin/env node
// inserter-lab B6 — the activation-refutation rung.
//
// QUESTION: does entity.active gate held_stack.set_stack() seating? The lore ("set_stack silently
// fails / under-fills on a settled-deactivated inserter"; "bulk capacity only applies when active")
// justified a wake-toggle ritual in restore_held_items_only and was stamped GROUNDED in the
// empirical backlog — but no rung ever isolated ACTIVATION as its own variable (B1-B4 isolated
// force bonus; D3 ran its probes briefly-active).
//
// DESIGN (three sub-rungs, one variable each — first measured live 2026-07-18 on the gallery,
// codified here against host-1):
//   B6a fresh-inactive : create inserters, active=false, set_stack immediately  -> seat?
//   B6b settled-inactive: create, active=false, let REAL ticks elapse, set_stack -> seat?
//   B6c bonus-0 A/B    : temp force (bonus 0), one inserter INACTIVE + one ACTIVE, set_stack(8)
//                        on each -> compare clamps.
// VERDICT RULE: activation-independent iff B6a/B6b seat FULL (at adequate bonus) AND B6c's two
// clamps are EQUAL. Any divergence re-opens the activation mechanism.
//
// Zero-leftover: scratch platform deleted, temp force merged away, both asserted in finally.
//
// Usage:
//   node tests/inserter-lab/run-b6-deactivated-setstack.mjs                # full run, appends NOTEBOOK
//   node tests/inserter-lab/run-b6-deactivated-setstack.mjs --no-notebook  # debug iteration
//   node tests/inserter-lab/run-b6-deactivated-setstack.mjs --reset        # cleanup only

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const INSTANCE = "clusterio-host-1-instance-1";
const NOTEBOOK = fileURLToPath(new URL("./NOTEBOOK.md", import.meta.url));
const PLATFORM = "inserter-lab-b6-probe";
const PROBE_FORCE = "inserter-lab-b6-force";
const SETTLE_SECONDS = 5;

let noNotebook = false;
let resetOnly = false;
for (const arg of process.argv.slice(2)) {
	if (arg === "--no-notebook") noNotebook = true;
	else if (arg === "--reset") resetOnly = true;
	else throw new Error(`Unknown argument: ${arg}`);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function lastLine(v) { return String(v).split(/\r?\n/).map(l => l.trim()).filter(Boolean).at(-1) || ""; }

function rcon(command) {
	return execFileSync("docker", ["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", INSTANCE, command, "--config", CTL_CONFIG],
	{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 }).trim();
}

function lua(body) {
	const command = `/sc local ok,result=pcall(function() ${body} end); ` +
		`if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success=false,error=tostring(result)})) end`;
	const raw = lastLine(rcon(command));
	try { return JSON.parse(raw); }
	catch (error) { throw new Error(`Invalid Lua JSON: ${raw}\n${error.message}`); }
}

const FIND_SURFACE = `local surf for _,p in pairs(game.forces.player.platforms) do ` +
	`if p.valid and p.name=="${PLATFORM}" then surf=p.surface end end `;

function setup() {
	return lua(`local f=game.forces.player;` +
		`local p=f.create_space_platform({name="${PLATFORM}",planet="nauvis",starter_pack="space-platform-starter-pack"});` +
		`p.apply_starter_pack();p.paused=false;` +
		`local s=p.surface;local tiles={} ` +
		`for x=4,12,2 do tiles[#tiles+1]={name="space-platform-foundation",position={x,4}} end ` +
		`s.set_tiles(tiles);` +
		`return {success=true,surface=s.index,player_bulk_bonus=f.bulk_inserter_capacity_bonus,` +
		`player_stack_bonus=f.inserter_stack_size_bonus}`);
}

function probeFresh() {
	return lua(FIND_SURFACE +
		`local a=surf.create_entity{name="bulk-inserter",position={4.5,4.5},force="player",quality="legendary"} ` +
		`a.active=false ` +
		`local ra=a.held_stack.set_stack({name="railgun-ammo",count=8}) ` +
		`local na=a.held_stack.valid_for_read and a.held_stack.count or 0 ` +
		`local b=surf.create_entity{name="inserter",position={6.5,4.5},force="player"} ` +
		`b.active=false ` +
		`local rb=b.held_stack.set_stack({name="iron-plate",count=4}) ` +
		`local nb=b.held_stack.valid_for_read and b.held_stack.count or 0 ` +
		`return {success=true,tick=game.tick,bulk_ok=ra,bulk_held=na,plain_ok=rb,plain_held=nb}`);
}

function plantSettled() {
	return lua(FIND_SURFACE +
		`local a=surf.create_entity{name="bulk-inserter",position={8.5,4.5},force="player",quality="legendary"} ` +
		`a.active=false ` +
		`storage.__b6={unit=a.unit_number,tick=game.tick} ` +
		`return {success=true,tick=game.tick}`);
}

function probeSettled() {
	return lua(FIND_SURFACE +
		`local pr=storage.__b6 storage.__b6=nil ` +
		`local a for _,e in ipairs(surf.find_entities_filtered{name="bulk-inserter"}) do ` +
		`if e.unit_number==pr.unit then a=e end end ` +
		`local elapsed=game.tick-pr.tick ` +
		`local ra=a.held_stack.set_stack({name="railgun-ammo",count=8}) ` +
		`local na=a.held_stack.valid_for_read and a.held_stack.count or 0 ` +
		`return {success=true,elapsed_ticks=elapsed,bulk_ok=ra,bulk_held=na,still_inactive=not a.active}`);
}

function probeBonusZero() {
	return lua(FIND_SURFACE +
		`local f=game.forces["${PROBE_FORCE}"] or game.create_force("${PROBE_FORCE}") ` +
		`local bonus=f.bulk_inserter_capacity_bonus ` +
		`local a=surf.create_entity{name="bulk-inserter",position={10.5,4.5},force=f,quality="legendary"} ` +
		`a.active=false ` +
		`local ra=a.held_stack.set_stack({name="railgun-ammo",count=8}) ` +
		`local na=a.held_stack.valid_for_read and a.held_stack.count or 0 ` +
		`local b=surf.create_entity{name="bulk-inserter",position={12.5,4.5},force=f,quality="legendary"} ` +
		`b.active=true ` +
		`local rb=b.held_stack.set_stack({name="railgun-ammo",count=8}) ` +
		`local nb=b.held_stack.valid_for_read and b.held_stack.count or 0 ` +
		`b.active=false ` +
		`return {success=true,force_bonus=bonus,inactive_held=na,active_held=nb,inactive_ok=ra,active_ok=rb}`);
}

function cleanup() {
	return lua(`local deleted=false ` +
		`for _,s in pairs(game.surfaces) do local p=s.platform ` +
		`if p and p.valid and p.name=="${PLATFORM}" then game.delete_surface(s) deleted=true end end ` +
		`storage.__b6=nil ` +
		`if game.forces["${PROBE_FORCE}"] then game.merge_forces("${PROBE_FORCE}","player") end ` +
		`return {success=true,deleted=deleted}`);
}

function zeroCheck() {
	return lua(`local platforms=0 ` +
		`for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=="${PLATFORM}" then platforms=platforms+1 end end ` +
		`return {success=true,leftover_platforms=platforms,probe_storage=storage.__b6~=nil,` +
		`probe_force=game.forces["${PROBE_FORCE}"]~=nil and game.forces["${PROBE_FORCE}"].valid==true,tick=game.tick}`);
}

function zeroOk(z) { return z.leftover_platforms === 0 && !z.probe_storage && !z.probe_force; }

function renderNotebook(results) {
	const a = results.fresh, b = results.settled, c = results.bonus0;
	const L = [];
	L.push(`\n\n## ${results.finished} — B6 activation-refutation rung (Factorio ${results.base_version})`);
	L.push(`\nRunner: \`tests/inserter-lab/run-b6-deactivated-setstack.mjs\` on ${INSTANCE} ` +
		`(player force bonuses at run: bulk ${results.setup.player_bulk_bonus}, stack ${results.setup.player_stack_bonus}).`);
	L.push(`\n- **B6a fresh-inactive**: bulk set_stack(8) → held ${a.bulk_held}; plain set_stack(4) → held ${a.plain_held}.`);
	L.push(`- **B6b settled-inactive** (${b.elapsed_ticks} elapsed ticks, still inactive=${b.still_inactive}): bulk set_stack(8) → held ${b.bulk_held}.`);
	L.push(`- **B6c bonus-0 A/B** (temp force, bonus ${c.force_bonus}): INACTIVE → ${c.inactive_held}, ACTIVE → ${c.active_held}.`);
	L.push(`\n**VERDICT: ${results.verdict}** — ${results.verdict === "ACTIVATION-INDEPENDENT"
		? "set_stack seating does not depend on entity.active in any tested condition; the capacity clamp is purely force-bonus-governed. " +
		"SUPERSEDES: the D3/MECHANISM entry ('on a deactivated inserter the bulk capacity isn't active'), the LOCAL-vs-CI 'silently fails on a " +
		"SETTLED-deactivated inserter' attribution, and FIX A ATTEMPT 1's settled-vs-fresh entity-state hypothesis — the un-isolated variable in all " +
		"three was the FORCE BONUS, never activation. The real historical held phantom: the deserializer's held restore was DEAD CODE " +
		"(stranded behind restore_inventories' has_inventories early-return), so held items were never attempted at all; on CI the Pitfall #29 " +
		"bonus clamp shortened what the recovery pass then seated."
		: "a tested condition diverged — the activation mechanism is NOT refuted; investigate before touching the held-restore path."}`);
	L.push(`\nResidual [hypothesis]: not yet reproduced in the exact import context (import-created entities on a paused platform); ` +
		`the inserter-held-capacity baked-fixture batch covers that end-to-end.`);
	L.push(`\nZero-leftover: platform deleted=${results.cleanup.deleted}, post-run ${JSON.stringify(results.zero)}.`);
	L.push(`\n<details><summary>Raw results JSON</summary>\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n</details>`);
	return L.join("\n");
}

async function main() {
	const results = { script: "tests/inserter-lab/run-b6-deactivated-setstack.mjs", started: new Date().toISOString(), errors: [] };
	let created = false;
	try {
		const meta = lua(`return {success=true,base=script.active_mods.base,tick=game.tick}`);
		results.base_version = meta.base;
		results.setup = setup();
		if (!results.setup.success) throw new Error(`setup failed: ${results.setup.error}`);
		created = true;
		results.fresh = probeFresh();
		if (!results.fresh.success) throw new Error(`B6a failed: ${results.fresh.error}`);
		const planted = plantSettled();
		if (!planted.success) throw new Error(`B6b plant failed: ${planted.error}`);
		await sleep(SETTLE_SECONDS * 1000);
		results.settled = probeSettled();
		if (!results.settled.success) throw new Error(`B6b failed: ${results.settled.error}`);
		if (results.settled.elapsed_ticks < 60) throw new Error(`B6b settle window too short: ${results.settled.elapsed_ticks} ticks`);
		results.bonus0 = probeBonusZero();
		if (!results.bonus0.success) throw new Error(`B6c failed: ${results.bonus0.error}`);
		if (results.bonus0.force_bonus !== 0) throw new Error(`B6c control invalid: temp force bonus ${results.bonus0.force_bonus} != 0`);

		const fullFresh = results.fresh.bulk_held === 8 && results.fresh.plain_held === 4;
		const fullSettled = results.settled.bulk_held === 8;
		const clampsEqual = results.bonus0.inactive_held === results.bonus0.active_held;
		results.verdict = (fullFresh && fullSettled && clampsEqual) ? "ACTIVATION-INDEPENDENT" : "DIVERGED";
		if (results.verdict !== "ACTIVATION-INDEPENDENT") {
			results.errors.push(`divergence: fresh=${JSON.stringify(results.fresh)} settled=${JSON.stringify(results.settled)} bonus0=${JSON.stringify(results.bonus0)}`);
		}
	} catch (error) {
		results.errors.push(error.stack || error.message);
	} finally {
		try {
			results.cleanup = created || resetOnly ? cleanup() : { success: true, deleted: false };
			results.zero = zeroCheck();
			results.zero_ok = zeroOk(results.zero);
			if (!results.zero_ok) results.errors.push(`zero-leftover FAILED: ${JSON.stringify(results.zero)}`);
		} catch (error) {
			results.errors.push(`cleanup failed: ${error.stack || error.message}`);
		}
		results.finished = new Date().toISOString();
		if (!noNotebook && !resetOnly && results.verdict) appendFileSync(NOTEBOOK, renderNotebook(results));
		console.log(JSON.stringify(results, null, 2));
		if (results.errors.length) process.exitCode = 1;
	}
}

if (resetOnly) {
	const clean = cleanup();
	const zero = zeroCheck();
	console.log(JSON.stringify({ clean, zero, ok: zeroOk(zero) }, null, 2));
	if (!zeroOk(zero)) process.exitCode = 1;
} else {
	main();
}
