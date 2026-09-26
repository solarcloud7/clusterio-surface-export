#!/usr/bin/env node
// requires: a reachable cluster (dev, or a remote named in tools/clusterio/remote-clusters.local.json)
// produces: a JSON snapshot of one player on every instance, each observed, absent or unavailable with a reason, with possessions as {item, quality, count, location} across inventories, cursor and equipment grids; a diff of two snapshots that gives a conservation verdict only from complete evidence
// does not: change game state, read an offline player's body (the engine hides it), take instances at the same instant (each is read in turn, so a player moving between instances mid-snapshot can be seen twice or not at all), or prove where unobserved items went; gear waiting in arrival records and passenger manifests counts as the player's
import { readFileSync, writeFileSync } from "node:fs";
import url from "node:url";
import { DEVELOPMENT, parseInstanceList, withCluster } from "../shared/remote-cluster.mjs";

export function snapshotLua(player) {
	if (!/^[A-Za-z0-9_.-]+$/.test(player)) throw new Error(`Unsupported player name: ${player}`);
	return `local p = game.get_player("${player}")
if not p then return {observation = "absent"} end
local possessions = {}
local function quality_of(thing) return thing.quality and thing.quality.name or "normal" end
local function add_stack(stack, location)
	possessions[#possessions + 1] = {item = stack.name, quality = quality_of(stack), count = stack.count, location = location}
	if stack.grid then
		for _, e in pairs(stack.grid.equipment) do
			possessions[#possessions + 1] = {item = e.name, quality = quality_of(e), count = 1, location = "grid:" .. location}
		end
	end
end
local function scan(inv, location)
	if not (inv and inv.valid) then return end
	for slot = 1, #inv do
		local stack = inv[slot]
		if stack.valid_for_read then add_stack(stack, location) end
	end
end
local controller = tostring(p.controller_type)
for name, value in pairs(defines.controllers) do if value == p.controller_type then controller = name end end
local body
local c = p.character
if c and c.valid then
	scan(c.get_inventory(defines.inventory.character_armor), "armor")
	scan(c.get_main_inventory(), "main")
	scan(c.get_inventory(defines.inventory.character_guns), "guns")
	scan(c.get_inventory(defines.inventory.character_ammo), "ammo")
	scan(c.get_inventory(defines.inventory.character_trash), "trash")
	local cursor = p.cursor_stack
	if cursor and cursor.valid_for_read then add_stack(cursor, "cursor") end
	body = {unit = c.unit_number, surface = c.surface.name, x = math.floor(c.position.x), y = math.floor(c.position.y), possessions = possessions}
end
local physical = game.get_surface(p.physical_surface_index)
local record = storage.surface_export_passengers and storage.surface_export_passengers[p.index]
local arrivals = {}
local pending = {}
local function add_serialized(items, location)
	for _, entry in ipairs(items or {}) do
		if type(entry) == "table" and type(entry.name) == "string" then
			pending[#pending + 1] = {item = entry.name, quality = type(entry.quality) == "string" and entry.quality or "normal", count = entry.count or 1, location = location}
		end
	end
end
for key, arrival in pairs((storage.surface_export_arrivals or {})[p.name] or {}) do
	arrivals[#arrivals + 1] = {key = key, items = #(arrival.items or {}), boarding = arrival.boarding_done and tostring(arrival.boarding_done) or nil}
	add_serialized(arrival.items, "pending:arrival:" .. key)
end
for job, manifest in pairs(storage.surface_export_passenger_manifests or {}) do
	for _, entry in ipairs(manifest) do
		if entry.name == p.name then add_serialized(entry.items, "pending:manifest:" .. job) end
	end
end
return {observation = "observed", connected = p.connected, controller = controller,
	physical_surface = physical and physical.name or nil,
	aboard = physical and physical.platform and physical.platform.name or nil,
	body = body,
	passenger = record and {state = record.state, job = record.job_id, notified = record.notified == true, destination = record.destination_name} or nil,
	arrivals = arrivals, pending = pending}`.replace(/\n\s*/g, " ");
}

export function normalizeObservation(raw) {
	if (raw && (raw.observation === "observed" || raw.observation === "absent")) return raw;
	if (raw && raw.observation === "unavailable") return raw;
	const reason = raw?.error ? `snapshot failed: ${raw.error}` : "no usable observation";
	return { observation: "unavailable", reason };
}

function key(possession) {
	return possession.quality && possession.quality !== "normal" ? `${possession.item}@${possession.quality}` : possession.item;
}

export function countPossessions(possessions = [], byLocation = false) {
	const counts = {};
	for (const possession of possessions) {
		const name = byLocation ? `${possession.location} ${key(possession)}` : key(possession);
		counts[name] = (counts[name] || 0) + Number(possession.count || 0);
	}
	return counts;
}

function possessionsOf(state) {
	return [...(state.body?.possessions || []), ...(state.pending || [])];
}

export function summarize(snapshot) {
	const totals = {};
	const unavailable = [];
	const unreadable = [];
	let observed = 0;
	for (const [instance, raw] of Object.entries(snapshot.instances || {})) {
		const state = normalizeObservation(raw);
		if (state.observation === "unavailable") { unavailable.push(`${instance} (${state.reason})`); continue; }
		observed += 1;
		if (state.observation === "absent") continue;
		if (!state.body) { unreadable.push(instance); continue; }
		for (const [item, count] of Object.entries(countPossessions(possessionsOf(state)))) totals[item] = (totals[item] || 0) + count;
	}
	return { totals, unavailable, unreadable, observed };
}

function where(raw) {
	const state = normalizeObservation(raw);
	if (state.observation === "unavailable") return `unavailable: ${state.reason}`;
	if (state.observation === "absent") return "player absent";
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
	const beforeNames = Object.keys(before.instances || {});
	const afterNames = Object.keys(after.instances || {});
	const instances = [...new Set([...beforeNames, ...afterNames])].sort();
	for (const instance of instances) {
		const a = normalizeObservation(before.instances?.[instance] ?? { observation: "unavailable", reason: "not in the before snapshot" });
		const b = normalizeObservation(after.instances?.[instance] ?? { observation: "unavailable", reason: "not in the after snapshot" });
		const was = where(a);
		const now = where(b);
		lines.push(`${instance}: ${was === now ? now : `${was} -> ${now}`}`);
		if (a.observation === "observed" && b.observation === "observed") {
			const changes = delta(countPossessions(possessionsOf(a), true), countPossessions(possessionsOf(b), true));
			if (changes.length) lines.push(`  ${changes.join(", ")}`);
		}
		if (JSON.stringify(a.passenger ?? null) !== JSON.stringify(b.passenger ?? null)) {
			lines.push(`  passenger record: ${JSON.stringify(a.passenger ?? null)} -> ${JSON.stringify(b.passenger ?? null)}`);
		}
		if (JSON.stringify(a.arrivals ?? []) !== JSON.stringify(b.arrivals ?? [])) {
			lines.push(`  arrivals: ${JSON.stringify(a.arrivals ?? [])} -> ${JSON.stringify(b.arrivals ?? [])}`);
		}
	}
	const first = summarize(before);
	const second = summarize(after);
	const gaps = [];
	for (const [label, summary] of [["before", first], ["after", second]]) {
		if (summary.observed === 0) gaps.push(`no instance was observed in the ${label} snapshot`);
		for (const entry of summary.unavailable) gaps.push(`${label}: ${entry}`);
		for (const instance of summary.unreadable) gaps.push(`${label}: no readable body on ${instance} (offline bodies are hidden by the engine)`);
	}
	if (beforeNames.sort().join(",") !== afterNames.sort().join(",")) gaps.push("the snapshots cover different instances");
	if (before.player !== after.player) gaps.push(`the snapshots are of different players (${before.player} and ${after.player})`);
	if (before.cluster !== after.cluster) gaps.push(`the snapshots are from different clusters (${before.cluster} and ${after.cluster})`);
	const totalChanges = delta(first.totals, second.totals);
	const complete = gaps.length === 0;
	if (!complete) {
		lines.push(`totals: UNKNOWN, evidence incomplete: ${gaps.join("; ")}`);
		if (totalChanges.length) lines.push(`  observed change: ${totalChanges.join(", ")}`);
	} else if (totalChanges.length) {
		lines.push(`totals: CHANGED ${totalChanges.join(", ")}`);
	} else {
		lines.push("totals: unchanged across all instances (nothing created or lost)");
	}
	return { lines, conserved: complete && totalChanges.length === 0, complete };
}

export async function takeSnapshot(cluster, player, { run = withCluster } = {}) {
	return run(cluster, transport => {
		const rows = parseInstanceList(transport.ctl("instance", "list"));
		const instances = {};
		for (const row of rows) {
			if (row.status !== "running") { instances[row.name] = { observation: "unavailable", reason: `instance ${row.status || "status unknown"}` }; continue; }
			try { instances[row.name] = normalizeObservation(transport.lua(row.name, snapshotLua(player))); }
			catch (error) { instances[row.name] = { observation: "unavailable", reason: `query failed: ${String(error?.message || error).split("\n")[0]}` }; }
		}
		return { cluster, player, takenAt: new Date().toISOString(), instances };
	});
}

function report(stream, error, code) {
	stream.write(`${String(error?.stderr || error?.message || error).trim()}\n`);
	return code;
}

const USAGE = `usage: node tools/surface-export/player-state.mjs --player <name> [--cluster dev|<name>] [--out snapshot.json]
       node tools/surface-export/player-state.mjs --diff <before.json> <after.json>
exit codes for --diff: 0 conserved, 1 changed, 3 evidence incomplete (no verdict)`;

export async function main(argv, { out = process.stdout, err = process.stderr, snapshot = takeSnapshot } = {}) {
	const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
	if (argv.includes("--diff")) {
		const [beforeFile, afterFile] = argv.slice(argv.indexOf("--diff") + 1);
		if (!beforeFile || !afterFile) { err.write(`${USAGE}\n`); return 2; }
		const result = diffSnapshots(JSON.parse(readFileSync(beforeFile, "utf8")), JSON.parse(readFileSync(afterFile, "utf8")));
		out.write(`${result.lines.join("\n")}\n`);
		if (!result.complete) return 3;
		return result.conserved ? 0 : 1;
	}
	const player = value("--player");
	if (!player) { err.write(`${USAGE}\n`); return 2; }
	try {
		const state = await snapshot(value("--cluster") || DEVELOPMENT, player);
		const json = JSON.stringify(state, null, 2);
		if (value("--out")) writeFileSync(value("--out"), `${json}\n`);
		for (const [instance, instanceState] of Object.entries(state.instances)) out.write(`${instance}: ${where(instanceState)}\n`);
		const { totals, unavailable, unreadable } = summarize(state);
		const gaps = [...unavailable, ...unreadable.map(instance => `no readable body on ${instance}`)];
		out.write(`observed possessions: ${Object.entries(totals).map(([item, count]) => `${item} ${count}`).join(", ") || "none"}${gaps.length ? ` (incomplete: ${gaps.join("; ")})` : ""}\n`);
		if (value("--out")) out.write(`saved ${value("--out")}\n`);
		return 0;
	} catch (error) {
		return report(err, error, 1);
	}
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
