#!/usr/bin/env node
// requires: a reachable cluster (dev, or a remote named in tools/clusterio/remote-clusters.local.json); a running instance whose surface_export plugin applied its planet policy, or --planet when no policy is applied; --yes for a run that destroys, or --dry-run; the same "instance send-rcon" that tools/clusterio/ctl.mjs gates behind --write
// produces: the chunks within --radius-chunks of 0,0 generated on that planet's surface in one blocking call (a dry run too, on a surface that already exists; it refuses to create one), the hostile (enemy-force military-target) entities and demolishers inside that radius destroyed on a --yes run, the area charted for the player force, and a JSON report with found, destroyed and remaining counts per entity kind, the free character position near 0,0 and the wall-clock of the generate step; on a Lua error mid-run the counts so far are printed before exit 1; exit 3 when hostiles remain or no position exists
// does not: prepare technology or starter inventories, touch other surfaces, remove a demolisher whose body lies outside the radius or its territory, stop enemy expansion or spawning from repopulating the area later, save the game, or authorize running it on a shared or production cluster
import url from "node:url";
import { DEVELOPMENT, withCluster } from "../shared/remote-cluster.mjs";

export const DEFAULT_RADIUS_CHUNKS = 6;
export const MAX_RADIUS_CHUNKS = 16;
export const MAX_COMMAND_BYTES = 3900;
export const EXIT_NOT_READY = 3;

const USAGE = `usage: node tools/surface-export/prepare-world.mjs --instance <name|id> (--dry-run | --yes) [--cluster dev|<name>] [--radius-chunks ${DEFAULT_RADIUS_CHUNKS}] [--planet <name>]

Generates the chunks within the radius around 0,0 on the instance's default planet (its applied planet
policy, or --planet when none is applied) in one blocking call that stalls the game while it runs, then
counts the hostile entities there, checks for a free character position within 64 tiles of 0,0 and prints
a JSON report. --yes also destroys the hostiles and charts the area; --dry-run destroys nothing and refuses
to create a missing surface. Exit 0 when nothing hostile remains and a position exists; ${EXIT_NOT_READY} when hostiles
remain (every dry run that finds some) or no position exists; 1 when the cluster or the game refuses; 2 for usage.`;

export function parseArgs(argv) {
	const options = { cluster: DEVELOPMENT, instance: null, radiusChunks: DEFAULT_RADIUS_CHUNKS, planet: null, dryRun: false, yes: false, help: false };
	const seen = new Set();
	const take = (name, index) => {
		const value = argv[index];
		if (value === undefined || value.startsWith("-")) throw new Error(`${name} needs a value`);
		return value;
	};
	for (let index = 0; index < argv.length; index++) {
		let [name, value] = argv[index].startsWith("--") && argv[index].includes("=") ? argv[index].split(/=(.*)/s) : [argv[index], undefined];
		if (name === "--help" || name === "-h") { options.help = true; continue; }
		if (name === "--dry-run") { options.dryRun = true; continue; }
		if (name === "--yes") { options.yes = true; continue; }
		if (!["--cluster", "--instance", "--radius-chunks", "--planet"].includes(name)) throw new Error(`unsupported argument: ${argv[index]}`);
		if (value === undefined) value = take(name, ++index);
		else if (value === "") throw new Error(`${name} needs a value`);
		if (seen.has(name)) throw new Error(`${name} was given more than once`);
		seen.add(name);
		if (name === "--cluster") options.cluster = value;
		else if (name === "--instance") options.instance = value;
		else if (name === "--planet") {
			if (!/^[a-z0-9_-]+$/i.test(value)) throw new Error(`--planet must be a planet prototype name, not ${JSON.stringify(value)}`);
			options.planet = value;
		} else {
			const radius = Number(value);
			if (!Number.isInteger(radius) || radius < 1 || radius > MAX_RADIUS_CHUNKS) {
				throw new Error(`--radius-chunks must be an integer from 1 to ${MAX_RADIUS_CHUNKS}, not ${JSON.stringify(value)}`);
			}
			options.radiusChunks = radius;
		}
	}
	if (options.help) return options;
	if (options.instance === null) throw new Error("--instance is required");
	if (!options.dryRun && !options.yes) throw new Error("a run that destroys needs --yes; add --dry-run to only count");
	return options;
}

export function rconCommand(body) {
	const text = `/sc ${body.replace(/\s*\n\s*/g, " ").trim()}`;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_COMMAND_BYTES) throw new Error(`RCON command is ${bytes} bytes; the limit is ${MAX_COMMAND_BYTES}`);
	return text;
}

function resolvePlanet(planet) {
	return `local policy = storage.surface_export_planet_policy
local wanted = ${planet === null ? "nil" : JSON.stringify(planet)}
local name = policy and policy.default_planet
if name and wanted and wanted ~= name then error("the applied planet policy names " .. name .. ", not " .. wanted) end
name = name or wanted
if not name then error("no planet policy is applied on this instance; pass --planet") end
local planet = game.planets[name]
if not planet then error("planet " .. name .. " is not installed") end`;
}

export function prepareCommand({ radiusChunks, planet = null, dryRun }) {
	return rconCommand(`local dry_run = ${dryRun ? "true" : "false"}
local ok, result = pcall(function()
${resolvePlanet(planet)}
local surface = planet.surface
if not surface then
if dry_run then error("planet " .. name .. " has no surface yet; a --yes run creates it") end
surface = planet.create_surface()
end
surface.request_to_generate_chunks({0, 0}, ${radiusChunks})
surface.force_generate_chunk_requests()
return {success = true, surface = surface.name, planet = name, policyApplied = policy ~= nil, radiusChunks = ${radiusChunks}, dryRun = dry_run}
end)
rcon.print(helpers.table_to_json(ok and result or {success = false, error = tostring(result)}))`);
}

export function scanCommand({ radiusChunks, planet = null, dryRun }) {
	return rconCommand(`local radius = ${radiusChunks * 32}
local dry_run = ${dryRun ? "true" : "false"}
local kinds = {}
local totals = {found = 0, destroyed = 0, remaining = 0}
local surface_name, planet_name, policy_applied
local function snapshot()
local rows = {}
for _, r in pairs(kinds) do rows[#rows + 1] = r end
table.sort(rows, function(a, b) return a.kind < b.kind end)
return {surface = surface_name, planet = planet_name, policyApplied = policy_applied, radiusChunks = ${radiusChunks}, radiusTiles = radius, dryRun = dry_run,
foundTotal = totals.found, destroyedTotal = totals.destroyed, remainingTotal = totals.remaining, kinds = rows}
end
local ok, result = pcall(function()
${resolvePlanet(planet)}
local surface = planet.surface
if not surface then error("planet " .. name .. " has no surface") end
surface_name, planet_name, policy_applied = surface.name, name, policy ~= nil
local area = {{-radius, -radius}, {radius, radius}}
local function inside(p) return p.x >= -radius and p.x <= radius and p.y >= -radius and p.y <= radius end
local function row(kind)
kinds[kind] = kinds[kind] or {kind = kind, found = 0, destroyed = 0, remaining = 0, names = {}}
return kinds[kind]
end
local function hit(r, field, label, destroy)
r[field] = r[field] + 1
totals[field] = totals[field] + 1
if field == "found" then r.names[label] = (r.names[label] or 0) + 1 end
if destroy and destroy() then
r.destroyed = r.destroyed + 1
totals.destroyed = totals.destroyed + 1
end
end
local function scan(field, destroy)
for _, e in pairs(surface.find_entities_filtered{area = area, force = "enemy", is_military_target = true}) do
if e.valid and e.type ~= "segment" and e.type ~= "segmented-unit" then
hit(row(e.type), field, e.name, destroy and function() return e.destroy() end)
end
end
for _, u in pairs(surface.get_segmented_units()) do
if u.valid and u.force.name == "enemy" then
for _, p in pairs(u.get_body_nodes()) do
if inside(p) then
hit(row("segmented-unit"), field, u.prototype.name, destroy and function() u.destroy() return not u.valid end)
break
end
end
end
end
end
scan("found", not dry_run)
scan("remaining", false)
local free = surface.find_non_colliding_position("character", {0, 0}, 64, 0.5)
if not dry_run then game.forces.player.chart(surface, area) end
local report = snapshot()
report.success = true
report.freePositionNear00 = free and {x = free.x, y = free.y} or false
report.charted = not dry_run
return report
end)
if ok then rcon.print(helpers.table_to_json(result)) else rcon.print(helpers.table_to_json({success = false, error = tostring(result), partial = snapshot()})) end`);
}

function jsonObject(line) {
	if (!line.startsWith("{")) return null;
	try {
		const value = JSON.parse(line);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		return null;
	}
}

export function parseReply(text) {
	const lines = String(text).split(/\r?\n/).map(part => part.trim()).filter(Boolean);
	for (let index = lines.length - 1; index >= 0; index--) {
		const reply = jsonObject(lines[index]);
		if (reply) return reply;
	}
	throw new Error(`the instance replied without JSON: ${lines.at(-1)?.slice(0, 500) || "(empty)"}`);
}

export class GameRefusal extends Error {
	constructor(reply) {
		super(`the game refused: ${reply.error ?? JSON.stringify(reply).slice(0, 500)}`);
		this.partial = reply.partial && typeof reply.partial === "object" && typeof reply.partial.surface === "string" ? reply.partial : null;
	}
}

export function normalizeReport(reply, { prepareMs } = {}) {
	const kinds = (Array.isArray(reply.kinds) ? reply.kinds : []).map(row => ({
		...row, names: row.names && !Array.isArray(row.names) ? row.names : {},
	}));
	const total = field => kinds.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
	const position = reply.freePositionNear00;
	return {
		surface: reply.surface, planet: reply.planet, policyApplied: reply.policyApplied === true,
		radiusChunks: reply.radiusChunks, radiusTiles: reply.radiusTiles, dryRun: reply.dryRun === true,
		prepareMs: Number.isFinite(prepareMs) ? prepareMs : null,
		found: Number.isSafeInteger(reply.foundTotal) ? reply.foundTotal : total("found"),
		destroyed: Number.isSafeInteger(reply.destroyedTotal) ? reply.destroyedTotal : total("destroyed"),
		remaining: Number.isSafeInteger(reply.remainingTotal) ? reply.remainingTotal : total("remaining"),
		kinds,
		freePositionNear00: position && typeof position === "object" && Number.isFinite(position.x) && Number.isFinite(position.y) ? { x: position.x, y: position.y } : null,
		charted: reply.charted === true,
		partial: reply.success !== true,
	};
}

export function verdict(report) {
	const reasons = [];
	if (report.remaining > 0) {
		reasons.push(`${report.remaining} hostile entit${report.remaining === 1 ? "y" : "ies"} remain inside ${report.radiusTiles} tiles of 0,0 on ${report.surface}`
			+ (report.dryRun ? " (dry run: nothing was destroyed)" : ""));
	}
	if (!report.freePositionNear00) reasons.push(`no free character position within 64 tiles of 0,0 on ${report.surface}`);
	return reasons;
}

function report(stream, context, error, code) {
	stream.write(`${context}${String(error?.stderr || error?.message || error).trim()}\n`);
	return code;
}

export async function main(argv, { out = process.stdout, err = process.stderr, run = withCluster, now = Date.now } = {}) {
	let options;
	try { options = parseArgs(argv); }
	catch (error) { return report(err, `${USAGE}\n\n`, error, 2); }
	if (options.help) { out.write(`${USAGE}\n`); return 0; }
	const { cluster, instance, radiusChunks, planet, dryRun } = options;
	let world;
	let prepareMs;
	try {
		world = await run(cluster, async transport => {
			const send = async body => {
				const reply = parseReply(await transport.ctl("instance", "send-rcon", instance, body));
				if (reply.success !== true) throw new GameRefusal(reply);
				return reply;
			};
			const started = now();
			const prepared = await send(prepareCommand({ radiusChunks, planet, dryRun }));
			prepareMs = now() - started;
			err.write(`${instance} on ${cluster}: surface ${prepared.surface} (planet ${prepared.planet}, ${prepared.policyApplied ? "applied planet policy" : "--planet"}) generated within ${radiusChunks} chunks of 0,0 in ${prepareMs} ms including the round trip\n`);
			return normalizeReport(await send(scanCommand({ radiusChunks, planet, dryRun })), { prepareMs });
		});
	} catch (error) {
		if (error instanceof GameRefusal && error.partial) out.write(`${JSON.stringify(normalizeReport(error.partial, { prepareMs }), null, 2)}\n`);
		return report(err, `${instance} on ${cluster}: `, error, 1);
	}
	out.write(`${JSON.stringify(world, null, 2)}\n`);
	const reasons = verdict(world);
	if (reasons.length === 0) return 0;
	err.write(`${reasons.map(reason => `NOT READY: ${reason}`).join("\n")}\n`);
	return EXIT_NOT_READY;
}

if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
	process.exitCode = await main(process.argv.slice(2));
}
