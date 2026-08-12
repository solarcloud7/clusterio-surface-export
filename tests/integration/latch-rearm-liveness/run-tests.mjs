#!/usr/bin/env node
// latch-rearm-liveness — does a DARK decider get deferred instead of forced and falsely cleared?
//
// requires: a running surface-export cluster (host-2), module 0.10.253+
// produces: exit 0 when the powered latch re-arms and the dark one reports the unpowered outcome
// does not: perform a transfer, or assert anything about the canvas
//
// No export, no import, no race. The stage machine is scheduled DIRECTLY against two real deciders
// on two real platforms, so the fixture cannot drift out from under the assertion.
//
// TWO platforms, not one. On lab-transfer-fixture-v1 every one of its 526 networked entities measured
// onto a SINGLE electric network (id 9, 2026-08-11), so on that fixture a powered and a dark decider
// cannot coexist. That is a fixture measurement, not a law — a decider out of reach of any pole would
// form its own network. Two platforms is the shape that holds either way, and it is why whole-job
// power deferral is cheap in practice: a platform's deciders are usually all lit or all dark together.

import { execFileSync } from "node:child_process";

const INSTANCE = "clusterio-host-2-instance-1";
const TAG = Date.now().toString(36);
const LIT = `latchlive-lit-${TAG}`;
const DARK = `latchlive-dark-${TAG}`;

// POWER_WAIT_TICKS is 1800 (30s) plus the 60-tick poll; allow margin for a loaded cluster.
const DEFERRAL_WAIT_MS = 42000;

// The Lua is flattened to ONE line before it is sent. JSON.stringify turns real newlines into literal
// \n escape sequences, which arrive at Factorio outside any Lua string and are a syntax error — the
// command then fails silently and every downstream read returns "". None of the Lua below uses --
// comments, so joining on whitespace is safe.
const rcon = (lua) => execFileSync("docker", [
	"exec", "surface-export-controller", "sh", "-c",
	`npx clusterioctl --config /clusterio/tokens/config-control.json --log-level error `
	+ `instance send-rcon "${INSTANCE}" ${JSON.stringify("/sc " + lua.replace(/\s*\n\s*/g, " ").trim())}`,
], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();

// An empty RCON reply means the command did not run. Treating that as data is how a broken probe
// reports success — every assertion below goes through here first.
const answered = (value, label) => {
	if (value === "" || value === undefined) {
		check(false, label, "RCON returned NOTHING — the command did not execute; this is not a result");
		return false;
	}
	return true;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
	// Set at the point of failure, not only at the terminal exit(): an early return past that exit
	// would report a recorded FAILURE as a green run — the vacuous-pass class again.
	if (!ok) { failures += 1; process.exitCode = 1; }
};

// Builds one platform holding one self-feedback decider, already latched to S=1.
// `withPower` decides whether a solar panel exists: without one the decider reads low_power,
// which is the dark instrument this test exists for (measured: low_power, NOT no_power — the
// decider is still ON the platform's global network, there is simply no production).
const buildLua = (name, withPower) => `
local p = game.forces.player.create_space_platform{name='${name}', planet='nauvis',
  starter_pack='space-platform-starter-pack'}
if not p then return end
p.apply_starter_pack()
p.paused = false
local s, force = p.surface, game.forces.player
local tiles = {}
for x = 5, 13 do for y = 0, 7 do tiles[#tiles+1] = { name='space-platform-foundation', position={x, y} } end end
s.set_tiles(tiles)
${withPower ? `s.create_entity{ name='solar-panel', position={7.5,5.5}, force=force }` : ``}
local cc = s.create_entity{ name='constant-combinator', position={6.5,1.5}, force=force }
local dc = s.create_entity{ name='decider-combinator', position={9.5,1.5}, force=force,
  direction=defines.direction.east }
local sec = cc.get_control_behavior().get_section(1) or cc.get_control_behavior().add_section()
sec.set_slot(1, { value={type='virtual',name='signal-A',quality='normal'}, min=1 })
dc.get_control_behavior().parameters = {
  conditions = {
    { first_signal={type='virtual',name='signal-A'}, comparator='>', constant=0 },
    { first_signal={type='virtual',name='signal-S'}, comparator='>', constant=0, compare_type='or' },
  },
  outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }},
}
cc.get_wire_connector(defines.wire_connector_id.circuit_red, true)
  .connect_to(dc.get_wire_connector(defines.wire_connector_id.combinator_input_red, true))
dc.get_wire_connector(defines.wire_connector_id.combinator_output_red, true)
  .connect_to(dc.get_wire_connector(defines.wire_connector_id.combinator_input_red, true))
storage.__latchlive = storage.__latchlive or {}
storage.__latchlive['${name}'] = { platform = p.index, dc = dc.unit_number }
rcon.print(p.index .. '|' .. dc.unit_number)
`;

// Schedules the REAL stage machine against a live decider, synthesizing the record shape
// LatchRearm.schedule expects: a self-feedback circuit_connection so has_self_feedback passes, and a
// non-empty output_signals so the arming gate admits it. Nothing here is a test hook — schedule() is
// the production entry point, called with production-shaped data.
const scheduleLua = (name) => `
local st = storage.__latchlive['${name}']
local p for _,pl in pairs(game.forces.player.platforms) do if pl.index == st.platform then p = pl end end
local dc for _,e in pairs(p.surface.find_entities_filtered{type='decider-combinator'}) do
  if e.unit_number == st.dc then dc = e end end
if not dc then rcon.print('NO DECIDER') return end
local wc = defines.wire_connector_id
local LatchRearm = package.loaded['__level__/modules/surface_export/import_phases/latch_rearm.lua']
if not LatchRearm then rcon.print('NO MODULE') return end
local captured = dc.get_control_behavior().parameters
local n = LatchRearm.schedule({
  job_id = 'latchlive_${name}',
  platform_name = '${name}',
  entity_map = { [st.dc] = dc },
  entities_to_create = {{
    type = 'decider-combinator',
    entity_id = st.dc,
    position = { x = 9.5, y = 1.5 },
    control_behavior = { parameters = captured },
    circuit_connections = {{
      target_entity_id = st.dc,
      source_circuit_id = wc.combinator_output_red,
      target_circuit_id = wc.combinator_input_red,
    }},
    specific_data = {
      parameters = captured,
      output_signals = {{ signal = {type='virtual',name='signal-S'}, count = 1 }},
    },
  }},
})
rcon.print('scheduled=' .. tostring(n))
`;

const resultLua = (name) => `
local r = (storage.latch_rearm_results or {})['latchlive_${name}']
if not r then rcon.print('PENDING') return end
local outcomes = {}
for _, d in ipairs(r.details or {}) do outcomes[#outcomes+1] = d.outcome end
rcon.print(r.reason .. ' || rearmed=' .. r.rearmed .. ' cleared=' .. r.cleared
  .. ' failed=' .. r.failed .. ' || ' .. table.concat(outcomes, ' ~~ '))
`;

const pauseLua = (name, paused) => `
local st = storage.__latchlive['${name}']
for _,pl in pairs(game.forces.player.platforms) do
  if pl.index == st.platform then pl.paused = ${paused} end end
rcon.print('paused=${paused}')
`;

const statusLua = (name) => `
local st = storage.__latchlive['${name}']
local p for _,pl in pairs(game.forces.player.platforms) do if pl.index == st.platform then p = pl end end
local dc for _,e in pairs(p.surface.find_entities_filtered{type='decider-combinator'}) do
  if e.unit_number == st.dc then dc = e end end
local names = {} for k,id in pairs(defines.entity_status) do names[id] = k end
local conds = dc.get_control_behavior().parameters.conditions
rcon.print(tostring(names[dc.status]) .. '|conditions=' .. #conds)
`;

async function main() {
	console.log(`=== latch re-arm liveness (${TAG}) ===`);
	try {
		rcon(buildLua(LIT, true));
		rcon(buildLua(DARK, false));
		await sleep(5000);

		const litStatus = rcon(statusLua(LIT));
		const darkStatus = rcon(statusLua(DARK));
		if (!answered(litStatus, "powered decider status readable")) { return; }
		if (!answered(darkStatus, "dark decider status readable")) { return; }
		check(litStatus.startsWith("working|"), "powered decider reports working", litStatus);
		// A dark decider reports no_power when the platform never had a producer, and low_power when a
		// producer existed and was removed — both measured 2026-08-11/12. Asserting one of them alone
		// over-fits to how the fixture went dark; asserting only "not working" would pass on a garbage
		// status, so the check requires a KNOWN dark status.
		const DARK_STATUSES = ["no_power", "low_power", "not_plugged_in_electric_network"];
		check(DARK_STATUSES.some(s => darkStatus.startsWith(`${s}|`)),
			"dark decider reports a known unpowered status", darkStatus);
		const darkConditionsBefore = Number(darkStatus.split("conditions=")[1]);

		// Gateway-parked transfers re-pause the platform, and the force write gates on
		// status == "working". If pausing changed the status, every parked transfer would burn the full
		// deferral and finalize "unpowered" — the regression this guard would otherwise introduce. The
		// fact is asserted here rather than written down, so a future engine pin re-measures it.
		rcon(pauseLua(LIT, true));
		await sleep(2500);
		const litPaused = rcon(statusLua(LIT));
		rcon(pauseLua(LIT, false));
		if (answered(litPaused, "paused decider status readable")) {
			check(litPaused.startsWith("working|"),
				"a POWERED decider still reports working while its platform is PAUSED", litPaused);
		}

		check(rcon(scheduleLua(LIT)) === "scheduled=1", "powered latch scheduled");
		check(rcon(scheduleLua(DARK)) === "scheduled=1", "dark latch scheduled");

		await sleep(6000);
		const lit = rcon(resultLua(LIT));
		check(lit !== "PENDING" && lit.includes("rearmed=1"), "powered latch re-armed promptly", lit);

		const darkEarly = rcon(resultLua(DARK));
		check(darkEarly === "PENDING", "dark latch is DEFERRED, not resolved immediately", darkEarly);

		console.log(`  … waiting out the ${DEFERRAL_WAIT_MS / 1000}s power deferral`);
		await sleep(DEFERRAL_WAIT_MS);

		const dark = rcon(resultLua(DARK));
		if (!answered(dark, "dark latch result readable")) { return; }
		check(dark !== "PENDING", "dark latch finalized rather than hanging", dark);
		check(dark.includes("unpowered — re-arm not evaluated"),
			"dark latch finalizes as unpowered, never evaluated", dark);
		check(dark !== "PENDING" && !dark.includes("cleared to 0"),
			"dark latch NEVER reports a verified clear",
			"an empty register on a dark decider read as 'stable' and licensed the clear — the PENDING "
			+ "guard is here so a job that never ran cannot pass this by absence");
		check(dark.includes("failed=1") && dark.includes("cleared=0"),
			"the unpowered outcome buckets as failed, not cleared", dark);

		const darkAfter = rcon(statusLua(DARK));
		check(Number(darkAfter.split("conditions=")[1]) === darkConditionsBefore,
			"dark decider's parameters are untouched", `${darkStatus} -> ${darkAfter}`);
	} finally {
		for (const name of [LIT, DARK]) {
			rcon(`local st = (storage.__latchlive or {})['${name}']
if st then for _,pl in pairs(game.forces.player.platforms) do
  if pl.index == st.platform and pl.name == '${name}' then game.delete_surface(pl.surface) end end
  storage.__latchlive['${name}'] = nil end
storage.latch_rearm_results = storage.latch_rearm_results or {}
storage.latch_rearm_results['latchlive_${name}'] = nil
rcon.print('swept')`);
		}
		const left = rcon(`local n = {} for _,p in pairs(game.forces.player.platforms) do
if string.find(p.name, 'latchlive-', 1, true) then n[#n+1] = p.name end end
rcon.print(table.concat(n, ','))`);
		check(left === "", "probe platforms swept", left || "(none)");
	}

	console.log(failures === 0 ? "\nlatch-rearm-liveness: PASS" : `\nlatch-rearm-liveness: ${failures} FAILURE(S)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(`latch-rearm-liveness: ${err.message}`);
	process.exit(1);
});
