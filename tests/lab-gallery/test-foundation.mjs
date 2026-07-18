// The gallery test-foundation template, captured tile-exact from the live omnibus
// (lab-omnibus-platform-v1, cell origin (34,-128), 2026-07-18). One cell is 26x12:
//   - left half: the 12x12 tutorial-grid fixture pad inside a refined-hazard border
//   - col 13: the hazard-concrete-left divider strip
//   - right half: the refined-concrete emblem pad
//   - display panel ON the border at origin+(13,11) (tile), i.e. entity pos +(13.5,11.5)
//   - test-name rendering text above the pad at origin+(6,-1.5), scale 2.5, cyan
// Grid pitch between cells: 28 horizontal, 14 vertical.
// Tutorial-grid cannot ride a blueprint (not blueprintable), which is why this template
// is recorded as data here instead of a blueprint string.
//
// Usage (stamp a new cell live):
//   node tests/lab-gallery/test-foundation.mjs <originX> <originY> <test-name> [instance]
// The stamp is REFUSED unless every target tile is empty-space (the only-onto-empty rule)
// or the cell already matches the template exactly (idempotent re-stamp).

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const CELL_WIDTH = 26;
export const CELL_HEIGHT = 12;
export const CELL_PITCH = { x: 28, y: 14 };
export const PANEL_TILE_OFFSET = { x: 13, y: 11 };
export const NAME_TEXT_OFFSET = { x: 6, y: -1.5 };
// Name-text color IS the test status (owner-designed runner display, 2026-07-18):
// waiting = blue, pass = green, fail = red (driven by test-status.mjs). New stamps start waiting.
export const NAME_TEXT_STYLE = { scale: 2.5, color: { r: 0.3, g: 0.85, b: 1, a: 1 } };

export const LEGEND = {
	T: "tutorial-grid",
	L: "refined-hazard-concrete-left",
	R: "refined-hazard-concrete-right",
	h: "hazard-concrete-left",
	C: "refined-concrete",
};

// 12 rows x 26 cols, top-left = cell origin. Read from the world, byte-exact.
export const TEMPLATE_ROWS = [
	"LLLLLRRRRRRRRRLLLLLLRRRRRR",
	"LTTTTTTTTTTTThLTTTTLRTTTTR",
	"LTTTTTTTTTTTThLTCCTLRTCCTR",
	"LTTTTTTTTTTTThLTCTTLRTTCTR",
	"LTTTTTTTTTTTThLTTTLTTRTTTR",
	"LTTTTTTTTTTTThLLLLTCCTRRRR",
	"RTTTTTTTTTTTThRRRRTCCTLLLL",
	"RTTTTTTTTTTTThRTTTRTTLTTTL",
	"RTTTTTTTTTTTThRTCTTRLTTCTL",
	"RTTTTTTTTTTTThRTCCTRLTCCTL",
	"RTTTTTTTTTTTThRTTTTRLTTTTL",
	"RRRRRRLLLLLRRRRRRRRRLLLLLL",
];

/**
 * Emit the one-shot /sc Lua that stamps a foundation cell at (originX, originY) on the
 * player's current surface (falls back to lab-omnibus-platform-v1 headless), places the
 * description display-panel, and draws the name text. Refuses on any non-empty collision
 * unless the cell already matches the template (idempotent).
 */
export function buildFoundationLua(originX, originY, testName) {
	const rows = TEMPLATE_ROWS.join(",");
	const legend = Object.entries(LEGEND).map(([k, v]) => `${k}="${v}"`).join(",");
	const name = String(testName).replace(/[^\w-]/g, "-");
	return `/sc local ok,err=pcall(function()
		local rows={${TEMPLATE_ROWS.map(r => `"${r}"`).join(",")}}
		local legend={${legend}}
		local s=(game.connected_players[1] and game.connected_players[1].surface)
		if not s or not s.platform then for _,p in pairs(game.forces.player.platforms) do if p.valid and p.name=="lab-omnibus-platform-v1" then s=p.surface end end end
		local ox,oy=${Math.trunc(originX)},${Math.trunc(originY)}
		local tiles={} local mismatch=0 local already=0
		for r=1,#rows do for c=1,#rows[r] do
			local ch=rows[r]:sub(c,c) local want=legend[ch]
			if want then
				local x,y=ox+c-1,oy+r-1
				local cur=s.get_tile(x,y).name
				if cur==want then already=already+1
				elseif cur=="empty-space" then tiles[#tiles+1]={name=want,position={x,y}}
				else mismatch=mismatch+1 end
			end
		end end
		if mismatch>0 then error("REFUSED: "..mismatch.." target tile(s) hold foreign tiles (only-onto-empty rule)") end
		if #tiles>0 then s.set_tiles(tiles) end
		local px,py=ox+${PANEL_TILE_OFFSET.x}+0.5,oy+${PANEL_TILE_OFFSET.y}+0.5
		local panel=s.find_entities_filtered{name="display-panel",area={{px-0.5,py-0.5},{px+0.5,py+0.5}}}[1]
		if not panel then panel=s.create_entity{name="display-panel",position={px,py},force="player"} end
		if panel and (panel.display_panel_text==nil or panel.display_panel_text=="") then
			panel.display_panel_text="LAW: \\n{law}\\n\\nACTION: \\n{action}\\n\\nEXPECT: \\n{expect}\\n\\nFORBIDDEN: \\n{forbidden}"
		end
		local comb=s.find_entities_filtered{name="constant-combinator",area={{px+0.5,py-0.5},{px+1.5,py+0.5}}}[1]
		if not comb then comb=s.create_entity{name="constant-combinator",position={px+1,py},force="player"} end
		local ccb=comb.get_or_create_control_behavior()
		while #ccb.sections<2 do ccb.add_section() end
		ccb.get_section(1).filters={{value={type="virtual",name="signal-check",quality="normal",comparator="="},min=1}}
		ccb.get_section(2).filters={{value={type="virtual",name="signal-deny",quality="normal",comparator="="},min=1}}
		ccb.get_section(1).active=false ccb.get_section(2).active=false
		local status=s.find_entities_filtered{name="display-panel",area={{px+1.5,py-0.5},{px+2.5,py+0.5}}}[1]
		if not status then status=s.create_entity{name="display-panel",position={px+2,py},force="player"} end
		status.display_panel_always_show=true
		status.display_panel_show_in_chart=true
		local scb=status.get_or_create_control_behavior()
		scb.messages={{icon={type="virtual",name="signal-check"},text="Success",condition={first_signal={type="virtual",name="signal-check"},comparator=">",constant=0}},{icon={type="virtual",name="signal-alert"},text="Failure {failure-message}",condition={first_signal={type="virtual",name="signal-deny"},comparator=">",constant=0}},{icon={type="virtual",name="signal-clock"},condition={first_signal={type="virtual",name="signal-everything"},comparator="=",constant=0}}}
		status.get_wire_connector(defines.wire_connector_id.circuit_red,true).connect_to(comb.get_wire_connector(defines.wire_connector_id.circuit_red,true))
		rendering.draw_text{text="${name}",surface=s,target={ox+${NAME_TEXT_OFFSET.x},oy+(${NAME_TEXT_OFFSET.y})},scale=${NAME_TEXT_STYLE.scale},color={r=${NAME_TEXT_STYLE.color.r},g=${NAME_TEXT_STYLE.color.g},b=${NAME_TEXT_STYLE.color.b},a=1}}
		rcon.print("stamped origin=("..ox..","..oy..") wrote="..#tiles.." already="..already.." trio="..tostring(panel~=nil and comb~=nil and status~=nil))
	end) if not ok then rcon.print("ERR: "..tostring(err)) end`.replace(/\n\t*/g, " ");
}

async function main() {
	const [ox, oy, name, instance = "surface-export-lab-gallery"] = process.argv.slice(2);
	if (!ox || !oy || !name) throw new Error("usage: test-foundation.mjs <originX> <originY> <test-name> [instance]");
	const out = execFileSync("docker", ["exec", "surface-export-controller", "npx", "clusterioctl",
		"--log-level", "error", "--config", "/clusterio/tokens/config-control.json",
		"instance", "send-rcon", instance, buildFoundationLua(Number(ox), Number(oy), name)],
	{ encoding: "utf8", timeout: 120_000 });
	console.log(out.trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
