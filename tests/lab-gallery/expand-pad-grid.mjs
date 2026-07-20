#!/usr/bin/env node
// expand-pad-grid.mjs — add blank OPEN-SLOT rows to the live omnibus pad grid (2026-07-19).
//
// Owner direction: "another several rows to lab-omnibus-state-v1". Stamps empty test-foundation
// cells (template tiles + status trio + name label, NO fixture) on new rows below the existing
// grid, then fills the connecting walkway band. Live-RCON only (the owner is playing); stamp code
// is the proven port from complete-live-gallery.mjs / seed-prep-ops.lua stamp_test_cell.
// Idempotent: re-running skips already-stamped tiles/entities.
//
//   node tests/lab-gallery/expand-pad-grid.mjs            (stamp all open slots + walkways)
//   node tests/lab-gallery/expand-pad-grid.mjs --dry      (report only)

import { execFileSync } from "node:child_process";

import { LEGEND, TEMPLATE_ROWS } from "./test-foundation.mjs";

const CONTROLLER = "surface-export-controller";
const CTL_CONFIG = "/clusterio/tokens/config-control.json";
const GALLERY = "surface-export-lab-gallery";
const OMNIBUS = "lab-omnibus-state-v1";

// Grid geometry (docs/testing.md pad-grid layout): columns x=8/36/64/92, row pitch 14.
const COLUMNS = [8, 36, 64, 92];
const NEW_ROWS = [36, 50, 64];
const OPEN_CARD = {
	law: "OPEN SLOT — reserved for a future test.",
	action: "Claim it: add a manifest fixture with this origin, build the fixture on the left half.",
	expect: "Nothing here yet. /test-run reports this cell as UNKNOWN PAD until claimed.",
	forbidden: "Do not store loose materials on the pad; the paste zone (right half) is swept by /test-run.",
};

function docker(args, timeout = 120_000) {
	return execFileSync("docker", args, {
		encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
	});
}
function rcon(command, timeout = 240_000) {
	return docker(["exec", CONTROLLER, "npx", "clusterioctl", "--log-level", "error",
		"instance", "send-rcon", GALLERY, command, "--config", CTL_CONFIG], timeout).trim();
}
function luaJson(body, timeout = 240_000) {
	const raw = rcon(`/sc local out={} local ok,err=pcall(function() ${body} end) ` +
		`if not ok then out={success=false,error=tostring(err)} end rcon.print(helpers.table_to_json(out))`, timeout);
	const last = raw.split(/\r?\n/).filter(Boolean).at(-1) || "";
	try { return JSON.parse(last); }
	catch (error) { throw new Error(`unparseable Lua JSON (${error.message}): ${last.slice(0, 500)}`); }
}
function jlit(value) { return JSON.stringify(value).replace(/'/g, "\\'"); }

const OMNI = `local plat for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=='${OMNIBUS}' then plat=p end end ` +
	`if not plat then out.success=false out.error='omnibus platform missing' return end local s=plat.surface `;

function stampOpenSlot(id, ox, oy) {
	const body = `${OMNI}
		local rows=helpers.json_to_table('${jlit(TEMPLATE_ROWS)}')
		local legend=helpers.json_to_table('${jlit(LEGEND)}')
		local card=helpers.json_to_table('${jlit(OPEN_CARD)}')
		local ox,oy=${ox},${oy}
		local tiles,mismatch,already={},0,0
		for r=1,#rows do local row=rows[r] for c=1,#row do
			local ch=string.sub(row,c,c) local want=legend[ch]
			if want then local x,y=ox+c-1,oy+r-1 local cur=s.get_tile(x,y).name
				if cur==want then already=already+1
				elseif cur=='empty-space' or cur=='space-platform-foundation' then tiles[#tiles+1]={name=want,position={x,y}}
				else mismatch=mismatch+1 end
			end
		end end
		if mismatch>0 then out.success=false out.error='REFUSED: '..mismatch..' target tile(s) hold foreign tiles' return end
		if #tiles>0 then s.set_tiles(tiles) end
		local dpx,dpy=ox+13.5,oy+11.5
		local desc=s.find_entities_filtered({name='display-panel',area={{dpx-0.4,dpy-0.4},{dpx+0.4,dpy+0.4}}})[1]
		if not desc then desc=s.create_entity({name='display-panel',position={dpx,dpy},force='player'}) end
		if not desc then out.success=false out.error='desc panel failed' return end
		local function cf(f) return tostring(card[f] or '') end
		desc.display_panel_text='LAW: \\n'..cf('law')..'\\n\\nACTION: \\n'..cf('action')..'\\n\\nEXPECT: \\n'..cf('expect')..'\\n\\nFORBIDDEN: \\n'..cf('forbidden')
		local ccx,ccy=ox+14.5,oy+11.5
		local comb=s.find_entities_filtered({name='constant-combinator',area={{ccx-0.4,ccy-0.4},{ccx+0.4,ccy+0.4}}})[1]
		if not comb then comb=s.create_entity({name='constant-combinator',position={ccx,ccy},force='player'}) end
		if not comb then out.success=false out.error='combinator failed' return end
		local cb=comb.get_or_create_control_behavior()
		local sec1=cb.sections[1] or cb.add_section()
		local sec2=cb.sections[2] or cb.add_section()
		sec1.filters={{value={type='virtual',name='signal-check',quality='normal',comparator='='},min=1}}
		sec2.filters={{value={type='virtual',name='signal-deny',quality='normal',comparator='='},min=1}}
		sec1.active=false sec2.active=false
		local spx,spy=ox+15.5,oy+11.5
		local status=s.find_entities_filtered({name='display-panel',area={{spx-0.4,spy-0.4},{spx+0.4,spy+0.4}}})[1]
		if not status then status=s.create_entity({name='display-panel',position={spx,spy},force='player'}) end
		if not status then out.success=false out.error='status panel failed' return end
		status.display_panel_always_show=true status.display_panel_show_in_chart=true
		status.get_wire_connector(defines.wire_connector_id.circuit_red,true).connect_to(comb.get_wire_connector(defines.wire_connector_id.circuit_red,true))
		status.get_or_create_control_behavior().messages={
			{icon={type='virtual',name='signal-check'},text='Success',condition={first_signal={type='virtual',name='signal-check'},comparator='>',constant=0}},
			{icon={type='virtual',name='signal-alert'},text='Failure {failure-message}',condition={first_signal={type='virtual',name='signal-deny'},comparator='>',constant=0}},
			{icon={type='virtual',name='signal-clock'},condition={first_signal={type='virtual',name='signal-everything'},comparator='=',constant=0}}}
		local tx,ty=ox+6,oy-1.5 local has_name=false
		for _,o in pairs(rendering.get_all_objects('')) do
			if o.valid and o.type=='text' and o.surface==s then local t=o.target
				if t and t.position and t.position.x==tx and t.position.y==ty then has_name=true break end end
		end
		if not has_name then rendering.draw_text({text='${id}',surface=s,target={tx,ty},scale=2.5,color={r=0.6,g=0.6,b=0.6,a=1}}) end
		out.success=true out.wrote=#tiles out.already=already`;
	return luaJson(body);
}

// Fill the walkway band connecting the existing bottom row (y=22 cells end ~y=34) through the new
// rows: any empty-space tile in the band becomes plain foundation. Pads stamped above keep their
// template tiles (set first if new rows stamp after — we stamp pads FIRST, then fill around them).
function fillWalkways(yTop, yBottom) {
	const body = `${OMNI}
		local tiles={}
		for y=${yTop},${yBottom} do for x=4,120 do
			if s.get_tile(x,y).name=='empty-space' then tiles[#tiles+1]={name='space-platform-foundation',position={x,y}} end
		end end
		if #tiles>0 then s.set_tiles(tiles) end
		out.success=true out.filled=#tiles`;
	return luaJson(body, 300_000);
}

async function main() {
	const dry = process.argv.includes("--dry");
	const slots = [];
	for (const oy of NEW_ROWS) for (const ox of COLUMNS) {
		slots.push([`open-slot-${ox}-${oy}`, ox, oy]);
	}
	if (dry) { console.log(slots.map(([id]) => id).join("\n")); return; }
	for (const [id, ox, oy] of slots) {
		const r = stampOpenSlot(id, ox, oy);
		console.log(`${id}: ${JSON.stringify(r)}`);
		if (r.success === false) throw new Error(`${id} stamp failed: ${r.error}`);
	}
	// Band from just above the first new row to just below the last new cell (cell height 13 incl. trio row).
	const fill = fillWalkways(NEW_ROWS[0] - 2, NEW_ROWS.at(-1) + 13);
	console.log(`walkways: ${JSON.stringify(fill)}`);
}

main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
