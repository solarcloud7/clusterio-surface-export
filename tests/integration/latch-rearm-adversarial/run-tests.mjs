#!/usr/bin/env node

import {
	lua, rcon, instanceIds, createBatchLifecycle,
} from "../../lab-gallery/batch-lifecycle.mjs";
import { exportInspect } from "../../../tools/tests/testkit/export-inspect.mjs";

const RUN_TAG = Date.now().toString(36);
const PROBE = `latch-adversarial-${RUN_TAG}`;

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip",
	markerPrefix: "latch-adversarial",
});

const asArray = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

let failed = 0;
const check = (ok, label, detail = "") => {
	console.log(`  ${ok ? "PASS" : "FAIL"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
	if (!ok) failed++;
};

const LATCH_POS = "{8.5,1.5}";
const COUNTER_POS = "{8.5,3.5}";

function findDeciderLua(platformName, posExpr) {
	return `(function() local plat for _,q in pairs(game.forces.player.platforms) do `
		+ `if q.valid and q.name=='${platformName}' then plat=q end end `
		+ `if not plat then return nil end `
		+ `local es = plat.surface.find_entities_filtered{name='decider-combinator', `
		+ `area={{${posExpr}[1]-1,${posExpr}[2]-1},{${posExpr}[1]+1,${posExpr}[2]+1}}} `
		+ `return es[1] end)()`;
}

function readRegisterLua(platformName, posVar) {
	const pos = posVar === "latch" ? LATCH_POS : COUNTER_POS;
	return `local pos = ${pos} `
		+ `local dc = ${findDeciderLua(platformName, "pos")} `
		+ `if not (dc and dc.valid) then return {success=true, found=false} end `
		+ `local reg = {} `
		+ `local read_ok, sigs = pcall(function() return dc.get_control_behavior().signals_last_tick end) `
		+ `if read_ok then for _, x in pairs(sigs or {}) do reg[#reg+1] = x.signal.name..'='..x.count end end `
		+ `local status_name = 'unknown' `
		+ `for k, v in pairs(defines.entity_status) do if v == dc.status then status_name = k end end `
		+ `local p = dc.get_control_behavior().parameters `
		+ `return {success=true, found=true, read_ok=read_ok, `
		+ `register=(#reg>0) and table.concat(reg, ',') or '(empty)', status=status_name, `
		+ `conditions=#(p.conditions or {}), outputs=#(p.outputs or {}), `
		+ `else_outputs=#(p.else_outputs or {}), `
		+ `copy_count=(p.outputs and p.outputs[1] and p.outputs[1].copy_count_from_input) == true}`;
}

const BUILD = `
local p=game.forces.player.create_space_platform{name='${PROBE}', planet='nauvis',
  starter_pack='space-platform-starter-pack'}
if not p then return {success=false, error='create_space_platform failed'} end
p.apply_starter_pack()
p.paused = false
local s, force = p.surface, game.forces.player
local tiles = {}
for x = 5, 14 do for y = 0, 8 do
  tiles[#tiles+1] = { name='space-platform-foundation', position={x, y} }
end end
s.set_tiles(tiles)
local sp1 = s.create_entity{ name='solar-panel', position={6.5,6.5}, force=force }
local sp2 = s.create_entity{ name='solar-panel', position={9.5,6.5}, force=force }
local sub = s.create_entity{ name='substation', position={13.0,6.0}, force=force }
if not (sp1 and sp2 and sub) then return {success=false, error='power placement failed'} end
local lcc = s.create_entity{ name='constant-combinator', position={6.5,1.5}, force=force }
local ldc = s.create_entity{ name='decider-combinator', position=${LATCH_POS}, force=force,
  direction=defines.direction.east }
if not (lcc and ldc) then return {success=false, error='latch placement failed'} end
local lsec = lcc.get_control_behavior().get_section(1) or lcc.get_control_behavior().add_section()
lsec.set_slot(1, { value={type='virtual',name='signal-A',quality='normal'}, min=0 })
ldc.get_control_behavior().parameters = {
  conditions = {
    { first_signal={type='virtual',name='signal-A'}, comparator='>', constant=0 },
    { first_signal={type='virtual',name='signal-S'}, comparator='>', constant=0, compare_type='or' },
  },
  outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }},
  else_outputs = {{ signal={type='virtual',name='signal-R'}, copy_count_from_input=false }},
}
lcc.get_wire_connector(defines.wire_connector_id.circuit_red, true)
  .connect_to(ldc.get_wire_connector(defines.wire_connector_id.combinator_input_red, true))
ldc.get_wire_connector(defines.wire_connector_id.combinator_output_red, true)
  .connect_to(ldc.get_wire_connector(defines.wire_connector_id.combinator_input_red, true))
local ccc = s.create_entity{ name='constant-combinator', position={6.5,3.5}, force=force }
local cdc = s.create_entity{ name='decider-combinator', position=${COUNTER_POS}, force=force,
  direction=defines.direction.east }
if not (ccc and cdc) then return {success=false, error='counter placement failed'} end
local csec = ccc.get_control_behavior().get_section(1) or ccc.get_control_behavior().add_section()
csec.set_slot(1, { value={type='virtual',name='signal-C',quality='normal'}, min=1 })
cdc.get_control_behavior().parameters = {
  conditions = {{ first_signal={type='virtual',name='signal-C'}, comparator='>=', constant=-2147483648 }},
  outputs = {{ signal={type='virtual',name='signal-C'}, copy_count_from_input=true }},
}
ccc.get_wire_connector(defines.wire_connector_id.circuit_red, true)
  .connect_to(cdc.get_wire_connector(defines.wire_connector_id.combinator_input_red, true))
cdc.get_wire_connector(defines.wire_connector_id.combinator_output_red, true)
  .connect_to(cdc.get_wire_connector(defines.wire_connector_id.combinator_input_red, true))
storage.__latch_adv = { platform = p.index, lcc = lcc.unit_number }
return {success=true, index=p.index}
`;

const SETA = (v) => `
local st = storage.__latch_adv
local p for _,pl in pairs(game.forces.player.platforms) do if pl.index == st.platform then p = pl end end
local lcc for _, e in pairs(p.surface.find_entities_filtered{name='constant-combinator'}) do
  if e.unit_number == st.lcc then lcc = e end end
lcc.get_control_behavior().get_section(1).set_slot(1,
  { value={type='virtual',name='signal-A',quality='normal'}, min=${v} })
return {success=true}
`;

async function main() {
	console.log(`=== latch-rearm-adversarial: a latch re-arms, a counter is not falsely cleared (${PROBE}) ===`);
	const ids = instanceIds();

	try {
		const setup = lua(1, BUILD);
		if (!setup.success) throw new Error(`fixture setup failed: ${JSON.stringify(setup)}`);
		await L.sleep(4000);

		const latch0 = lua(1, readRegisterLua(PROBE, "latch"));
		const counter0 = lua(1, readRegisterLua(PROBE, "counter"));
		check(latch0.found === true && latch0.status === "working",
			"source: latch decider present and POWERED", JSON.stringify(latch0));
		check(counter0.found === true && counter0.status === "working",
			"source: counter decider present and POWERED", JSON.stringify(counter0));
		check(latch0.else_outputs === 1, "source: latch carries else_outputs (E1: getter emits it)",
			`else_outputs=${latch0.else_outputs}`);

		lua(1, SETA(5));
		await L.sleep(2000);
		lua(1, SETA(0));
		await L.sleep(2000);
		const latchArmed = lua(1, readRegisterLua(PROBE, "latch"));
		check(/signal-S=1/.test(latchArmed.register),
			"source: latch ARMED and holding S=1 with the set input back at 0",
			`register=${latchArmed.register}`);

		const counterA = lua(1, readRegisterLua(PROBE, "counter"));
		await L.sleep(2000);
		const counterB = lua(1, readRegisterLua(PROBE, "counter"));
		const countOf = (r) => Number((/signal-C=(\d+)/.exec(r.register) || [])[1] || 0);
		check(countOf(counterA) > 0 && countOf(counterB) > countOf(counterA),
			"source: counter register MOVING (two reads differ, both positive)",
			`a=${counterA.register} b=${counterB.register}`);

		const inspector = await exportInspect({ platform: PROBE, host: 1 });
		const deciders = (inspector.entities || []).filter(e => e.name === "decider-combinator");
		check(deciders.length === 2, "payload: both decider records present", `deciders=${deciders.length}`);
		const withOutputs = deciders.filter(d =>
			asArray(d.specific_data && d.specific_data.output_signals).length > 0);
		check(withOutputs.length === 2,
			"payload: both deciders carry output_signals (the re-arm gate opens for both)",
			JSON.stringify(deciders.map(d => (d.specific_data || {}).output_signals)));
		const latchRecord = deciders.find(d =>
			asArray((d.specific_data && d.specific_data.parameters || {}).else_outputs).length > 0
			|| asArray((d.control_behavior && d.control_behavior.parameters || {}).else_outputs).length > 0);
		check(!!latchRecord, "payload: the latch record carries else_outputs through capture",
			"no decider record has else_outputs in parameters");

		const marker = L.dropMarker(2, "transfer");
		rcon(1, `/transfer-platform ${setup.index} ${ids[2]}`);
		const { result } = await L.waitForImportResult(2, marker);
		check(result.validation_success === true, "transfer: exact gate passed",
			`validation_success=${result.validation_success}`);

		let rearmResult = null;
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			const r = lua(2, `local out for _, res in pairs(storage.latch_rearm_results or {}) do `
				+ `if res.platform_name == '${PROBE}' then out = res end end `
				+ `return {success=true, found=out ~= nil, result=out}`);
			if (r.found) { rearmResult = r.result; break; }
			await L.sleep(2000);
		}
		check(!!rearmResult, "dest: latch_rearm_results entry appeared within 90s (absence = FAIL, never vacuous)");
		if (rearmResult) {
			console.log(`  latch_rearm_results: ${JSON.stringify(rearmResult)}`);
			check(rearmResult.rearmed === 1, "dest: exactly the latch re-armed",
				`rearmed=${rearmResult.rearmed}`);
			check((rearmResult.moving || 0) === 1,
				"dest: the counter classified as MOVING (behavioural guard), not cleared",
				`moving=${rearmResult.moving} cleared=${rearmResult.cleared} failed=${rearmResult.failed}`);
			check((rearmResult.cleared || 0) === 0 && (rearmResult.failed || 0) === 0,
				"dest: nothing cleared, nothing failed — the false destructive clear is gone",
				`cleared=${rearmResult.cleared} failed=${rearmResult.failed}`);
			const counterDetail = asArray(rearmResult.details).find(d =>
				d.outcome && d.outcome.indexOf("register moving") !== -1);
			check(!!counterDetail, "dest: counter outcome names 'register moving'",
				JSON.stringify(rearmResult.details));
		}

		const latchDest = lua(2, readRegisterLua(PROBE, "latch"));
		check(latchDest.found === true && /signal-S=1/.test(latchDest.register),
			"dest: latch physically ARMED (register S=1)", JSON.stringify(latchDest));
		check(latchDest.else_outputs === 1,
			"dest: latch else_outputs INTACT after force/restore (not left stripped)",
			`else_outputs=${latchDest.else_outputs}`);

		const counterDestA = lua(2, readRegisterLua(PROBE, "counter"));
		await L.sleep(2000);
		const counterDestB = lua(2, readRegisterLua(PROBE, "counter"));
		check(counterDestA.copy_count === true && counterDestA.conditions === 1
			&& counterDestA.else_outputs === 0,
			"dest: counter parameters are its OWN captured shape (not clearing/forced leftovers)",
			JSON.stringify(counterDestA));
		check(countOf(counterDestB) > countOf(counterDestA),
			"dest: counter still ADVANCING (healthy state untouched)",
			`a=${counterDestA.register} b=${counterDestB.register}`);

		const sourceGone = lua(1, `for _,q in pairs(game.forces.player.platforms) do `
			+ `if q.valid and q.name=='${PROBE}' then return {success=true,present=true} end end `
			+ `return {success=true,present=false}`);
		check(sourceGone.present === false, "transfer: source deleted (two-phase commit)");
	} finally {
		for (const host of [1, 2]) {
			try {
				const swept = lua(host,
					`local n=0 for _,q in pairs(game.forces.player.platforms) do `
					+ `if q.valid and q.name=='${PROBE}' then `
					+ `pcall(remote.call,'surface_export','unlock_platform',q.index) `
					+ `if q.surface and q.surface.valid then game.delete_surface(q.surface) n=n+1 end end end `
					+ `local r=0 for key, res in pairs(storage.latch_rearm_results or {}) do `
					+ `if res.platform_name == '${PROBE}' then storage.latch_rearm_results[key]=nil r=r+1 end end `
					+ `storage.__latch_adv=nil `
					+ `return {success=true, swept=n, results_removed=r}`);
				console.log(`  cleanup host ${host}: swept ${swept.swept} platform(s), `
					+ `${swept.results_removed} result entr${swept.results_removed === 1 ? "y" : "ies"}`);
			} catch (sweepErr) {
				failed++;
				console.error(`  FAIL cleanup host ${host} threw: ${sweepErr && sweepErr.message ? sweepErr.message : sweepErr}`);
				console.error("  hand-clean with: tools/tests/cleanup-test-surfaces.ps1");
			}
		}
	}

	if (failed) {
		console.log(`=== latch-rearm-adversarial: ${failed} FAILURE(S) ===`);
		process.exit(1);
	}
	console.log("=== latch-rearm-adversarial: ALL PASS ===");
}

main().catch(error => {
	console.error(`latch-rearm-adversarial: fatal — ${error && error.stack ? error.stack : error}`);
	process.exit(1);
});
