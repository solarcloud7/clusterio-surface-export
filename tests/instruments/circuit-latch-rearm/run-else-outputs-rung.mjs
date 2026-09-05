import { createBatchLifecycle } from "../../lab-gallery/batch-lifecycle.mjs";

const L = createBatchLifecycle({
	goldenSourceSave: "unused.zip", goldenDestSave: "unused.zip", markerPrefix: "else-rung",
});
const HOST = 2;
const SURFACE = `else-rung-${Date.now() % 1000000}`;
const say = (...a) => console.log(...a);

function lua(body) {
	const r = L.lua(HOST, body);
	if (r.success === false) throw new Error(`lua failed: ${r.error}`);
	return r;
}

const BUILD_PROBE = `
for name, srf in pairs(game.surfaces) do
  if name:find('^else%-rung%-') then game.delete_surface(srf) end
end
local s = game.create_surface('${SURFACE}', { width = 32, height = 32 })
s.request_to_generate_chunks({0,0}, 1)
s.force_generate_chunk_requests()
storage.__else_rung = { surface = s.index }
local dc = s.create_entity{ name='decider-combinator', position={0.5,0.5},
  force=game.forces.player, direction=defines.direction.east }
if not dc then return { success=false, error='decider placement failed' } end
local cb = dc.get_control_behavior()
local wrote_ok, write_err = pcall(function()
  cb.parameters = {
    conditions = {{ first_signal={type='virtual',name='signal-A'}, comparator='>', constant=0 }},
    outputs = {{ signal={type='virtual',name='signal-S'}, copy_count_from_input=false }},
    else_outputs = {{ signal={type='virtual',name='signal-R'}, copy_count_from_input=false }},
  }
end)
if not wrote_ok then
  return { success=true, write_accepted=false, write_err=tostring(write_err) }
end
local p1 = cb.parameters
local e1 = p1.else_outputs ~= nil and #(p1.else_outputs or {}) > 0
local e1_signal = e1 and tostring(p1.else_outputs[1].signal.name) or 'nil'
cb.parameters = { conditions = p1.conditions, outputs = p1.outputs }
local p2 = cb.parameters
local e2_cleared = (p2.else_outputs == nil) or #(p2.else_outputs or {}) == 0
return { success=true, write_accepted=true, e1_emitted=e1, e1_signal=e1_signal, e2_cleared=e2_cleared }
`;

const findings = [];
function record(id, claim, evidence) {
	findings.push({ id, claim, evidence });
	say(`  ${id}: ${claim}`);
	say(`      evidence: ${evidence}`);
}

async function main() {
	try {
		const r = lua(BUILD_PROBE);
		say(`probe -> ${JSON.stringify(r)}`);
		if (r.write_accepted === false) {
			record("E0", "cb.parameters write REFUSES else_outputs at this pin", r.write_err);
		} else {
			record("E1", `cb.parameters getter emits else_outputs: ${r.e1_emitted ? "YES" : "NO"}`,
				`set else_outputs={signal-R}; readback else_outputs[1].signal.name=${r.e1_signal}`);
			record("E2", `a {conditions, outputs}-only write clears a previously-set else_outputs: ${r.e2_cleared ? "YES" : "NO"}`,
				`rewrote parameters without else_outputs; readback ${r.e2_cleared ? "empty" : "STILL PRESENT"}`);
		}
	} finally {
		say("cleanup:", JSON.stringify(L.lua(HOST, `local st=storage.__else_rung
			if st then local s=game.get_surface(st.surface) if s then game.delete_surface(s) end end
			storage.__else_rung=nil
			return {success=true}`)));
	}
	say("\n=== findings ===");
	for (const f of findings) say(`${f.id}  ${f.claim}\n      ${f.evidence}`);
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
