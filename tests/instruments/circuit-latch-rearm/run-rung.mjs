import { createBatchLifecycle } from "../../lab-gallery/batch-lifecycle.mjs";

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip", markerPrefix: "latch-rung",
});
const HOST = 2;
const SURFACE = `latch-rung-${Date.now() % 1000000}`;
const say = (...a) => console.log(...a);

function lua(body) {
	const r = L.lua(HOST, body);
	if (r.success === false) throw new Error(`lua failed: ${r.error}`);
	return r;
}

const PRE = `
local st = storage.__latch_rung
local s = game.get_surface(st.surface)
local cc, dc
for _, e in pairs(s.find_entities_filtered{ area = {{-10,-10},{20,20}} }) do
  if e.unit_number == st.cc then cc = e end
  if e.unit_number == st.dc then dc = e end
end
local function setA(v)
  cc.get_control_behavior().get_section(1).set_slot(1,
    { value = { type='virtual', name='signal-A', quality='normal' }, min = v })
end
local LATCH = {
  conditions = {
    { first_signal={type='virtual',name='signal-A'}, comparator='>', constant=0 },
    { first_signal={type='virtual',name='signal-S'}, comparator='>', constant=0, compare_type='or' },
  },
  outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }},
}
`;

const READ = PRE + `
local net = dc.get_circuit_network(defines.wire_connector_id.combinator_input_red)
local sigs = {}
if net then for _, x in pairs(net.signals or {}) do sigs[#sigs+1] = x.signal.name..'='..x.count end end
local status_name = 'unknown'
for k, v in pairs(defines.entity_status) do if v == dc.status then status_name = k end end
return { success = true, net = (#sigs>0) and table.concat(sigs, ',') or '(empty)',
  status = status_name, energy = math.floor(dc.energy) }
`;

const BUILD = `
for name, srf in pairs(game.surfaces) do
  if name:find('^latch%-rung%-') then game.delete_surface(srf) end
end
local s = game.create_surface('${SURFACE}', { width = 96, height = 96 })
s.request_to_generate_chunks({0,0}, 2)
s.force_generate_chunk_requests()
local force = game.forces.player
local eei = s.create_entity{ name='electric-energy-interface', position={0.5,4.5}, force=force }
eei.power_production = 500000
local pole = s.create_entity{ name='substation', position={3.5,3.5}, force=force }
local cc = s.create_entity{ name='constant-combinator', position={0.5,0.5}, force=force }
local sec = cc.get_control_behavior().get_section(1) or cc.get_control_behavior().add_section()
sec.set_slot(1, { value = { type='virtual', name='signal-A', quality='normal' }, min = 0 })
local dc = s.create_entity{ name='decider-combinator', position={3.5,0.5}, force=force, direction=defines.direction.east }
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
storage.__latch_rung = { cc = cc.unit_number, dc = dc.unit_number, surface = s.index }
return { success = true, poled = pole.valid, eei = eei.valid }
`;

const findings = [];
function record(id, claim, evidence) {
	findings.push({ id, claim, evidence });
	say(`  ${id}: ${claim}`);
	say(`      evidence: ${evidence}`);
}

async function main() {
	try {
		lua(BUILD);
		await L.sleep(4000);
		const a = lua(READ);
		if (a.status !== "working") {
			throw new Error(`rung invalid: the decider is ${a.status}, not powered — every later ` +
				`reading would be a vacuous zero`);
		}
		say(`A. powered, SET=0            -> ${JSON.stringify(a)}`);

		lua(PRE + "setA(5) return { success=true }");
		await L.sleep(3000);
		const b = lua(READ);
		say(`B. SET=5, latch arms         -> ${JSON.stringify(b)}`);

		lua(PRE + "setA(0) return { success=true }");
		await L.sleep(3000);
		const c = lua(READ);
		say(`C. SET=0, latch HOLDS        -> ${JSON.stringify(c)}`);
		if (!/signal-S=1/.test(c.net)) throw new Error("rung invalid: the latch did not hold after SET dropped");

		lua(PRE + `dc.get_control_behavior().parameters = {
			conditions = {{ first_signal={type='virtual',name='signal-A'}, comparator='>', constant=999 }},
			outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }} }
			return { success=true }`);
		await L.sleep(3000);
		lua(PRE + "dc.get_control_behavior().parameters = LATCH return { success=true }");
		await L.sleep(3000);
		const cleared = lua(READ);
		say(`C2. latch CLEARED (transferred state) -> ${JSON.stringify(cleared)}`);
		if (/signal-S/.test(cleared.net)) throw new Error("rung invalid: the latch would not clear");

		const write = L.lua(HOST, PRE +
			`local ok, err = pcall(function() dc.get_control_behavior()
				.set_signal(1, { signal={type='virtual',name='signal-S'}, count=1 }) end)
			 return { success=true, wrote=ok, err=tostring(err) }`);
		record("R1", `decider output register directly writable: ${write.wrote ? "YES" : "NO"}`,
			String(write.err));

		lua(PRE + `dc.get_control_behavior().parameters = {
			conditions = {{ first_signal={type='virtual',name='signal-A'}, comparator='>', constant=0 }},
			outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }} }
			dc.disabled_by_script = true
			return { success=true }`);
		const disBefore = lua(READ);
		lua(PRE + "setA(5) return { success=true }");
		await L.sleep(3000);
		const disAfter = lua(READ);
		lua(PRE + `dc.disabled_by_script = false
			setA(0)
			return { success=true }`);
		await L.sleep(3000);
		lua(PRE + "dc.get_control_behavior().parameters = LATCH return { success=true }");
		await L.sleep(3000);
		const disRestored = lua(READ);
		if (/signal-S/.test(disRestored.net)) {
			throw new Error("rung invalid: R2 probe left the latch armed; later readings would be polluted");
		}
		const evaluatedWhileDisabled = /signal-S=1/.test(disAfter.net);
		record("R2", `disabled_by_script stops a combinator evaluating: ${evaluatedWhileDisabled ? "NO" : "YES"}`,
			`while 'disabled': input 0->5 with condition A>0; output before="${disBefore.net}" ` +
			`after="${disAfter.net}" (${evaluatedWhileDisabled
				? "output fired — the combinator still evaluates, the disable is ineffective"
				: "output stayed silent — the disable is honoured"}); state restored="${disRestored.net}"`);

		lua(PRE + `dc.get_control_behavior().parameters = {
			conditions = {{ first_signal={type='virtual',name='signal-A'}, comparator='=', constant=0 }},
			outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }} }
			return { success=true }`);
		await L.sleep(3000);
		const forced = lua(READ);
		say(`D. condition forced true     -> ${JSON.stringify(forced)}`);

		lua(PRE + "dc.get_control_behavior().parameters = LATCH return { success=true }");
		await L.sleep(3000);
		const rearmed = lua(READ);
		say(`E. captured condition restored -> ${JSON.stringify(rearmed)}`);
		record("R3", `cleared latch re-armed via a temporary condition rewrite: ` +
			`${/signal-S=1/.test(rearmed.net) ? "YES" : "NO"}`,
			`cleared="${cleared.net}" -> forced="${forced.net}" -> restored="${rearmed.net}"`);

		lua(PRE + "dc.disabled_by_script = false return { success=true }");
		await L.sleep(3000);
		say(`F. still held                -> ${JSON.stringify(lua(READ))}`);
	} finally {
		say("cleanup:", JSON.stringify(L.lua(HOST, `local st=storage.__latch_rung
			if st then local s=game.get_surface(st.surface) if s then game.delete_surface(s) end end
			storage.__latch_rung=nil
			return {success=true}`)));
	}
	say("\n=== findings ===");
	for (const f of findings) say(`${f.id}  ${f.claim}\n      ${f.evidence}`);
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
