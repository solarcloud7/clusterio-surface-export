import { createBatchLifecycle } from "../../lab-gallery/batch-lifecycle.mjs";

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip", markerPrefix: "pause-rung",
});
const HOST = 2;
const PLATFORM = `pause-rung-${Date.now() % 1000000}`;
const say = (...a) => console.log(...a);

function lua(body) {
	const r = L.lua(HOST, body);
	if (r.success === false) throw new Error(`lua failed: ${r.error}`);
	return r;
}

const PRE = `
local st = storage.__pause_rung
local p
for _, pl in pairs(game.forces.player.platforms) do if pl.index == st.platform then p = pl end end
local s = p.surface
local cc, dc
for _, e in pairs(s.find_entities_filtered{ area = {{4,-2},{15,9}} }) do
  if e.unit_number == st.cc then cc = e end
  if e.unit_number == st.dc then dc = e end
end
local function setA(v)
  cc.get_control_behavior().get_section(1).set_slot(1,
    { value = { type='virtual', name='signal-A', quality='normal' }, min = v })
end
`;

const READ = PRE + `
local net = dc.get_circuit_network(defines.wire_connector_id.combinator_input_red)
local input = {}
if net then for _, x in pairs(net.signals or {}) do input[#input+1] = x.signal.name..'='..x.count end end
local reg = {}
local read_ok, sigs = pcall(function() return dc.get_control_behavior().signals_last_tick end)
if read_ok then for _, x in pairs(sigs or {}) do reg[#reg+1] = x.signal.name..'='..x.count end end
local status_name = 'unknown'
for k, v in pairs(defines.entity_status) do if v == dc.status then status_name = k end end
return { success = true,
  input = (#input>0) and table.concat(input, ',') or '(empty)',
  register = (#reg>0) and table.concat(reg, ',') or '(empty)',
  read_ok = read_ok, status = status_name, paused = p.paused, tick = game.tick }
`;

const BUILD = `
for _, pl in pairs(game.forces.player.platforms) do
  if pl.name:find('^pause%-rung%-') and pl.surface then game.delete_surface(pl.surface) end
end
local p = game.forces.player.create_space_platform{ name='${PLATFORM}',
  planet='nauvis', starter_pack='space-platform-starter-pack' }
if not p then return { success=false, error='create_space_platform failed' } end
p.apply_starter_pack()
local s, force = p.surface, game.forces.player
local tiles = {}
for x = 5, 13 do for y = -1, 7 do
  tiles[#tiles+1] = { name='space-platform-foundation', position={x, y} }
end end
s.set_tiles(tiles)
local eei = s.create_entity{ name='electric-energy-interface', position={7.0,5.0}, force=force }
if not eei then return { success=false, error='eei placement failed' } end
eei.power_production = 500000
local pole = s.create_entity{ name='substation', position={10.0,4.0}, force=force }
if not pole then return { success=false, error='substation placement failed' } end
local cc = s.create_entity{ name='constant-combinator', position={7.5,1.5}, force=force }
if not cc then return { success=false, error='constant combinator placement failed' } end
local sec = cc.get_control_behavior().get_section(1) or cc.get_control_behavior().add_section()
sec.set_slot(1, { value = { type='virtual', name='signal-A', quality='normal' }, min = 0 })
local dc = s.create_entity{ name='decider-combinator', position={10.5,1.5}, force=force,
  direction=defines.direction.east }
if not dc then return { success=false, error='decider placement failed' } end
dc.get_control_behavior().parameters = {
  conditions = {{ first_signal={type='virtual',name='signal-A'}, comparator='>', constant=0 }},
  outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }},
}
cc.get_wire_connector(defines.wire_connector_id.circuit_red, true)
  .connect_to(dc.get_wire_connector(defines.wire_connector_id.combinator_input_red, true))
p.paused = false
storage.__pause_rung = { platform = p.index, cc = cc.unit_number, dc = dc.unit_number }
return { success = true, platform_index = p.index }
`;

const findings = [];
function record(id, claim, evidence) {
	findings.push({ id, claim, evidence });
	say(`  ${id}: ${claim}`);
	say(`      evidence: ${evidence}`);
}

async function main() {
	try {
		say(`build -> ${JSON.stringify(lua(BUILD))}`);
		await L.sleep(4000);

		let r = lua(READ);
		if (r.status !== "working") {
			throw new Error(`rung invalid: the decider is ${r.status}, not powered — every later ` +
				`reading would be a vacuous zero`);
		}
		say(`P0a. powered, A=0, unpaused    -> ${JSON.stringify(r)}`);
		lua(PRE + "setA(5) return { success=true }");
		await L.sleep(3000);
		const p0b = lua(READ);
		say(`P0b. A=5, unpaused             -> ${JSON.stringify(p0b)}`);
		if (!/signal-S=1/.test(p0b.register)) {
			throw new Error("rung invalid: unpaused control arm did not evaluate (register empty at A=5)");
		}
		lua(PRE + "setA(0) return { success=true }");
		await L.sleep(3000);
		const p0c = lua(READ);
		say(`P0c. A=0, unpaused, register clears -> ${JSON.stringify(p0c)}`);
		if (/signal-S/.test(p0c.register)) {
			throw new Error("rung invalid: register did not clear at A=0 — instrument cannot see transitions");
		}
		record("P0", "instrument sees evaluation transitions while unpaused (control arm)",
			`A=5 register="${p0b.register}"; A=0 register="${p0c.register}"`);

		lua(PRE + "p.paused = true return { success=true }");
		await L.sleep(500);
		const pausedCheck = lua(READ);
		if (pausedCheck.paused !== true) throw new Error("rung invalid: platform.paused readback is not true");
		lua(PRE + "setA(5) return { success=true }");
		await L.sleep(3000);
		const p1 = lua(READ);
		say(`P1. paused, A set to 5         -> ${JSON.stringify(p1)}`);
		const inputPropagates = /signal-A=5/.test(p1.input);
		const evaluatesPaused = /signal-S=1/.test(p1.register);
		record("P1", `paused platform: input network ${inputPropagates ? "PROPAGATES" : "FROZEN"}, ` +
			`input-driven evaluation ${evaluatesPaused ? "FIRES" : "SILENT"}`,
			`input="${p1.input}" register="${p1.register}" paused=${p1.paused} status=${p1.status}`);

		lua(PRE + "setA(0) return { success=true }");
		await L.sleep(3000);
		const p2base = lua(READ);
		say(`P2a. paused, A back to 0       -> ${JSON.stringify(p2base)}`);
		if (/signal-S/.test(p2base.register)) {
			throw new Error("rung invalid: register held S=1 at A=0 while paused — cannot attribute a later " +
				"S=1 to the forced write");
		}
		record("P2a", "paused platform: register CLEARED when the input dropped (ongoing evaluation while paused)",
			`A 5->0 while paused; register="${p2base.register}"`);
		lua(PRE + `dc.get_control_behavior().parameters = {
			conditions = {{ first_signal={type='virtual',name='signal-A'}, comparator='>=', constant=-2147483648 }},
			outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }} }
			return { success=true }`);
		await L.sleep(3000);
		const p2forced = lua(READ);
		say(`P2b. paused, condition FORCED from empty register -> ${JSON.stringify(p2forced)}`);
		lua(PRE + `dc.get_control_behavior().parameters = {
			conditions = {{ first_signal={type='virtual',name='signal-A'}, comparator='>', constant=0 }},
			outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }} }
			return { success=true }`);
		await L.sleep(3000);
		const p2restored = lua(READ);
		say(`P2c. paused, condition restored (A=0, should clear) -> ${JSON.stringify(p2restored)}`);
		const forcedFires = /signal-S=1/.test(p2forced.register);
		const restoredClears = !/signal-S/.test(p2restored.register);
		record("P2", `paused platform: the force->restore mechanism ${forcedFires ? "EVALUATES" : "does NOT evaluate"}` +
			` (forced write fired from an EMPTY register; restore ${restoredClears ? "re-evaluated too" : "did NOT re-evaluate"})`,
			`baseline empty -> forced always-true register="${p2forced.register}" -> restored A>0 with A=0 ` +
			`register="${p2restored.register}"`);

		lua(PRE + "p.paused = false setA(0) return { success=true }");
		await L.sleep(3000);
		lua(PRE + "setA(5) return { success=true }");
		await L.sleep(3000);
		const p3 = lua(READ);
		say(`P3. unpaused again, A=5        -> ${JSON.stringify(p3)}`);
		if (!/signal-S=1/.test(p3.register)) {
			throw new Error("rung invalid: instrument dead after unpause — P1/P2 readings are not trustworthy");
		}
		record("P3", "instrument alive post-unpause (P1/P2 readings trustworthy)",
			`register="${p3.register}"`);
	} finally {
		say("cleanup:", JSON.stringify(L.lua(HOST, `local st=storage.__pause_rung
			if st then
			  for _, pl in pairs(game.forces.player.platforms) do
			    if pl.index == st.platform and pl.surface then game.delete_surface(pl.surface) end
			  end
			end
			storage.__pause_rung=nil
			return {success=true}`)));
	}
	say("\n=== findings ===");
	for (const f of findings) say(`${f.id}  ${f.claim}\n      ${f.evidence}`);
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
