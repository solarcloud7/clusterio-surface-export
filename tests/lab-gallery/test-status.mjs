// In-game test-runner status driver for the gallery test cells (owner-designed, 2026-07-18).
//
// Each stamped cell carries a status trio on its bottom border: description panel (+13.5,+11.5),
// constant-combinator (+14.5,+11.5), and a STATUS display-panel (+15.5,+11.5) red-wired to the
// combinator. The status panel's three circuit-driven messages:
//   signal-check > 0      -> green check icon, "Success"
//   signal-deny  > 0      -> alert icon, "Failure {failure-message}"
//   signal-everything = 0 -> clock icon (waiting)
// The combinator holds two sections (signal-check=1 / signal-deny=1); a batch runner drives the
// display by toggling section .active. The test-name rendering text mirrors the state as color:
//   waiting = blue {0.3,0.85,1}, pass = green {0.3,1,0.3}, fail = red {1,0.3,0.3}.
//
// The cell is located FROM THE NAME: the rendering text object whose text equals the test name;
// origin = text target - NAME_TEXT_OFFSET. No registry, no extra storage.
//
// Usage:
//   node tests/lab-gallery/test-status.mjs <test-name> waiting|pass|fail [failure message...] [--instance <name>]
// Or import { setTestStatus } from a batch runner.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { NAME_TEXT_OFFSET, PANEL_TILE_OFFSET } from "./test-foundation.mjs";

const COLORS = {
	waiting: "{r=0.3,g=0.85,b=1,a=1}",
	pass: "{r=0.3,g=1,b=0.3,a=1}",
	fail: "{r=1,g=0.3,b=0.3,a=1}",
};
const FAILURE_TEMPLATE = "Failure {failure-message}";

export function buildStatusLua(testName, status, failureMessage = "") {
	if (!COLORS[status]) throw new Error(`status must be waiting|pass|fail, got ${status}`);
	const name = String(testName).replace(/[^\w-]/g, "-");
	const message = String(failureMessage).replace(/[\\"\n]/g, " ").slice(0, 180);
	const combX = PANEL_TILE_OFFSET.x + 1.5, combY = PANEL_TILE_OFFSET.y + 0.5;
	const statX = PANEL_TILE_OFFSET.x + 2.5;
	return `/sc local ok,err=pcall(function()
		local text_obj
		for _,o in pairs(rendering.get_all_objects()) do
			if o.valid and o.type=="text" and tostring(o.text)=="${name}" then text_obj=o end
		end
		if not text_obj then error("no name text for test '${name}'") end
		local surf=text_obj.surface
		local t=text_obj.target and text_obj.target.position
		local ox,oy=t.x-(${NAME_TEXT_OFFSET.x}),t.y-(${NAME_TEXT_OFFSET.y})
		local comb=surf.find_entities_filtered{name="constant-combinator",area={{ox+${combX}-0.6,oy+${combY}-0.6},{ox+${combX}+0.6,oy+${combY}+0.6}}}[1]
		local panel=surf.find_entities_filtered{name="display-panel",area={{ox+${statX}-0.6,oy+${combY}-0.6},{ox+${statX}+0.6,oy+${combY}+0.6}}}[1]
		if not comb or not panel then error("status trio missing at origin ("..ox..","..oy..")") end
		local cb=comb.get_or_create_control_behavior()
		local s1,s2=cb.get_section(1),cb.get_section(2)
		if not (s1 and s2) then error("combinator lacks the two status sections") end
		s1.active=("${status}"=="pass")
		s2.active=("${status}"=="fail")
		local pcb=panel.get_or_create_control_behavior()
		local msgs=pcb.messages
		for _,m in ipairs(msgs) do
			if m.text and m.text:find("Failure",1,true)==1 then
				m.text=("${status}"=="fail") and ("Failure ${message}") or "${FAILURE_TEMPLATE}"
			end
		end
		pcb.messages=msgs
		text_obj.color=${COLORS[status]}
		rcon.print("status='${status}' set for '${name}' at origin ("..ox..","..oy..")")
	end) if not ok then rcon.print("ERR: "..tostring(err)) end`.replace(/\n\t*/g, " ");
}

export function setTestStatus(testName, status, failureMessage = "", instance = "surface-export-lab-gallery") {
	const out = execFileSync("docker", ["exec", "surface-export-controller", "npx", "clusterioctl",
		"--log-level", "error", "--config", "/clusterio/tokens/config-control.json",
		"instance", "send-rcon", instance, buildStatusLua(testName, status, failureMessage)],
	{ encoding: "utf8", timeout: 120_000 }).trim();
	if (out.includes("ERR:")) throw new Error(out);
	return out;
}

async function main() {
	const args = process.argv.slice(2);
	let instance = "surface-export-lab-gallery";
	const flagIndex = args.indexOf("--instance");
	if (flagIndex >= 0) { instance = args[flagIndex + 1]; args.splice(flagIndex, 2); }
	const [name, status, ...rest] = args;
	if (!name || !status) throw new Error("usage: test-status.mjs <test-name> waiting|pass|fail [failure message...] [--instance <name>]");
	console.log(setTestStatus(name, status, rest.join(" "), instance));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
