#!/usr/bin/env node
// requires: a reachable cluster (dev, or a remote named in tools/clusterio/remote-clusters.local.json) with running instances
// produces: a JSON snapshot of one player on every running instance (body, gear, grids, platform, passenger and arrival records) and a diff of two snapshots with item totals
// does not: change game state, read an offline player's body (the engine hides it), or prove where unreadable items went
import { readFileSync, writeFileSync } from "node:fs";
import url from "node:url";
import { DEVELOPMENT, parseInstanceList, withCluster } from "../shared/remote-cluster.mjs";

const INVENTORIES = ["armor", "main", "guns", "ammo", "trash"];

export function snapshotLua(player) {
	if (!/^[A-Za-z0-9_.-]+$/.test(player)) throw new Error(`Unsupported player name: ${player}`);
	return `local p = game.get_player("${player}")
if not p then return {present = false} end
local function contents(inv)
	local out = {}
	if not (inv and inv.valid) then return out end
	for _, item in pairs(inv.get_contents()) do
		local key = item.name
		if item.quality and item.quality ~= "normal" then key = key .. "@" .. item.quality end
		out[key] = (out[key] or 0) + item.count
	end
	return out
end
local function grids(inv, where, out)
	if not (inv and inv.valid) then return end
	for slot = 1, #inv do
		local stack = inv[slot]
		if stack.valid_for_read and stack.grid then
			local equipment = {}
			for _, e in pairs(stack.grid.equipment) do equipment[#equipment + 1] = e.name end
			table.sort(equipment)
			out[#out + 1] = {where = where, slot = slot, item = stack.name, equipment = table.concat(equipment, ",")}
		end
	end
end
local controller = tostring(p.controller_type)
for name, value in pairs(defines.controllers) do if value == p.controller_type then controller = name end end
local body
local c = p.character
if c and c.valid then
	local armor = c.get_inventory(defines.inventory.character_armor)
	local main = c.get_main_inventory()
	local grid_list = {}
	grids(armor, "armor", grid_list)
	grids(main, "main", grid_list)
	body = {unit = c.unit_number, surface = c.surface.name, x = math.floor(c.position.x), y = math.floor(c.position.y),
		armor = contents(armor), main = contents(main),
		guns = contents(c.get_inventory(defines.inventory.character_guns)),
		ammo = contents(c.get_inventory(defines.inventory.character_ammo)),
		trash = contents(c.get_inventory(defines.inventory.character_trash)),
		cursor = p.cursor_stack and p.cursor_stack.valid_for_read and (p.cursor_stack.name .. " x" .. p.cursor_stack.count) or nil,
		grids = grid_list}
end
local physical = game.get_surface(p.physical_surface_index)
local record = storage.surface_export_passengers and storage.surface_export_passengers[p.index]
local arrivals = {}
for key, arrival in pairs((storage.surface_export_arrivals or {})[p.name] or {}) do
	arrivals[#arrivals + 1] = {key = key, items = #(arrival.items or {}), boarding = arrival.boarding_done and tostring(arrival.boarding_done) or nil}
end
return {present = true, connected = p.connected, controller = controller,
	physical_surface = physical and physical.name or nil,
	aboard = physical and physical.platform and physical.platform.name or nil,
	body = body,
	passenger = record and {state = record.state, job = record.job_id, notified = record.notified == true, destination = record.destination_name} or nil,
	arrivals = arrivals}`.replace(/\n\s*/g, " ");
}

export function bodyTotals(body) {
	const totals = {};
	for (const inventory of INVENTORIES) {
		for (const [item, count] of Object.entries(body?.[inventory] || {})) totals[item] = (totals[item] || 0) + count;
	}
	return totals;
}

export function summarize(snapshot) {
	const totals = {};
	const unreadable = [];
	for (const [instance, state] of Object.entries(snapshot.instances)) {
		if (!state.present) continue;
		if (!state.body) { unreadable.push(instance); continue; }
		for (const [item, count] of Object.entries(bodyTotals(state.body))) totals[item] = (totals[item] || 0) + count;
	}
	return { totals, unreadable };
}

function where(state) {
	if (!state?.present) return "not on this instance";
	const place = state.aboard ? `aboard ${state.aboard}` : state.physical_surface || "?";
	const body = state.body ? `body ${state.body.unit} on ${state.body.surface}` : "no readable body";
	return `${state.connected ? "online" : "offline"}, ${state.controller}, ${place}, ${body}`;
}

function delta(before = {}, after = {}) {
	const changes = [];
	for (const item of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
		const change = (after[item] || 0) - (before[item] || 0);
		if (change) changes.push(`${item} ${change > 0 ? "+" : ""}${change}`);
	}
	return changes;
}

export function diffSnapshots(before, after) {
	const lines = [];
	const instances = [...new Set([...Object.keys(before.instances), ...Object.keys(after.instances)])].sort();
	for (const instance of instances) {
		const a = before.instances[instance];
		const b = after.instances[instance];
		const was = where(a);
		const now = where(b);
		lines.push(`${instance}: ${was === now ? now : `${was} -> ${now}`}`);
		if (a?.body && b?.body) {
			for (const inventory of INVENTORIES) {
				const changes = delta(a.body[inventory], b.body[inventory]);
				if (changes.length) lines.push(`  ${inventory}: ${changes.join(", ")}`);
			}
			const gridsBefore = JSON.stringify(a.body.grids || []);
			const gridsAfter = JSON.stringify(b.body.grids || []);
			if (gridsBefore !== gridsAfter) lines.push(`  grids: ${gridsBefore} -> ${gridsAfter}`);
		}
		if (JSON.stringify(a?.passenger ?? null) !== JSON.stringify(b?.passenger ?? null)) {
			lines.push(`  passenger record: ${JSON.stringify(a?.passenger ?? null)} -> ${JSON.stringify(b?.passenger ?? null)}`);
		}
		if (JSON.stringify(a?.arrivals ?? []) !== JSON.stringify(b?.arrivals ?? [])) {
			lines.push(`  arrivals: ${JSON.stringify(a?.arrivals ?? [])} -> ${JSON.stringify(b?.arrivals ?? [])}`);
		}
	}
	const first = summarize(before);
	const second = summarize(after);
	const totalChanges = delta(first.totals, second.totals);
	const unreadable = [...new Set([...first.unreadable, ...second.unreadable])];
	if (unreadable.length) {
		lines.push(`totals: incomplete, no readable body on ${unreadable.join(", ")} (offline bodies are hidden by the engine)`);
		if (totalChanges.length) lines.push(`  readable change: ${totalChanges.join(", ")}`);
	} else if (totalChanges.length) {
		lines.push(`totals: CHANGED ${totalChanges.join(", ")}`);
	} else {
		lines.push("totals: unchanged across all instances (nothing created or lost)");
	}
	return { lines, conserved: unreadable.length === 0 && totalChanges.length === 0, complete: unreadable.length === 0 };
}

export async function takeSnapshot(cluster, player, { run = withCluster } = {}) {
	return run(cluster, transport => {
		const running = parseInstanceList(transport.ctl("instance", "list")).filter(row => row.status === "running");
		const instances = {};
		for (const row of running) instances[row.name] = transport.lua(row.name, snapshotLua(player));
		return { cluster, player, takenAt: new Date().toISOString(), instances };
	});
}

const USAGE = `usage: node tools/surface-export/player-state.mjs --player <name> [--cluster dev|<name>] [--out snapshot.json]
       node tools/surface-export/player-state.mjs --diff <before.json> <after.json>`;

export async function main(argv, { out = process.stdout, err = process.stderr, snapshot = takeSnapshot } = {}) {
	const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
	if (argv.includes("--diff")) {
		const [beforeFile, afterFile] = argv.slice(argv.indexOf("--diff") + 1);
		if (!beforeFile || !afterFile) { err.write(`${USAGE}\n`); return 2; }
		const result = diffSnapshots(JSON.parse(readFileSync(beforeFile, "utf8")), JSON.parse(readFileSync(afterFile, "utf8")));
		out.write(`${result.lines.join("\n")}\n`);
		return result.complete && !result.conserved ? 1 : 0;
	}
	const player = value("--player");
	if (!player) { err.write(`${USAGE}\n`); return 2; }
	try {
		const state = await snapshot(value("--cluster") || DEVELOPMENT, player);
		const json = JSON.stringify(state, null, 2);
		if (value("--out")) writeFileSync(value("--out"), `${json}\n`);
		for (const [instance, instanceState] of Object.entries(state.instances)) out.write(`${instance}: ${where(instanceState)}\n`);
		const { totals, unreadable } = summarize(state);
		out.write(`readable items: ${Object.entries(totals).map(([item, count]) => `${item} ${count}`).join(", ") || "none"}${unreadable.length ? ` (no readable body on ${unreadable.join(", ")})` : ""}\n`);
		if (value("--out")) out.write(`saved ${value("--out")}\n`);
		return 0;
	} catch (error) {
		err.write(`${String(error.stderr || error.message).trim()}\n`);
		return 1;
	}
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
